// ============================================================================
// SEQUENCER FEED (owner: workstream A)
//
// Plain English:
//   frame.rs   unpack the raw websocket frames the bot forwards (same rules
//              as the bot's src/chains/nitroFeed.ts)
//   tx.rs      decode each signed transaction and recover its sender
//   rlp.rs     the packing format transactions use
//   replay.rs  re-run every transaction of a message on our copy, in order
//              (this is what keeps the copy current; see state/mirror.rs)
// ============================================================================
pub mod frame;
pub mod replay;
pub mod rlp;
pub mod tx;

pub use frame::{parse_frame, FeedMessage};
pub use tx::{decode as decode_tx, FeedTx};
