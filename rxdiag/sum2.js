// Before/after summary from sample.jsonl: splits samples by the code running (sha),
// and gives per-hour rates of practice checks (all / stock pairs) and the latest pair-block count.
const fs = require('fs');
const rows = fs.readFileSync(process.env.HOME + '/rx/stockpx/sample.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const segs = [];
for (const r of rows) { const s = segs[segs.length - 1]; if (!s || s.sha !== r.sha) segs.push({ sha: r.sha, rows: [r] }); else s.rows.push(r); }
const K = ['sim', 'simProfit', 'simLoss', 'simFail', 'stockSim', 'stockLoss', 'stockFail', 'stockProfit', 'freeze'];
for (const s of segs) {
  const a = s.rows[0], b = s.rows[s.rows.length - 1], mins = Math.max(1, (Date.parse(b.t) - Date.parse(a.t)) / 60000);
  const d = Object.fromEntries(K.map((k) => [k, b[k] - a[k]]));
  const cpus = s.rows.map((r) => r.cpu).filter((x) => x != null); const avg = cpus.reduce((x, y) => x + y, 0) / (cpus.length || 1);
  console.log(`${s.sha} ${a.t.slice(11, 16)}-${b.t.slice(11, 16)} (${mins.toFixed(0)} min) counts ${JSON.stringify(d)} | per hour: checks ${(d.sim * 60 / mins).toFixed(0)}, profit ${(d.simProfit * 60 / mins).toFixed(1)}, stock ${(d.stockSim * 60 / mins).toFixed(1)} | blocks ${a.blocks}->${b.blocks} | cpu avg ${avg.toFixed(0)}% max ${Math.max(...cpus)} | restarts ${b.restarts} mem ${b.memMb}MB`);
}
const last = rows[rows.length - 1]; if (last.tickLines && last.tickLines.length) console.log(last.tickLines[0].slice(0, 220));
