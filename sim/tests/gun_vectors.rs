// ============================================================================
// GUN VECTORS: the Rust sender builds EXACTLY what the Node bot builds.
//
// Plain English:
//   sim/tests/vectors/gen-calldata-vectors.ts ran the bot's real TypeScript
//   (src/execution/executorCalldata.ts, and ethers' Wallet.signTransaction
//   that src/execution/fastSender.ts signs with) on thousands of inputs and
//   saved the answers. Here the Rust port (sim/src/fastlane/gun/) gets the
//   same inputs and must give:
//     - identical calldata bytes for every build the TS accepted,
//     - the identical refusal text for every build the TS refused,
//     - an error wherever the TS threw (value out of ABI range),
//     - identical token amounts from the USD -> units rounding,
//     - the identical flash lender choice,
//     - byte-identical signed transactions and hashes.
//   Any single mismatch fails the test, with the case name.
// ============================================================================
use arbsim::check::hexutil::{parse_address, parse_bytes, to_hex};
use arbsim::fastlane::gun::calldata::*;
use arbsim::fastlane::gun::tx::{Signer, TxFields};
use revm::primitives::{Address, Bytes, U256};
use serde_json::Value;

fn load(name: &str) -> Value {
    let p = format!("{}/tests/vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&p).expect("vector file")).expect("vector json")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}
fn addr(v: &Value) -> Address {
    parse_address(s(v)).expect("address")
}
fn opt_addr(v: &Value) -> Option<Address> {
    if v.is_null() {
        None
    } else {
        Some(addr(v))
    }
}
fn f64_bits(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(s(v).trim_start_matches("0x"), 16).unwrap())
}
/// Decimal text -> U256, None if it doesn't fit.
fn dec_u256(v: &str) -> Option<U256> {
    U256::from_str_radix(v, 10).ok()
}

fn pool(v: &Value) -> PoolInfo {
    let v4 = if v["v4"].is_null() {
        None
    } else {
        let w = &v["v4"];
        Some(V4Info {
            fee: w["fee"].as_i64().unwrap(),
            tick_spacing: w["tickSpacing"].as_i64().unwrap(),
            native: w["native"].as_bool().unwrap(),
            pool_manager: addr(&w["poolManager"]),
            hooks: opt_addr(&w["hooks"]),
        })
    };
    PoolInfo {
        dex: s(&v["dex"]).to_string(),
        pool_address: parse_bytes(s(&v["poolAddress"])).unwrap(),
        pool_type: PoolType::parse(s(&v["poolType"])).unwrap(),
        token_a: addr(&v["tokenA"]),
        token_b: addr(&v["tokenB"]),
        fee_bps: v["feeBps"].as_i64().unwrap(),
        algebra: v["variant"].as_str() == Some("algebra"),
        liquidity: v["liquidity"].as_str().map(|x| dec_u256(x).unwrap()),
        v4,
    }
}

fn hop(v: &Value) -> ExecutorHop {
    ExecutorHop {
        kind: v["kind"].as_i64().unwrap(),
        pool: addr(&v["pool"]),
        token_in: addr(&v["tokenIn"]),
        token_out: addr(&v["tokenOut"]),
        fee_bps: v["feeBps"].as_i64().unwrap(),
        v4_fee: v["v4Fee"].as_i64().unwrap(),
        v4_tick_spacing: v["v4TickSpacing"].as_i64().unwrap(),
        v4_native: v["v4Native"].as_bool().unwrap(),
        v4_pool_manager: opt_addr(&v["v4PoolManager"]),
    }
}

#[test]
fn build_execute_call_matches_typescript() {
    let j = load("calldata.json");
    let cases = j["build"].as_array().unwrap();
    assert!(cases.len() > 400);
    let (mut ok, mut refused, mut threw) = (0, 0, 0);
    for c in cases {
        let name = s(&c["name"]);
        let i = &c["input"];
        let max_block = dec_u256(s(&i["maxBlock"]));
        let e = &c["expect"];
        // maxBlock over uint256: the TS encoder throws; U256 can't hold it.
        let Some(max_block) = max_block else {
            assert!(e.get("throws").is_some(), "{name}: oversize maxBlock should throw");
            threw += 1;
            continue;
        };
        let input = BuildInput {
            token_in: addr(&i["tokenIn"]),
            buy_pool: pool(&i["buyPool"]),
            sell_pool: pool(&i["sellPool"]),
            trade_size_usd: f64_bits(&i["tradeSizeUsdBits"]),
            net_profit_usd: f64_bits(&i["netProfitUsdBits"]),
            usd_per_token_in: f64_bits(&i["usdPerTokenInBits"]),
            token_in_decimals: i["tokenInDecimals"].as_u64().map(|d| d as u32),
            max_block,
            executor_address: opt_addr(&i["executorAddress"]),
            flash_pool: opt_addr(&i["flashPool"]),
            v3_lender: opt_addr(&i["v3Lender"]),
        };
        let got = build_execute_call(&input);
        if e.get("throws").is_some() {
            assert!(matches!(got, Err(CallErr::Invalid(_))), "{name}: TS threw ({}), Rust gave {got:?}", e["throws"]);
            threw += 1;
        } else if e["ok"] == Value::Bool(false) {
            assert_eq!(got, Err(CallErr::Refused(s(&e["reason"]).to_string())), "{name}");
            refused += 1;
        } else {
            let b = got.unwrap_or_else(|err| panic!("{name}: TS built it, Rust refused: {err:?}"));
            assert_eq!(to_hex(&b.data), s(&e["data"]).to_lowercase(), "{name}: calldata differs");
            assert_eq!(b.amount_in.to_string(), s(&e["amountIn"]), "{name}: amountIn");
            assert_eq!(b.min_profit.to_string(), s(&e["minProfit"]), "{name}: minProfit");
            assert_eq!(b.funding.name(), s(&e["funding"]), "{name}: funding");
            assert_eq!(b.funding.lender(), addr(&e["flashPool"]), "{name}: lender");
            assert_eq!(b.to, opt_addr(&e["to"]), "{name}: to");
            let hops: Vec<ExecutorHop> = e["hops"].as_array().unwrap().iter().map(hop).collect();
            assert_eq!(b.hops, hops, "{name}: hops");
            ok += 1;
        }
    }
    eprintln!("build cases: {ok} identical calldata, {refused} identical refusals, {threw} invalid in both");
    assert!(ok > 300 && refused > 40 && threw >= 2);
}

#[test]
fn raw_encoders_match_typescript() {
    let j = load("calldata.json");
    let (mut ok, mut threw) = (0, 0);
    for c in j["raw"].as_array().unwrap() {
        let name = s(&c["name"]);
        let t = &c["trade"];
        let e = &c["expect"];
        let amounts = [dec_u256(s(&t["amountIn"])), dec_u256(s(&t["minProfit"])), dec_u256(s(&t["maxBlock"]))];
        let got = if amounts.iter().any(|a| a.is_none()) {
            Err(CallErr::Invalid("over uint256".into()))
        } else {
            let trade = Trade {
                token: addr(&t["token"]),
                amount_in: amounts[0].unwrap(),
                min_profit: amounts[1].unwrap(),
                max_block: amounts[2].unwrap(),
                hops: t["hops"].as_array().unwrap().iter().map(hop).collect(),
            };
            if let Some(l) = opt_addr(&c["lender"]) {
                encode_execute_v3_flash_raw(&trade, l)
            } else {
                encode_execute_raw(&trade, opt_addr(&c["flashPool"]).unwrap_or(Address::ZERO))
            }
        };
        if e.get("throws").is_some() {
            assert!(got.is_err(), "{name}: TS threw, Rust encoded");
            threw += 1;
        } else {
            assert_eq!(to_hex(&got.unwrap_or_else(|x| panic!("{name}: {x:?}"))), s(&e["data"]).to_lowercase(), "{name}");
            ok += 1;
        }
    }
    eprintln!("raw encodes: {ok} identical, {threw} invalid in both");
    assert!(ok >= 200 && threw >= 6);
}

#[test]
fn usd_to_token_units_matches_typescript() {
    let j = load("calldata.json");
    let units = j["units"].as_array().unwrap();
    let max = U256::MAX;
    for (k, u) in units.iter().enumerate() {
        let a = u.as_array().unwrap();
        let (usd, price, dec, want) = (f64_bits(&a[0]), f64_bits(&a[1]), a[2].as_u64().unwrap() as u32, s(&a[3]));
        let got = usd_to_token_units(usd, price, dec);
        match got {
            Units::Exact(v) => assert_eq!(v.to_string(), want, "unit case {k}: usd {usd:e} price {price:e} dec {dec}"),
            Units::Throws => assert_eq!(want, "throws", "unit case {k}"),
            Units::TooBig => {
                // The TS bigint is bigger than uint256 (its encoder would throw).
                assert!(want != "throws" && dec_u256(want).is_none() && want.len() >= max.to_string().len(), "unit case {k}: {want}");
            }
        }
    }
    eprintln!("unit cases: {} identical", units.len());
    assert!(units.len() > 5000);
}

#[test]
fn lender_pick_matches_typescript() {
    let j = load("calldata.json");
    for c in j["lenders"].as_array().unwrap() {
        let name = s(&c["name"]);
        let pools: Vec<PoolInfo> = c["pools"].as_array().unwrap().iter().map(pool).collect();
        let token = addr(&c["token"]);
        let exclude: Vec<Bytes> = c["exclude"].as_array().unwrap().iter().map(|x| parse_bytes(s(x)).unwrap()).collect();
        let denied: Option<Vec<Bytes>> = c["denied"].as_array().map(|d| d.iter().map(|x| parse_bytes(s(x)).unwrap()).collect());
        let can = |p: &PoolInfo, _t: Address| !denied.as_ref().unwrap().iter().any(|d| d[..] == p.pool_address[..]);
        let got = pick_v3_lender(&pools, token, &exclude, if denied.is_some() { Some(&can) } else { None });
        let want = c["expect"].as_str().map(|x| parse_bytes(x).unwrap());
        assert_eq!(got.map(|p| p.pool_address.clone()), want, "{name}");
    }
}

#[test]
fn signed_transactions_match_ethers() {
    let j = load("tx.json");
    let txs = j["txs"].as_array().unwrap();
    for t in txs {
        let name = s(&t["name"]);
        let signer = Signer::from_hex(s(&t["key"])).unwrap();
        assert_eq!(signer.address(), addr(&t["from"]), "{name}: address");
        let f = TxFields {
            chain_id: t["chainId"].as_u64().unwrap(),
            nonce: t["nonce"].as_u64().unwrap(),
            max_priority_fee_per_gas: s(&t["maxPriorityFeePerGas"]).parse().unwrap(),
            max_fee_per_gas: s(&t["maxFeePerGas"]).parse().unwrap(),
            gas_limit: s(&t["gasLimit"]).parse().unwrap(),
            to: addr(&t["to"]),
            value: U256::ZERO,
            data: parse_bytes(s(&t["data"])).unwrap().to_vec(),
        };
        let st = signer.sign_tx(&f);
        assert_eq!(to_hex(&st.raw), s(&t["raw"]), "{name}: raw tx differs from ethers");
        assert_eq!(format!("{:#x}", st.hash), s(&t["hash"]), "{name}: hash");
        // And our own decoder recovers the same sender.
        let d = arbsim::feed::tx::decode(&st.raw).unwrap();
        assert_eq!(d.from, signer.address(), "{name}: recovered sender");
    }
    eprintln!("signed txs: {} byte-identical with ethers", txs.len());
    assert!(txs.len() >= 100);
}
