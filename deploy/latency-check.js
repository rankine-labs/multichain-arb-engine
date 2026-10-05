#!/usr/bin/env node
// ============================================================================
// LATENCY CHECK -- how far is this machine from Robinhood's servers?
//
// Plain English:
//   Run this on a server (current one, or a test instance in another AWS
//   region). It measures, from that machine:
//     - TCP connect time to Robinhood's feed and RPC (pure network distance)
//     - a full RPC round trip (eth_blockNumber)
//   and says which cloud/region the Robinhood IPs belong to when it can.
//   Lower numbers = closer = faster bot. Compare regions, move to the best.
//
//   node deploy/latency-check.js
// No npm packages needed.
// ============================================================================
'use strict';
const dns = require('dns').promises;
const net = require('net');

const HOSTS = ['feed.mainnet.chain.robinhood.com', 'rpc.mainnet.chain.robinhood.com', 'sequencer.mainnet.chain.robinhood.com'];
// Round trips compared: public RPC, the sequencer directly (where the bot
// sends trades), and Alchemy if an Alchemy key is in the bot's .env.
function alchemyUrl() {
  try {
    const env = require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8');
    const m = /alchemy\.com\/v2\/([A-Za-z0-9_-]+)/.exec(env); // reads only the key, nothing else
    return m ? `https://robinhood-mainnet.g.alchemy.com/v2/${m[1]}` : null;
  } catch { return null; }
}
const ENDPOINTS = [
  ['public RPC', 'https://rpc.mainnet.chain.robinhood.com'],
  ['sequencer (direct)', 'https://sequencer.mainnet.chain.robinhood.com'],
  ...(alchemyUrl() ? [['Alchemy', alchemyUrl()]] : []),
];
const ROUNDS = 7;

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function tcpConnectMs(ip) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host: ip, port: 443, timeout: 3000 }, () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      sock.destroy(); resolve(ms);
    });
    sock.on('error', () => { sock.destroy(); resolve(null); });
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

async function rpcMs(url) {
  const t0 = process.hrtime.bigint();
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
    await r.text();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  } catch { return null; }
}

// Which AWS region an IP belongs to (null if it's not AWS, e.g. Cloudflare).
async function awsRegion(ip, ranges) {
  if (!ranges) return null;
  const toNum = (a) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
  const n = toNum(ip);
  for (const p of ranges.prefixes) {
    const [base, bits] = p.ip_prefix.split('/');
    const size = 2 ** (32 - Number(bits));
    const start = toNum(base);
    if (n >= start && n < start + size && p.service === 'EC2') return p.region;
  }
  return null;
}

(async () => {
  let ranges = null;
  try { ranges = await (await fetch('https://ip-ranges.amazonaws.com/ip-ranges.json')).json(); } catch { /* optional */ }
  let here = '?';
  try {
    // EC2 metadata (IMDSv2 token first; v1 fallback). Anything that isn't a
    // region name (e.g. another cloud's metadata service) is ignored.
    let token = '';
    try { token = await (await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(500) })).text(); } catch { /* v1 */ }
    const r = (await (await fetch('http://169.254.169.254/latest/meta-data/placement/region', { headers: token ? { 'X-aws-ec2-metadata-token': token } : {}, signal: AbortSignal.timeout(500) })).text()).trim();
    if (/^[a-z]{2}(-[a-z]+)+-\d$/.test(r)) here = r;
  } catch { /* not on EC2 */ }
  console.log(`Latency check from: ${here === '?' ? 'this machine' : 'AWS ' + here}`);

  for (const host of HOSTS) {
    let ips = [];
    try { ips = (await dns.lookup(host, { all: true, family: 4 })).map((a) => a.address); } catch { /* none */ }
    if (!ips.length) { console.log(`${host}: DNS failed`); continue; }
    const ip = ips[0];
    const times = [];
    for (let i = 0; i < ROUNDS; i++) { const t = await tcpConnectMs(ip); if (t !== null) times.push(t); }
    const region = await awsRegion(ip, ranges);
    console.log(`${host} -> ${ip} (${region ? 'AWS ' + region : 'not an AWS EC2 address, likely a CDN edge'}): TCP connect ${times.length ? median(times).toFixed(1) + ' ms median' : 'failed'}`);
  }
  for (const [label, url] of ENDPOINTS) {
    const rt = [];
    for (let i = 0; i < ROUNDS; i++) { const t = await rpcMs(url); if (t !== null) rt.push(t); }
    console.log(`Round trip, ${label}: ${rt.length ? median(rt).toFixed(1) + ' ms median, best ' + Math.min(...rt).toFixed(1) + ' ms' : 'failed'}`);
  }
  console.log('Robinhood sits behind a CDN, so TCP connect only measures the nearest edge. The RPC round trip is the real distance.');
  console.log('Tip: run this in 2-3 AWS regions (us-east-1, us-east-2, us-west-2) and keep the bot where the RPC round trip is lowest.');
})();
