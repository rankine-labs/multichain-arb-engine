// ============================================================================
// LIVE DRY RUN: `sniper live-dryrun <pool> [usd]` (read-only, no key needed)
//
// Plain English:
//   Before real money, this builds the EXACT transactions the live trader
//   would send for one pool (approvals, Permit2, router call, the same
//   minimum-out and deadline rules), from the REAL live wallet's address,
//   and runs them in the node's free simulation (eth_simulateV1, the same
//   call `sniper dry-fire` uses). Nothing is signed, nothing is sent. It
//   reports what the buy would get, what selling it all back would return,
//   the gas each step used against its limit, and the first step that
//   failed (if any).
//
//   Works for every venue the paper trader trades:
//     V3 pool address, V2 pair address (20 bytes), or V4 pool id (32 bytes;
//     its key is read from the paper trader's v4_pool_keys.json files).
//   It also runs for venues live mode currently refuses (e.g. V2 while it
//   is switched off), and says so ("live_allowed": false), so a venue can
//   be proven BEFORE it is switched on.
//
//   Wallet address: SNIPER_LIVE_ADDRESS, else the address of the key in
//   SNIPER_KEY_FILE (the key is read only to work out the address, then
//   wiped; it signs nothing).
//
//   If the wallet does not hold enough of the base coin yet, the simulation
//   lends it the amount first (WETH/USDG taken from the V4 PoolManager
//   inside the simulation; native ETH added to its simulated balance) and
//   the report says "funded_in_sim": true. The real wallet is unchanged.
//
//   Limits: a simulation is the chain as of one block; the real trade lands
//   later, after other traders. It proves the calldata, approvals, router
//   shape and amounts work; it does not promise the same price later.
// ============================================================================
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::fourmeme::hex;
use crate::live::{self, data_balance, data_transfer, Signer};
use crate::liveroute::{self, LiveTx};
use crate::livetrade::{self, base_amount, base_dec, fill_vs_quote_pct, received_from, uf, LiveCfg, SLIP_BPS};
use crate::paper::{self, ChainQuoter, Pool};
use crate::rhc::V4_POOL_MANAGER;
use crate::sellcheck::Rpc;
use crate::venue::{self, Venue, NATIVE_ETH};

/// Where simulated native-ETH transfers show up with traceTransfers on
/// (eth_simulateV1 spec: logs from this address, ERC-20 Transfer shape).
pub const SIM_NATIVE_LOG: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/// A step that used more than this share of its gas limit is flagged.
pub const GAS_WARN_SHARE: f64 = 0.8;

/// The live wallet's address for the dry run (never signs).
pub fn wallet_address(get: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    if let Some(a) = get("SNIPER_LIVE_ADDRESS").map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()) {
        live::addr_bytes(&a).map_err(|_| "SNIPER_LIVE_ADDRESS is not an address".to_string())?;
        return Ok(a);
    }
    let key = get("SNIPER_KEY_FILE").filter(|s| !s.trim().is_empty()).ok_or("set SNIPER_LIVE_ADDRESS (the live wallet's address) or SNIPER_KEY_FILE")?;
    let s = Signer::from_file(Path::new(key.trim()))?;
    Ok(s.address().to_string())
}

/// The V4 key files to search: SNIPER_V4_KEYS (comma list) if set, else
/// $SNIPER_OUT/v4_pool_keys.json, paper-out/v4_pool_keys.json and every
/// paper-out/<run>/v4_pool_keys.json.
pub fn key_files(get: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    if let Some(list) = get("SNIPER_V4_KEYS").filter(|s| !s.trim().is_empty()) {
        return list.split(',').map(|p| PathBuf::from(p.trim())).filter(|p| !p.as_os_str().is_empty()).collect();
    }
    let mut out = Vec::new();
    if let Some(o) = get("SNIPER_OUT").filter(|s| !s.trim().is_empty()) {
        out.push(PathBuf::from(o).join(venue::V4Keys::FILE));
    }
    let root = PathBuf::from("paper-out");
    out.push(root.join(venue::V4Keys::FILE));
    if let Ok(rd) = std::fs::read_dir(&root) {
        let mut runs: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path().join(venue::V4Keys::FILE)).filter(|p| p.exists()).collect();
        runs.sort();
        out.extend(runs);
    }
    out
}

/// Find a V4 pool's key by id in the key files.
pub fn find_v4_key(id: &str, files: &[PathBuf]) -> Option<venue::V4Key> {
    files.iter().filter_map(|f| venue::V4Keys::load(f).ok()).find_map(|k| k.get(id).cloned())
}

fn is_pool_id(p: &str) -> bool {
    let h = p.trim().trim_start_matches("0x");
    h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())
}

/// Look the pool up as paper would: V4 id via the key files, else a V3
/// pool, else a V2 pair.
pub fn resolve_pool(url: &str, pool: &str, files: &[PathBuf]) -> Result<Pool, String> {
    if is_pool_id(pool) {
        let key = find_v4_key(pool, files).ok_or_else(|| format!("V4 pool id not found in {} key file(s); point SNIPER_V4_KEYS at the paper run's v4_pool_keys.json", files.len()))?;
        return paper::v4_pool(&key).ok_or("V4 pool has no WETH/USDG/ETH side".into());
    }
    live::addr_bytes(pool)?;
    let agent = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(10))).build().new_agent();
    if let Some(p) = paper::pool_info(url, &agent, pool) {
        return Ok(p);
    }
    paper::v2_pool_info(url, &agent, pool).ok_or("not a Uniswap V3 pool or V2 pair with a WETH/USDG side (or the node did not answer)".into())
}

/// One simulated call from `from`.
pub fn sim_call(from: &str, t: &LiveTx) -> Value {
    let mut c = json!({"from": from, "to": t.to, "data": format!("0x{}", hex(&t.data)), "gas": format!("0x{:x}", t.gas)});
    if !t.value.is_zero() {
        c["value"] = json!(format!("0x{:x}", t.value));
    }
    c
}

fn read_call(from: &str, to: &str, data: Vec<u8>) -> Value {
    json!({"from": from, "to": to, "data": format!("0x{}", hex(&data))})
}

fn word_of(v: &Value) -> U256 {
    let h = v.as_str().unwrap_or("").trim_start_matches("0x");
    U256::from_str_radix(&h[..h.len().min(64)], 16).unwrap_or(U256::ZERO)
}

fn gas_of(c: &Value) -> u64 {
    c["gasUsed"].as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()).unwrap_or(0)
}

/// The first failed call among `calls` (index, name), as "name: why".
fn first_fail(calls: &[Value], names: &[String]) -> Option<String> {
    calls.iter().enumerate().find(|(_, c)| c["status"].as_str() != Some("0x1")).map(|(i, c)| {
        let why = c["error"]["message"].as_str().unwrap_or("reverted");
        format!("{}: {why}", names.get(i).map(String::as_str).unwrap_or("step"))
    })
}

/// Native ETH that reached `to` in one simulated call (traceTransfers logs).
pub fn native_in(call: &Value, to: &str) -> U256 {
    let mut sum = U256::ZERO;
    for l in call["logs"].as_array().into_iter().flatten() {
        let t = &l["topics"];
        if l["address"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(SIM_NATIVE_LOG))
            && t[0].as_str().is_some_and(|x| x.eq_ignore_ascii_case(venue::SIG_TRANSFER))
            && t[2].as_str().is_some_and(|x| x.len() >= 40 && x[x.len() - 40..].eq_ignore_ascii_case(to.trim_start_matches("0x")))
        {
            sum += word_of(&l["data"]);
        }
    }
    sum
}

/// Rows for the report: what each transaction is, its gas use vs limit.
fn tx_rows(txs: &[LiveTx], results: &[Value], warn: &mut Vec<String>) -> Value {
    Value::Array(
        txs.iter()
            .enumerate()
            .map(|(i, t)| {
                let used = results.get(i).map(gas_of).unwrap_or(0);
                if used as f64 > t.gas as f64 * GAS_WARN_SHARE {
                    warn.push(format!("{} used {used} of its {} gas limit", t.label, t.gas));
                }
                json!({"what": t.label, "to": t.to, "gas_limit": t.gas, "gas_used": used, "eth_sent": t.value.to_string()})
            })
            .collect(),
    )
}

/// `sniper live-dryrun`: returns the one-line JSON report.
pub fn live_dryrun(url: &str, pool: &str, usd: f64, get: &dyn Fn(&str) -> Option<String>) -> Result<Value, String> {
    let cfg = LiveCfg::from_lookup(get)?;
    let wallet = wallet_address(get)?;
    let p = resolve_pool(url, pool, &key_files(get))?;
    let rpc = Rpc::new(url);
    let q = ChainQuoter { rpc: Rpc::new(url) };
    let eth = paper::eth_usd(&q).ok_or("no ETH price (node or quoter unreachable)")?;
    let usd_per_base = if p.base == "USDG" { 1.0 } else { eth };
    let dec = base_dec(p.base);
    let base_in = base_amount(usd, usd_per_base, dec);
    if base_in.is_zero() {
        return Err("size rounds to zero".into());
    }
    let native = p.base_addr.eq_ignore_ascii_case(NATIVE_ETH);
    let refusal = liveroute::venue_refusal(&p.venue, p.base, &cfg.venues, &cfg.router);

    let bhex = rpc.call("eth_blockNumber", json!([]))?.as_str().ok_or("no block number")?.to_string();
    let block = u64::from_str_radix(bhex.trim_start_matches("0x"), 16).unwrap_or(0);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let deadline = now + livetrade::DEADLINE_SECS;

    // The buy, built exactly as live builds it.
    let (quote_tokens, _) = q.quote_at(&p.venue, &p.base_addr, &p.token, base_in, &bhex)?;
    let min_tokens = live::min_out(quote_tokens, SLIP_BPS);
    let buy = liveroute::trade_txs(&p.venue, &cfg.router, &wallet, &p.base_addr, p.base, &p.token, base_in, min_tokens, deadline, now)?;

    // Lend the base inside the simulation if the wallet is short.
    let reserve = U256::from((livetrade::MIN_ETH_RESERVE * 1e18) as u128);
    let eth_bal = word_of(&rpc.call("eth_getBalance", json!([wallet, &bhex]))?);
    let mut overrides = json!({});
    let mut prefix: Vec<Value> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut funded = false;
    if native {
        if eth_bal < base_in + reserve {
            overrides[&wallet] = json!({"balance": format!("0x{:x}", eth_bal + base_in + reserve * U256::from(20u64))});
            funded = true;
        }
    } else {
        let have = word_of(&rpc.call("eth_call", json!([{"to": p.base_addr, "data": format!("0x{}", hex(&data_balance(&wallet)?))}, &bhex]))?);
        if have < base_in {
            // Lender: a V3 pool itself (its swap maths only checks that what
            // it is owed arrives, like `sniper dry-fire`); for V4 and V2 the
            // V4 PoolManager (taking from a V2 pair would break its reserves).
            let lender = if matches!(p.venue, Venue::V3 { .. }) { pool.to_ascii_lowercase() } else { V4_POOL_MANAGER.to_string() };
            prefix.push(read_call(&lender, &p.base_addr, data_transfer(&wallet, base_in)?));
            names.push(format!("lend {} in simulation", p.base));
            funded = true;
        }
    }
    let buy_at = prefix.len();
    prefix.extend(buy.iter().map(|t| sim_call(&wallet, t)));
    names.extend(buy.iter().map(|t| format!("buy: {}", t.label)));

    let sim = |calls: Vec<Value>| -> Result<Vec<Value>, String> {
        let mut bsc = json!({"calls": calls});
        if overrides.as_object().is_some_and(|o| !o.is_empty()) {
            bsc["stateOverrides"] = overrides.clone();
        }
        let r = rpc.call("eth_simulateV1", json!([{"blockStateCalls": [bsc], "validation": false, "traceTransfers": true}, &bhex]))?;
        r[0]["calls"].as_array().cloned().ok_or("simulation: no calls (does this node support eth_simulateV1?)".into())
    };
    let mut warn: Vec<String> = Vec::new();
    let mut out = json!({
        "pool": pool, "venue": p.venue_name(), "token": p.token, "base": p.base, "wallet": wallet,
        "router": if matches!(p.venue, Venue::V3 { .. }) { live::SWAP_ROUTER_02.to_string() } else { cfg.router.address.clone() },
        "router_shape": if matches!(p.venue, Venue::V3 { .. }) { "SwapRouter02" } else { cfg.router.layout.name() },
        "block": block, "usd_in": usd, "base_in": base_in.to_string(), "funded_in_sim": funded,
        "live_allowed": refusal.is_none(), "live_refusal": refusal,
        "ok": false, "failed": Value::Null,
    });

    // Pass 1: buy, then read the tokens that arrived.
    let mut c1 = prefix.clone();
    c1.push(read_call(&wallet, &p.token, data_balance(&wallet)?));
    let mut n1 = names.clone();
    n1.push("read tokens".into());
    let r1 = sim(c1)?;
    let buy_rows = tx_rows(&buy, &r1[buy_at..], &mut warn);
    if let Some(f) = first_fail(&r1, &n1) {
        out["buy"] = json!({"txs": buy_rows, "quote_tokens": quote_tokens.to_string(), "min_tokens": min_tokens.to_string()});
        out["failed"] = json!(f);
        out["gas_warnings"] = json!(warn);
        return Ok(out);
    }
    let sim_tokens = word_of(&r1[r1.len() - 1]["returnData"]);
    out["buy"] = json!({"txs": buy_rows, "quote_tokens": quote_tokens.to_string(), "min_tokens": min_tokens.to_string(),
                        "sim_tokens": sim_tokens.to_string(), "tokens_vs_quote_pct": fill_vs_quote_pct(sim_tokens, quote_tokens)});

    // Pass 2: price the sell AFTER our buy (inside the simulation), the
    // same quote live asks for just before it sells.
    let in_sim = |to: &str, data: &str| -> Result<Option<String>, String> {
        let mut c = prefix.clone();
        c.push(json!({"from": wallet, "to": to, "data": data}));
        let r = sim(c)?;
        let last = r.last().ok_or("simulation: no answer")?;
        Ok(last["returnData"].as_str().map(str::to_string))
    };
    let quote_back = paper::quote_via(&in_sim, &p.venue, &p.token, &p.base_addr, sim_tokens).map(|(o, _)| o).unwrap_or(U256::ZERO);
    let min_back = live::min_out(quote_back, SLIP_BPS);

    // Pass 3: buy, then the real sell transactions, measuring what comes back.
    let sell = liveroute::trade_txs(&p.venue, &cfg.router, &wallet, &p.token, "token", &p.base_addr, sim_tokens, min_back, deadline, now)?;
    // Base balance reads around the sell. Native ETH has no balanceOf, so
    // there the reads are placeholders (the token's balance) that keep the
    // positions the same, and the ETH back is taken from the swap's
    // traceTransfers logs instead.
    let base_read = if native { &p.token } else { &p.base_addr };
    let mut c3 = prefix.clone();
    let mut n3 = names.clone();
    c3.push(read_call(&wallet, base_read, data_balance(&wallet)?));
    n3.push("read balance before sell".into());
    let sell_at = c3.len();
    c3.extend(sell.iter().map(|t| sim_call(&wallet, t)));
    n3.extend(sell.iter().map(|t| format!("sell: {}", t.label)));
    c3.push(read_call(&wallet, base_read, data_balance(&wallet)?));
    n3.push("read balance after sell".into());
    let r3 = sim(c3)?;
    let sell_rows = tx_rows(&sell, &r3[sell_at..], &mut warn);
    out["sell"] = json!({"txs": sell_rows, "quote_base": quote_back.to_string(), "min_base": min_back.to_string()});
    if let Some(f) = first_fail(&r3, &n3) {
        out["failed"] = json!(f);
        out["gas_warnings"] = json!(warn);
        return Ok(out);
    }
    let back = if native {
        // The swap pays native ETH to the wallet (traceTransfers shows it).
        native_in(&r3[r3.len() - 2], &wallet)
    } else {
        received_from(word_of(&r3[sell_at - 1]["returnData"]), word_of(&r3[r3.len() - 1]["returnData"]), false, U256::ZERO)
    };
    let to_usd = |x: U256| uf(x) / 10f64.powi(dec) * usd_per_base;
    let gas_total: u64 = buy.iter().enumerate().map(|(i, _)| gas_of(&r1[buy_at + i])).sum::<u64>() + sell.iter().enumerate().map(|(i, _)| gas_of(&r3[sell_at + i])).sum::<u64>();
    out["sell"]["sim_base_back"] = json!(back.to_string());
    out["sell"]["base_vs_quote_pct"] = json!(fill_vs_quote_pct(back, quote_back));
    out["usd_back"] = json!(to_usd(back));
    out["round_trip_usd_before_gas"] = json!(to_usd(back) - to_usd(base_in));
    out["gas_used_total"] = json!(gas_total);
    out["gas_warnings"] = json!(warn);
    if native && back.is_zero() {
        out["failed"] = json!("sell returned no native ETH in the simulation (node may not support traceTransfers)");
        return Ok(out);
    }
    out["ok"] = json!(true);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_from_address_or_key_file() {
        let a = wallet_address(&|k| (k == "SNIPER_LIVE_ADDRESS").then(|| " 0x7E5F4552091A69125D5DFCB7B8C2659029395BDF ".into())).unwrap();
        assert_eq!(a, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
        assert!(wallet_address(&|k| (k == "SNIPER_LIVE_ADDRESS").then(|| "0x12".into())).is_err());
        assert!(wallet_address(&|_| None).unwrap_err().contains("SNIPER_LIVE_ADDRESS"));
    }

    #[test]
    fn key_file_list() {
        let l = key_files(&|k| (k == "SNIPER_V4_KEYS").then(|| "a.json, b.json,".into()));
        assert_eq!(l, vec![PathBuf::from("a.json"), PathBuf::from("b.json")]);
        let l = key_files(&|k| (k == "SNIPER_OUT").then(|| "paper-out/run9".into()));
        assert_eq!(l[0], PathBuf::from("paper-out/run9").join(venue::V4Keys::FILE));
    }

    #[test]
    fn native_transfers_are_summed_for_the_wallet_only() {
        let me = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
        let t = |to: &str, amt: u64| json!({"address": SIM_NATIVE_LOG, "topics": [venue::SIG_TRANSFER, format!("0x{:0>64}", "ab"), format!("0x{:0>64}", to.trim_start_matches("0x"))], "data": format!("0x{amt:064x}")});
        let call = json!({"logs": [t(me, 5), t("0x1111111111111111111111111111111111111111", 7), t(me, 3),
                                   {"address": "0x2222222222222222222222222222222222222222", "topics": [venue::SIG_TRANSFER, "0x0", format!("0x{:0>64}", me.trim_start_matches("0x"))], "data": format!("0x{:064x}", 100)}]});
        assert_eq!(native_in(&call, me), U256::from(8u64));
        assert_eq!(native_in(&json!({}), me), U256::ZERO);
    }

    #[test]
    fn gas_rows_warn_near_the_limit() {
        let t = LiveTx { label: "swap".into(), to: "0x1".into(), data: vec![], gas: 100, value: U256::from(3u64) };
        let mut w = vec![];
        let rows = tx_rows(&[t.clone(), t], &[json!({"gasUsed": "0x50"}), json!({"gasUsed": "0x10"})], &mut w);
        assert_eq!(rows[0]["gas_used"], 80);
        assert_eq!(rows[1]["eth_sent"], "3");
        assert!(w.is_empty(), "80% is the line, not over it");
        let mut w = vec![];
        tx_rows(&[LiveTx { label: "swap".into(), to: "0x1".into(), data: vec![], gas: 100, value: U256::ZERO }], &[json!({"gasUsed": "0x51"})], &mut w);
        assert_eq!(w.len(), 1);
    }
}
