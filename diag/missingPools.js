// READ-ONLY: which pools that rivals profit through are NOT on our watch list?
// Input: ~/rx/profitSlow/per-arb.jsonl (rival arbs we could not copy because of unwatched pools).
// For each such rival tx: read its receipt, decode every swap (bot's own decoder), find pools not in
// data/watched-pools.json, and add up the rival's profit per missing pool. Never sends anything.
const fs=require('fs'),path=require('path'),H=process.env.HOME,APP=H+'/multichain-arb-engine';
const { decodeSwapLog } = require(APP+'/dist/core/followMoney.js');
const { ROBINHOOD_SCAN_FACTORIES } = require(APP+'/dist/config/knownAddresses.js');
const env=Object.fromEntries(fs.readFileSync(APP+'/.env','utf8').split('\n').filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim().replace(/^"|"$/g,'')]));
const URL_=env.CHAINSTACK_RPC_ROBINHOOD; let id=0;
const rpc=async(m,p)=>{await new Promise(r=>setTimeout(r,120));const r=await fetch(URL_,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:m,params:p})});return (await r.json()).result;};
const lc=s=>String(s||'').toLowerCase();
const watch=JSON.parse(fs.readFileSync(APP+'/data/watched-pools.json','utf8'));
const watched=new Set((watch.pools||[]).filter(p=>p&&p.chain==='robinhood'&&p.poolAddress).map(p=>lc(p.poolAddress)));
const facDex=new Map(ROBINHOOD_SCAN_FACTORIES.map(f=>[lc(f.factory),f.dex]));
const call=async(to,sig)=>{const r=await rpc('eth_call',[{to,data:sig},'latest']);return r&&r!=='0x'?r:null;};
const addr=w=>w?'0x'+w.slice(-40):null;
const symCache=new Map();
const sym=async(t)=>{if(!t)return '?';if(symCache.has(t))return symCache.get(t);let s='?';try{const r=await call(t,'0x95d89b41');if(r&&r.length>=194){const n=parseInt(r.slice(130,194),16);s=Buffer.from(r.slice(194,194+n*2),'hex').toString();}else if(r&&r.length===66)s=Buffer.from(r.slice(2),'hex').toString().replace(/\0/g,'');}catch{}symCache.set(t,s);return s;};
(async()=>{
  const rows=fs.readFileSync(H+'/rx/profitSlow/per-arb.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(r=>r.ours&&r.ours.status==='not-ours'&&/watch list/.test(r.ours.why));
  const miss=new Map();
  for(const r of rows){
    const rc=await rpc('eth_getTransactionReceipt',[r.hash]); if(!rc) continue;
    const pools=new Map(); for(const l of rc.logs){const s=decodeSwapLog(l); if(s&&!watched.has(lc(s.pool))) pools.set(lc(s.pool),s.kind);}
    const trusted=r.rival.trust==='ok'&&typeof r.rival.netUsd==='number'?r.rival.netUsd:0;
    for(const [p,k] of pools){const e=miss.get(p)??{pool:p,kind:k,arbs:0,trustedUsd:0,allUsd:0};e.arbs++;e.trustedUsd+=trusted;e.allUsd+=(typeof r.rival.netUsd==='number'?r.rival.netUsd:0);miss.set(p,e);}
  }
  const list=[...miss.values()].sort((a,b)=>b.trustedUsd-a.trustedUsd||b.arbs-a.arbs);
  for(const e of list){ if(e.kind==='v4'){e.dex='uniswap-v4 (pool id; key via auto-follow)';e.pair='?';continue;}
    const f=addr(await call(e.pool,'0xc45a0155')),t0=addr(await call(e.pool,'0x0dfe1681')),t1=addr(await call(e.pool,'0xd21220a7'));
    e.dex=facDex.get(lc(f))||('unknown factory '+(f||'?'));e.pair=(await sym(t0))+'/'+(await sym(t1));e.token0=t0;e.token1=t1;}
  const out=['rank,pool,type,dex,pair,rival_arbs,rival_profit_trusted_usd,rival_profit_all_prices_usd'];
  list.forEach((e,i)=>out.push([i+1,e.pool,e.kind,e.dex,e.pair,e.arbs,e.trustedUsd.toFixed(2),e.allUsd.toFixed(2)].join(',')));
  fs.writeFileSync(H+'/rx/missing-pools.csv',out.join('\n')+'\n');
  console.log('rival arbs with unwatched pools',rows.length,'| missing pools',list.length,'| V4',list.filter(e=>e.kind==='v4').length,'| other',list.filter(e=>e.kind!=='v4').length);
  console.log(out.slice(0,26).join('\n'));
})().catch(e=>console.log('ERR',e.message));
