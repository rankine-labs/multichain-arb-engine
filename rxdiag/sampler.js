// Read-only sampler: every 60 s appends one line to ~/rx/stockpx/sample.jsonl with
// counts from the bot's log since the sampler started, the pair-block count,
// and the bot's CPU. Stops by itself after 3 h, or when ~/rx/stockpx/STOP exists.
const fs = require('fs'), { execSync } = require('child_process');
const H = process.env.HOME, OUT = H + '/rx/stockpx/sample.jsonl', LOG = H + '/.pm2/logs/dex-arb-shadow-out.log';
const R = H + '/multichain-arb-engine';
const STOCK = /^(MRNA|BE|GOOGL|RIVN|SNDK|HIMS)$/;
let pos = fs.statSync(LOG).size, ino = fs.statSync(LOG).ino, buf = '';
const c = { sim: 0, simProfit: 0, simLoss: 0, simFail: 0, stockSim: 0, stockLoss: 0, stockFail: 0, stockProfit: 0, freeze: 0, tickLines: [], restarts: 0 };
const t0 = Date.now();
function readNew() {
  let st; try { st = fs.statSync(LOG); } catch { return; }
  if (st.ino !== ino || st.size < pos) { ino = st.ino; pos = 0; }
  if (st.size <= pos) return;
  const fd = fs.openSync(LOG, 'r'); const b = Buffer.alloc(Math.min(st.size - pos, 64 << 20)); fs.readSync(fd, b, 0, b.length, pos); fs.closeSync(fd); pos += b.length;
  const lines = (buf + b.toString('utf8')).split('\n'); buf = lines.pop();
  for (const l of lines) {
    if (l.startsWith('[sim] robinhood ')) {
      const m = /^\[sim\] robinhood (\S+)\/(\S+) \S+ (real: (\w+)|REAL PROFIT)/.exec(l); if (!m) continue;
      c.sim++; const res = m[4] || 'PROFIT';
      if (res === 'PROFIT') c.simProfit++; else if (res === 'LOSS') c.simLoss++; else c.simFail++;
      if (STOCK.test(m[1]) || STOCK.test(m[2])) { c.stockSim++; if (res === 'PROFIT') c.stockProfit++; else if (res === 'LOSS') c.stockLoss++; else c.stockFail++; }
    } else if (l.startsWith('[freeze-named]')) c.freeze++;
    else if (l.startsWith('[tick-math]')) { c.tickLines.push(l.slice(0, 220)); if (c.tickLines.length > 5) c.tickLines.shift(); }
  }
}
function blocks() { try { const j = JSON.parse(fs.readFileSync(R + '/data/live-blocks.json', 'utf8')); const n = Date.now(); let k = 0; for (const v of Object.values(j)) if (v && v.until > n) k++; return k; } catch { return null; } }
function cpu() { try { const j = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', maxBuffer: 1 << 26 })); const p = j.find((x) => x.name === 'dex-arb-shadow'); return p ? { cpu: p.monit.cpu, memMb: Math.round(p.monit.memory / 1e6), restarts: p.pm2_env.restart_time, uptimeMin: Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000) } : null; } catch { return null; } }
function tick() {
  readNew();
  let sha = null; try { sha = execSync('git -C ' + R + ' rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch {}
  fs.appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), min: Math.round((Date.now() - t0) / 60000), sha, blocks: blocks(), ...cpu(), ...c, tickLines: c.tickLines.slice(-1) }) + '\n');
  if (Date.now() - t0 > 3 * 3600_000 || fs.existsSync(H + '/rx/stockpx/STOP')) process.exit(0);
}
tick(); setInterval(tick, 60_000);
