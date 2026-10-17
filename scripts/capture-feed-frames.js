// ============================================================================
// FEED FRAME CAPTURE (one-off, read-only).
// Connects to the PUBLIC Robinhood sequencer feed, saves the raw frames it
// receives to results/feed-frames.json, and exits. Used to benchmark the feed
// parser on real traffic. Sends nothing, uses no keys, touches no funds.
//   node scripts/capture-feed-frames.js [maxFrames] [maxSeconds]
// ============================================================================
const WebSocket = require('ws');
const fs = require('fs');

const MAX_FRAMES = Number(process.argv[2]) || 3000;   // stop after this many frames
const MAX_SECONDS = Number(process.argv[3]) || 900;   // or after this long
const OUT = 'results/feed-frames.json';

const frames = [];
let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(frames));      // raw frame text, exactly as received
  console.log(`saved ${frames.length} frames (${reason})`);
  process.exit(0);
}

const ws = new WebSocket('wss://feed.mainnet.chain.robinhood.com', { handshakeTimeout: 15000 });
ws.on('open', () => console.log('connected'));
ws.on('message', (m) => { frames.push(m.toString()); if (frames.length >= MAX_FRAMES) finish('frame limit'); });
ws.on('error', (e) => { console.log('feed error:', e.message); finish('error'); });
ws.on('close', () => finish('closed'));
setTimeout(() => finish('time limit'), MAX_SECONDS * 1000);
