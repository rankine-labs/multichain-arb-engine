// ============================================================================
// FAST LANE CONVERT (workstream B): Opportunity ->
// the gun's CallInput (C) and the safety gates' SafetyInput (D).
//
// Plain English:
//   The scanner, the sender and the safety gates were built in parallel. B
//   owns the shared Opportunity; C and D each wrote down exactly the fields
//   they need. These two functions copy one into the others, field by
//   field, written against C's gun/gun.rs CallInput + gun/calldata.rs
//   (ExecutorHop, Funding) and D's safety.rs SafetyInput::new as they stand
//   on their branches (PRs #214 / #213). (It used to sit behind a cargo
//   feature until those were merged; it is now always compiled.)
//   Addresses for D are lowercase 0x text (D lowercases what it compares).
// ============================================================================
use super::gun::calldata::{ExecutorHop, Funding};
use super::gun::CallInput;
use super::safety::SafetyInput;
use super::types::{FlashLender, Opportunity};

/// For the gun: exactly the facts executorCalldata.ts needs, plus timing.
pub fn to_call_input(o: &Opportunity) -> CallInput {
    CallInput {
        block: o.block,
        route_label: o.route_label.clone(),
        token_in: o.token_in,
        amount_in: o.amount_in,
        hops: o
            .hops
            .iter()
            .map(|h| ExecutorHop {
                kind: h.kind as i64,
                pool: h.pool,
                token_in: h.token_in,
                token_out: h.token_out,
                fee_bps: h.fee_bps as i64,
                v4_fee: h.v4_fee as i64,
                v4_tick_spacing: h.v4_tick_spacing as i64,
                v4_native: h.v4_native,
                // Simulator-only field, never sent to the contract.
                v4_pool_manager: None,
            })
            .collect(),
        funding: match o.flash {
            FlashLender::Own => Funding::Own,
            FlashLender::Aave(a) => Funding::Aave(a),
            FlashLender::V3Flash(a) => Funding::V3Flash(a),
        },
        net_usd: o.expected_net_usd,
        usd_per_token_in: o.usd_per_token_in,
        token_in_decimals: o.token_in_decimals,
        size_usd: o.size_usd,
        gas_usd: o.gas_usd,
        found_at: o.found_at,
    }
}

/// For the safety gates. Err when the size does not fit D's u128 (never
/// happens for a real trade; such an opportunity is not sent).
pub fn to_safety_input(o: &Opportunity) -> Result<SafetyInput, String> {
    let lc = |a: &revm::primitives::Address| format!("{a:#x}");
    let amount_in = u128::try_from(o.amount_in).map_err(|_| "amount too big for the safety gate".to_string())?;
    Ok(SafetyInput::new(
        o.block,
        o.route_label.clone(),
        lc(&o.token_in),
        o.tokens.iter().map(lc).collect(),
        o.pools.clone(),
        amount_in,
        o.size_usd,
        o.expected_net_usd,
        o.gas_usd,
        o.flash.lender().map(|a| lc(&a)),
        o.found_at,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fastlane::types::{Hop, ViewKind, KIND_V2, KIND_V4};
    use revm::primitives::{Address, U256};
    use std::time::Instant;

    fn opp() -> Opportunity {
        let a = Address::with_last_byte;
        let check = crate::fastlane::scan::PreparedCheck {
            call: Default::default(),
            overrides: Default::default(),
            amount_offset: 96,
            amount_slots: vec![],
            main_amount: U256::from(5u8),
            sizes: vec![U256::from(5u8)],
            trade: crate::fastlane::types::DecodedTrade { token: a(1), amount_in: U256::from(5u8), min_profit: U256::MAX, max_block: U256::MAX, hops: vec![], flash: FlashLender::Own },
        };
        Opportunity {
            block: 9, view: ViewKind::Confirmed, route_label: "X/Y a>b".into(), rid: "a>b:1".into(),
            token_in: a(1), token_in_decimals: 6, usd_per_token_in: 1.0, amount_in: U256::from(400_000_000u64), size_usd: 400.0,
            hops: vec![
                Hop { kind: KIND_V4, pool: a(0xa), token_in: a(1), token_out: a(2), fee_bps: 0, v4_fee: 3000, v4_tick_spacing: -60, v4_native: true },
                Hop { kind: KIND_V2, pool: a(0xb), token_in: a(2), token_out: a(1), fee_bps: 30, v4_fee: 0, v4_tick_spacing: 0, v4_native: false },
            ],
            flash: FlashLender::V3Flash(a(0xe)), profit_units: U256::from(3u8), expected_net_usd: 1.5, gas_usd: 0.05, gas_used: 300_000,
            loan_fee_usd: Some(0.2), pools: vec!["0xaa".into(), "0xbb".into()], keys: vec![], tokens: vec![a(1), a(2)],
            found_at: Instant::now(), scan_us: 7, source: "changed", check: std::sync::Arc::new(check),
        }
    }

    #[test]
    fn call_input_and_safety_input_carry_every_field() {
        let o = opp();
        let c = to_call_input(&o);
        assert_eq!((c.block, c.token_in, c.amount_in, c.net_usd, c.size_usd, c.gas_usd, c.token_in_decimals), (9, o.token_in, o.amount_in, 1.5, 400.0, 0.05, 6));
        assert_eq!(c.funding, Funding::V3Flash(Address::with_last_byte(0xe)));
        assert_eq!(c.hops.len(), 2);
        assert_eq!((c.hops[0].kind, c.hops[0].v4_fee, c.hops[0].v4_tick_spacing, c.hops[0].v4_native), (3, 3000, -60, true));
        assert_eq!((c.hops[1].kind, c.hops[1].fee_bps), (0, 30));
        assert_eq!(c.lender(), Some(Address::with_last_byte(0xe)));
        let s = to_safety_input(&o).unwrap();
        assert_eq!(s.amount_in, 400_000_000);
        assert_eq!(s.pools, vec!["0xaa", "0xbb"]);
        assert_eq!(s.token_in, format!("{:#x}", Address::with_last_byte(1)));
        assert_eq!(s.tokens.len(), 2);
        assert_eq!(s.lender, Some(format!("{:#x}", Address::with_last_byte(0xe))));
        assert_eq!((s.expected_net_usd, s.gas_usd, s.size_usd, s.block), (1.5, 0.05, 400.0, 9));
    }
}
