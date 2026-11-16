// ============================================================================
// SAFETY CHECKS (measure only): the standard token-safety checklist
//
// Plain English:
//   Token-safety scanners (GoPlus and the like) don't cover Robinhood Chain,
//   so we run the same kinds of checks ourselves, straight from the chain:
//     1. Contract code scan: does the token's code contain functions that
//        let someone mint new coins, pause trading, blacklist wallets,
//        change the tax, or cap trade sizes? (We look for the function ids
//        in the contract's dispatcher, so it costs one request.)
//     2. Owner: does owner() still return a real wallet (not renounced)?
//     3. Proxy: can the code be swapped (EIP-1967 implementation slot set)?
//     4. Liquidity lock (Uniswap V3 pools): who holds the pool's first
//        liquidity position? A plain wallet can pull it any time (the rug
//        we keep seeing); a burned position or a lock contract can't.
//     5. Creator wallet age: how many transactions the pool creator's
//        wallet had sent (throwaway wallets have very few).
//   Nothing here blocks a trade yet. Each trade logs these flags and a
//   later scoring run (like deploy/rug-rules.py) decides which ones
//   actually separate rugs from good coins before we turn any on.
// ============================================================================
use serde_json::{json, Value};

use crate::fourmeme::{hex, keccak};
use crate::sellcheck::Rpc;

/// Function signatures by risk group. A contract "has" a group when the
/// 4-byte id of any of its signatures appears as a PUSH4 in the code.
pub const GROUPS: &[(&str, &[&str])] = &[
    ("mint", &["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "mint(address)"]),
    (
        "pause",
        &["pause()", "unpause()", "setPaused(bool)", "setTradingEnabled(bool)", "openTrading()", "enableTrading()", "setTrading(bool)"],
    ),
    (
        "blacklist",
        &[
            "blacklist(address)",
            "addToBlacklist(address)",
            "setBlacklist(address,bool)",
            "blacklistAddress(address,bool)",
            "setBot(address,bool)",
            "addBots(address[])",
            "setBots(address[],bool)",
            "setBlacklisted(address,bool)",
        ],
    ),
    (
        "tax_setter",
        &[
            "setFee(uint256)",
            "setFees(uint256,uint256)",
            "setTax(uint256)",
            "setTaxes(uint256,uint256)",
            "setBuyTax(uint256)",
            "setSellTax(uint256)",
            "setBuyFee(uint256)",
            "setSellFee(uint256)",
            "updateFees(uint256,uint256)",
            "setTaxFeePercent(uint256)",
        ],
    ),
    ("tx_limits", &["setMaxTxAmount(uint256)", "setMaxWalletSize(uint256)", "setMaxWallet(uint256)", "removeLimits()"]),
];

/// EIP-1967 implementation slot.
pub const EIP1967_IMPL: &str = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/// keccak("IncreaseLiquidity(uint256,uint128,uint256,uint256)") from a
/// position manager (V3 NonfungiblePositionManager).
pub fn sig_increase_liquidity() -> String {
    format!("0x{}", hex(&keccak(b"IncreaseLiquidity(uint256,uint128,uint256,uint256)")))
}
/// keccak("Mint(address,address,int24,int24,uint128,uint256,uint256)"): V3 pool.
pub fn sig_v3_mint() -> String {
    format!("0x{}", hex(&keccak(b"Mint(address,address,int24,int24,uint128,uint256,uint256)")))
}

fn sel(sig: &str) -> String {
    hex(&keccak(sig.as_bytes())[..4])
}

/// Which risk groups the contract code contains (pure: code as hex).
pub fn scan_code(code_hex: &str) -> Vec<&'static str> {
    let code = code_hex.trim_start_matches("0x").to_ascii_lowercase();
    GROUPS
        .iter()
        .filter(|(_, sigs)| sigs.iter().any(|s| code.contains(&format!("63{}", sel(s)))))
        .map(|(g, _)| *g)
        .collect()
}

/// A 32-byte word as an address ("0x" + last 20 bytes), lowercase.
fn word_addr(w: &str) -> Option<String> {
    let h = w.trim_start_matches("0x");
    (h.len() >= 40).then(|| format!("0x{}", h[h.len() - 40..].to_ascii_lowercase()))
}

fn is_burn(a: &str) -> bool {
    let a = a.to_ascii_lowercase();
    a == "0x0000000000000000000000000000000000000000" || a == "0x000000000000000000000000000000000000dead"
}

/// Classify a wallet: "burned", "contract" (a lock or another contract) or
/// "wallet" (a plain address that can do anything with what it holds).
fn kind_of(rpc: &Rpc, a: &str) -> &'static str {
    if is_burn(a) {
        return "burned";
    }
    match rpc.call("eth_getCode", json!([a, "latest"])) {
        Ok(Value::String(c)) if c.len() > 2 => "contract",
        Ok(_) => "wallet",
        Err(_) => "unknown",
    }
}

/// Who holds the first liquidity position of a Uniswap V3 pool created at
/// `born_block`: "burned" / "contract" / "wallet" / "unknown", and whether
/// that holder is the pool creator. About 4 requests.
pub fn v3_lp_holder(rpc: &Rpc, pool: &str, born_block: u64, creator: Option<&str>) -> (String, Option<bool>) {
    let logs = rpc.call(
        "eth_getLogs",
        json!([{"address": pool, "topics": [sig_v3_mint()], "fromBlock": format!("0x{born_block:x}"), "toBlock": format!("0x{:x}", born_block + 2000)}]),
    );
    let Some(first) = logs.ok().and_then(|v| v.as_array().and_then(|a| a.first().cloned())) else { return ("unknown".into(), None) };
    // Mint's indexed owner: the position manager (NFT positions) or a direct minter.
    let Some(owner) = first["topics"].get(1).and_then(Value::as_str).and_then(word_addr) else { return ("unknown".into(), None) };
    let tx = first["transactionHash"].as_str().unwrap_or("").to_string();
    // If a position manager minted it, find the NFT and ask who owns it now.
    let holder = rpc
        .call("eth_getTransactionReceipt", json!([tx]))
        .ok()
        .and_then(|r| {
            r["logs"].as_array()?.iter().find_map(|l| {
                let from_owner = l["address"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(&owner));
                let is_inc = l["topics"].get(0).and_then(Value::as_str).is_some_and(|t| t.eq_ignore_ascii_case(&sig_increase_liquidity()));
                if from_owner && is_inc {
                    l["topics"].get(1).and_then(Value::as_str).map(String::from)
                } else {
                    None
                }
            })
        })
        .and_then(|token_id| {
            let data = format!("0x6352211e{}", token_id.trim_start_matches("0x"));
            rpc.call("eth_call", json!([{"to": owner, "data": data}, "latest"])).ok().and_then(|v| v.as_str().and_then(word_addr))
        })
        .unwrap_or(owner);
    let same = creator.map(|c| c.eq_ignore_ascii_case(&holder));
    (kind_of(rpc, &holder).to_string(), same)
}

/// All checks for one token (and its pool when we saw it created).
/// Returns a JSON object of flags; errors become nulls, never a block.
pub fn measure(rpc: &Rpc, token: &str, pool: &str, born_block: Option<u64>, creator: Option<&str>, venue_is_v3: bool) -> Value {
    let code = rpc.call("eth_getCode", json!([token, "latest"])).ok().and_then(|v| v.as_str().map(String::from));
    let groups = code.as_deref().map(scan_code);
    let owner = rpc
        .call("eth_call", json!([{"to": token, "data": "0x8da5cb5b"}, "latest"]))
        .ok()
        .and_then(|v| v.as_str().filter(|s| s.len() >= 66).and_then(word_addr));
    let proxy = rpc
        .call("eth_getStorageAt", json!([token, EIP1967_IMPL, "latest"]))
        .ok()
        .and_then(|v| v.as_str().map(|s| s.trim_start_matches("0x").chars().any(|c| c != '0')));
    let (lp, lp_is_creator) = match (born_block, venue_is_v3) {
        (Some(b), true) => {
            let (k, same) = v3_lp_holder(rpc, pool, b, creator);
            (Some(k), same)
        }
        _ => (None, None),
    };
    let creator_txs = creator.and_then(|c| rpc.call("eth_getTransactionCount", json!([c, "latest"])).ok()).and_then(|v| {
        v.as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
    });
    json!({
        "code_flags": groups,
        "owner": owner,
        "owner_renounced": owner.as_deref().map(is_burn),
        "proxy": proxy,
        "lp_holder": lp,
        "lp_holder_is_creator": lp_is_creator,
        "creator_txs": creator_txs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_function_ids() {
        assert_eq!(sel("mint(address,uint256)"), "40c10f19");
        assert_eq!(sel("pause()"), "8456cb59");
        assert_eq!(sel("owner()"), "8da5cb5b");
        assert_eq!(sel("ownerOf(uint256)"), "6352211e");
    }

    #[test]
    fn code_scan_finds_push4_ids_only() {
        // dispatcher: PUSH4 mint, PUSH4 pause; a stray "40c10f19" not after 0x63 doesn't count twice
        let code = format!("0x6080{}{}5b", "6340c10f19", "638456cb59");
        assert_eq!(scan_code(&code), vec!["mint", "pause"]);
        assert!(scan_code("0x608060405200").is_empty());
    }

    #[test]
    fn burn_addresses() {
        assert!(is_burn("0x0000000000000000000000000000000000000000"));
        assert!(is_burn("0x000000000000000000000000000000000000dEaD"));
        assert!(!is_burn("0x1111111111111111111111111111111111111111"));
        assert_eq!(word_addr(&format!("0x{:0>64}", "abc")).unwrap(), "0x0000000000000000000000000000000000000abc");
    }

    #[test]
    fn event_ids() {
        assert_eq!(sig_v3_mint(), "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde");
        assert_eq!(sig_increase_liquidity(), "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f");
    }
}
