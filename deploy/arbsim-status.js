#!/usr/bin/env node
// ============================================================================
// ARBSIM STATUS: plain-English health report of the fast-check sidecar.
//
//     node deploy/arbsim-status.js            (or: bash deploy/arbsim-pm2.sh status)
//     node deploy/arbsim-status.js --json     raw answer, for scripts
//     node deploy/arbsim-status.js /path.sock other socket
//
// Plain English:
//   Connects to the sidecar's local socket (default /tmp/arbsim.sock, or
//   ARBSIM_SOCKET), asks {"type":"status"} and prints what the answer means:
//   is its copy of the chain current, how often it had to ask the node, how
//   much of today's node allowance is used, memory, and whether its own
//   self-checks agree with the node. Read-only: it changes nothing.
//   Also shows which program version is installed (bin/arbsim.build_info).
//
// Exit codes: 0 = answered, 1 = sidecar not reachable / no answer / bad answer.
// Plain Node, no packages needed (runs even if node_modules is broken).
// ============================================================================
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const sockArg = args.find((a) => !a.startsWith('--'));
const APP_DIR = path.resolve(__dirname, '..');

// Same socket rule as the bot: ARBSIM_SOCKET in the environment or .env, else /tmp/arbsim.sock.
function envFileValue(key) {
  try {
    const lines = fs.readFileSync(path.join(APP_DIR, '.env'), 'utf8').split('\n');
    let v = '';
    for (const l of lines) {
      const m = l.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`));
      if (m) v = m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    }
    return v;
  } catch { return ''; }
}
const SOCKET = sockArg || process.env.ARBSIM_SOCKET || envFileValue('ARBSIM_SOCKET') || '/tmp/arbsim.sock';
const TIMEOUT_MS = 5000;

// --- talk to the sidecar: 4-byte big-endian length + JSON, both directions ---
function askStatus() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no answer within ${TIMEOUT_MS / 1000} s`)); }, TIMEOUT_MS);
    sock.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ id: 1, type: 'status' }), 'utf8');
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
      sock.write(Buffer.concat([len, body]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length < 4 + n) return;
        const msg = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n);
        let j; try { j = JSON.parse(msg.toString('utf8')); } catch { continue; }
        if (j && j.id === 1) { clearTimeout(timer); sock.end(); resolve(j); return; }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Newest block on the public Robinhood node (for "how far behind is it?").
// Optional: if it fails, the report just says the sidecar's own view.
function publicTip() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const req = https.request('https://rpc.mainnet.chain.robinhood.com', {
      method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 4000,
    }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => {
        try { resolve(parseInt(JSON.parse(s).result, 16) || null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// --- formatting helpers ---
const n = (x) => (typeof x === 'number' ? x.toLocaleString('en-US') : '?');
const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '-');
function dur(ms) {
  if (typeof ms !== 'number') return '?';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
function buildInfo() {
  try {
    const t = fs.readFileSync(path.join(APP_DIR, 'bin', 'arbsim.build_info'), 'utf8');
    const o = {}; for (const l of t.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1).trim(); }
    return o;
  } catch { return null; }
}

async function main() {
  const info = buildInfo();
  let s;
  try {
    s = await askStatus();
  } catch (e) {
    console.log(`FAST CHECK SIDECAR: NOT REACHABLE (${SOCKET}: ${e.code || e.message})`);
    console.log('  The bot is unaffected: it uses the node for checks while the sidecar is down.');
    console.log('  Is it meant to run? LOCAL_SIM in .env must be shadow or on. Then: pm2 status arbsim,');
    console.log('  pm2 logs arbsim --lines 50, and bash deploy/arbsim-update.sh');
    if (info) console.log(`  Installed program: built from ${(info.source_commit || '?').slice(0, 7)} (sim ${(info.sim_tree || '?').slice(0, 8)})`);
    process.exit(1);
  }
  if (!s || s.ok !== true) {
    console.log(`FAST CHECK SIDECAR: answered, but not with a normal status (${JSON.stringify(s).slice(0, 200)})`);
    process.exit(1);
  }
  if (wantJson) { console.log(JSON.stringify(s, null, 2)); return; }

  const tip = await publicTip();
  const head = s.head || null;
  const lines = [];

  // 1. Overall
  let verdict;
  if (s.stalled) verdict = `NOT READY: stuck (${s.stalled}); every check answers "unknown", the bot uses the node`;
  else if (!s.ready) verdict = 'NOT READY yet: no copy of the chain yet (waiting for feed messages from the bot and the node); checks answer "unknown", the bot uses the node';
  else verdict = 'READY: answering checks from its own copy';
  lines.push(`FAST CHECK SIDECAR: ${verdict}`);
  lines.push(`  Running for ${dur((s.uptimeS || 0) * 1000)}, memory ${s.rssMb ?? '?'} MB (pm2 restarts it above 150 MB)`);
  if (info) lines.push(`  Program: built from ${(info.source_commit || '?').slice(0, 7)} on ${info.built_at || '?'} (sim ${(info.sim_tree || '?').slice(0, 8)})`);

  // 2. Head vs chain
  if (head) {
    const chainTip = tip || s.nodeTip || 0;
    const behind = chainTip ? chainTip - head.block : null;
    lines.push(`  Its copy is at block ${n(head.block)} (feed message ${n(head.seq)}), updated ${dur(head.ageMs)} ago`);
    if (chainTip) {
      lines.push(`  Chain is at block ${n(chainTip)}${tip ? ' (public node)' : ' (paid node, last seen)'}: ` +
        (behind <= 2 ? 'up to date' : `${n(behind)} blocks behind`));
    }
  } else {
    lines.push('  No copy of the chain yet' + (s.nodeTip ? ` (chain is at block ${n(s.nodeTip)})` : ''));
  }
  if (s.copy2) { /* copy 2: the feed / replay lines below are about copy 1 */ } else if (s.lastFrameAgoMs == null) lines.push('  Feed: no messages from the bot yet (is LOCAL_SIM set and the bot running?)');
  else lines.push(`  Feed: last message from the bot ${dur(s.lastFrameAgoMs)} ago; ${n(s.frames)} received, ${n(s.frames_dropped)} dropped, ${n(s.frames_bad)} unreadable`);

  // 2b. Copy 2 (ARBSIM_SOURCE=pool-events): our pools kept current from their own events
  const c2 = s.copy2;
  if (c2) {
    const chainTip = tip || c2.nodeTip || 0;
    const behind = chainTip && c2.copyBlock ? chainTip - c2.copyBlock : null;
    lines.push(`  COPY 2 (pool events): ${n(c2.pools)} pools followed: ${n(c2.ready)} ready, ${n(c2.loading)} loading, ${n(c2.unsure)} unsure`);
    lines.push(`    copy at block ${n(c2.copyBlock)}` + (chainTip ? `, chain at ${n(chainTip)}: ` +
      (behind <= 2 ? 'up to date' : `${n(behind)} blocks BEHIND  <-- tell Claude`) : ''));
    const lr = c2.loadRound || {};
    if (lr.pools) {
      lines.push(`    last load round: ${n(lr.pools)} pools, ${lr.done ? 'finished' : 'still running'} after ${dur((lr.seconds || 0) * 1000)}, ` +
        `${n(lr.requests)} node requests (${n(lr.ready)} ready, ${n(lr.unsure)} unsure)`);
    }
    const k = c2.counters || {};
    lines.push(`    events applied ${n(k.events_applied)}, reports carried into loads ${n(k.carried_events)}, ` +
      `node requests by copy 2 ${n(c2.nodeRequests)}, node jobs running ${n(c2.nodeJobsInFlight)}, slowest block ${n(k.apply_us_max)} microseconds`);
    const show = (title, list) => {
      if (Array.isArray(list) && list.length) lines.push(`    ${title}: ${list.slice(0, 5).map((r) => `${String(r.why).replace(/^loading: /, '')} (${n(r.n)})`).join('; ')}`);
    };
    show('why unsure', c2.unsureReasons);
    show('loading now', c2.loadingReasons);
  }

  // 3. How the copy is kept current (copy 1, the feed replay)
  const rep = s.msgs_replayed || 0, tr = s.msgs_traced || 0;
  if (!c2) {
  lines.push(`  Kept current by: ${n(rep)} messages replayed on its own, ${n(tr)} looked up on the node (${pct(tr, rep + tr)} needed the node)`);
  if (Array.isArray(s.traceReasons) && s.traceReasons.length) {
    lines.push(`    why the node was needed: ${s.traceReasons.slice(0, 5).map((r) => `${r.why} ${n(r.n)}`).join(', ')}`);
  }
  lines.push(`  Gaps in the feed: ${n(s.gaps)} (${n(s.gap_blocks)} blocks); copy restarted ${n(s.restarts)}x`);
  lines.push(`  Not sure ("dirty") ${n(s.dirty_events)} times, ${dur(s.dirty_ms_total)} in total` +
    (s.dirtyFrom != null ? `; RIGHT NOW waiting from message ${n(s.dirtyFrom)}` : ''));

  // 4. Self-check against the node
  const mm = s.replay_mismatch || 0, ok = s.replay_match || 0;
  lines.push(`  Self-check vs node: ${n(ok)} match, ${n(mm)} mismatch` +
    (mm > 0 ? '  <-- mismatches mean its copy was wrong somewhere; it corrects itself, but tell Claude' : (ok ? '  (good)' : '')) +
    `; ${n(s.verify_items)} items compared, ${n(s.verify_item_mismatches)} differed`);
  }

  // 5. Checks answered
  const c = s.checks || 0;
  lines.push(`  Checks: ${n(c)} asked, ${n(s.checks_ok)} sure answers (${pct(s.checks_ok || 0, c)}), ${n(s.checks_unknown)} "unknown" (the bot then uses the node)`);
  lines.push(`  Its copy holds ${n(s.accounts)} accounts, ${n(s.slots)} storage values; ${n(s.fillQueue)} waiting to be fetched`);

  // 6. Node use today vs cap
  const node = s.node;
  if (!node) {
    lines.push('  Paid node: NONE configured (CHAINSTACK_RPC_ROBINHOOD missing in .env?) - it can only answer very little');
  } else {
    const used = node.usedToday || 0, cap = node.cap || 0;
    lines.push(`  Paid node use today (UTC): ${n(used)} of ${n(cap)} allowed (${pct(used, cap)})` +
      (node.refusedToday ? `, ${n(node.refusedToday)} refused (allowance used up)` : '') +
      `; nodes: ${(node.nodes || []).join(', ') || '?'}` + (node.errors ? `; ${n(node.errors)} node errors` : ''));
    if (node.public) lines.push(`  Free public node use today: ${n(node.public.usedToday)}`);
  }

  console.log(lines.join('\n'));
}

main().catch((e) => { console.log(`FAST CHECK SIDECAR: status helper error: ${e.message}`); process.exit(1); });
