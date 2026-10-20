// ============================================================================
// FIXTURES: saved test cases (one call + everything it touches + the answer
// a real node gave). Format: /home/claude/inbot-bench/FIXTURE_FORMAT.md.
//
// Plain English:
//   Loads a fixture file into (state, block details, call, expected answer)
//   so tests and `arbsim check-fixture` can run our check and compare it
//   with the node's answer, fully offline.
// ============================================================================
use revm::primitives::{B256, U256};
use serde_json::Value;

use super::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64, to_hex};
use super::{CallOutcome, CallReq};
use crate::arb::BlockCtx;
use crate::state::mem::MemState;

/// What the reference node said.
#[derive(Clone, Debug)]
pub struct Expected {
    pub success: bool,
    pub output: String,
    pub gas_used: u64,
    /// true when the fixture says gas is only approximate (ArbSys stub).
    pub gas_approx: bool,
}

pub struct Fixture {
    pub name: String,
    pub state: MemState,
    pub ctx: BlockCtx,
    pub call: CallReq,
    pub expected: Expected,
    pub raw: Value,
}

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v.get(k).and_then(|x| x.as_str()).ok_or_else(|| format!("fixture: '{k}' missing"))
}

impl Fixture {
    pub fn load(path: &str) -> Result<Self, String> {
        let txt = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
        let j: Value = serde_json::from_str(&txt).map_err(|e| format!("parse {path}: {e}"))?;
        Self::from_json(j)
    }

    pub fn from_json(j: Value) -> Result<Self, String> {
        let b = j.get("block").ok_or("fixture: 'block' missing")?;
        let ctx = BlockCtx {
            l1_block_number: parse_u64(s(b, "number")?)?,
            l2_block_number: match j.get("l2BlockNumber") {
                Some(Value::String(x)) => Some(parse_u64(x)?),
                _ => None,
            },
            timestamp: parse_u64(s(b, "timestamp")?)?,
            basefee: parse_u64(s(b, "baseFee")?)?,
            coinbase: parse_address(s(b, "coinbase")?)?,
            gas_limit: parse_u64(s(b, "gasLimit")?)?,
            prevrandao: B256::from(parse_u256(s(b, "prevrandao")?)?),
        };
        let t = j.get("tx").ok_or("fixture: 'tx' missing")?;
        let call = CallReq {
            from: parse_address(s(t, "from")?)?,
            to: Some(parse_address(s(t, "to")?)?),
            data: parse_bytes(s(t, "data")?)?,
            gas: Some(parse_u64(s(t, "gas")?)?),
            value: t.get("value").and_then(|v| v.as_str()).map(parse_u256).transpose()?.unwrap_or(U256::ZERO),
        };
        let e = j.get("expected").ok_or("fixture: 'expected' missing")?;
        let note = e.get("note").and_then(|x| x.as_str()).unwrap_or("");
        let expected = Expected {
            success: e.get("success").and_then(|x| x.as_bool()).unwrap_or(false),
            output: e.get("output").and_then(|x| x.as_str()).unwrap_or("0x").to_lowercase(),
            gas_used: parse_u64(s(e, "gasUsed")?)?,
            gas_approx: note.contains("approximately") || note.to_lowercase().contains("stub"),
        };
        // Fixtures list everything the call touched: unlisted = empty.
        let state = MemState::from_prestate(j.get("prestate").ok_or("fixture: 'prestate' missing")?, true);
        Ok(Fixture { name: j.get("name").and_then(|x| x.as_str()).unwrap_or("?").to_string(), state, ctx, call, expected, raw: j })
    }

    /// Compare an outcome with the expected answer.
    pub fn compare(&self, o: &CallOutcome) -> Comparison {
        let out = to_hex(&o.output);
        Comparison {
            success_match: o.success == self.expected.success,
            output_match: out == self.expected.output,
            gas_match: o.gas_used == self.expected.gas_used,
            gas_diff: o.gas_used as i64 - self.expected.gas_used as i64,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Comparison {
    pub success_match: bool,
    pub output_match: bool,
    pub gas_match: bool,
    pub gas_diff: i64,
}

impl Comparison {
    pub fn exact(&self) -> bool {
        self.success_match && self.output_match && self.gas_match
    }
}
