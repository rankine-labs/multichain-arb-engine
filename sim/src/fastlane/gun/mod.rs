// ============================================================================
// FAST LANE GUN: the Rust sender (build calldata, sign, send). Workstream C.
//
// Plain English:
//   The fast lane finds a trade inside arbsim as each feed message arrives;
//   the gun turns it into a signed transaction and sends it, in well under a
//   millisecond of our own work. It is built as THE production sender: the
//   owner's plan (Oct 26) is for Rust to become the only sender for
//   everything, using the SAME executor wallet as the Node bot (the
//   contract allows one executor), one sender at a time (RUST_SENDER).
//
//   Files:
//     calldata.rs  ArbExecutor calldata, byte-identical to executorCalldata.ts
//     tx.rs        EIP-1559 transaction + secp256k1 signing (ethers-identical)
//     nonce.rs     local nonce counter with re-sync rules from fastSender.ts
//     gas.rs       gas price / block clock / gas limit refresh every 2 s
//     rpc.rs       small read client (gas, nonce) on the Node bot's read node
//     send.rs      eth_sendRawTransaction on kept-alive connections
//     gun.rs       Gun::fire: all of the above + safety gate + timings
// ============================================================================
pub mod calldata;
pub mod gas;
#[allow(clippy::module_inception)]
pub mod gun;
pub mod nonce;
pub mod rpc;
pub mod send;
pub mod tx;

pub use gun::{CallInput, CallPlan, FireRecord, Gate, Gun, GunConfig, Mode, NoGate};
