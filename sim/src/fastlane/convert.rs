// ============================================================================
// FAST LANE CONVERT (workstream B, compiled at integration): Opportunity ->
// the gun's CallInput (C) and the safety gates' SafetyInput (D).
//
// Plain English:
//   The scanner, the sender and the safety gates were built in parallel. B
//   owns the shared Opportunity; C and D each wrote down exactly the fields
//   they need. These two functions copy one into the others, field by
//   field, written against C's gun/gun.rs CallInput + gun/calldata.rs
//   (ExecutorHop, Funding) and D's safety.rs SafetyInput::new as they stand
//   on their branches (PRs #214 / #213). This file needs both modules, so it
//   is compiled only with the cargo feature `fastlane_integration`, which
//   the integration step turns on (or simply makes unconditional) once C's
//   and D's files are merged.
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
