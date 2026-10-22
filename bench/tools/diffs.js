// node diffs.js <rundir> : explain coin-balance diffs by matching Transfers; tally check misses
const fs=require('fs');const dir=process.argv[2];
const url=fs.readFileSync(process.env.HOME+'/multichain-arb-engine/.env','utf8').match(/^\s*CHAINSTACK_RPC_ROBINHOOD\s*=\s*["']?([^"'\s#]+)/m)[1];
const r=async(m,p)=>{for(let i=0;i<5;i++){const j=await (await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})})).json();if(!j.error||j.error.code!==-32005)return j;await new Promise(z=>setTimeout(z,500));}};
const T='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad=a=>'0x'+a.slice(2).toLowerCase().padStart(64,'0');
(async()=>{
 const rows=fs.readFileSync(dir+'/probes.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse).filter(d=>d.verdict==='different');
 const summary={};let n=0;
 for(const d of rows){
  for(const x of d.diffs){
   const m=x.match(/call (\d+): fast ok (0x[0-9a-f]*) vs node ok (0x[0-9a-f]*)/);if(!m)continue;
   const ci=Number(m[1]);const label=d.labels[ci]; if(!/coin/.test(label)){console.log('NONCOIN',d.pool,label,x.slice(0,120));continue;}
   const delta=BigInt(m[3])-BigInt(m[2]);
   const sel=label.startsWith('coin0')?'0x0dfe1681':'0xd21220a7';
   const coin='0x'+(await r('eth_call',[{to:d.pool,data:sel},'0x'+d.block.toString(16)])).result.slice(26);
   const B=d.block;let hit=null;
   for(const [dirn,topics] of [['in',[T,null,pad(d.pool)]],['out',[T,pad(d.pool)]]]){
     const lg=await r('eth_getLogs',[{fromBlock:'0x'+(B-3000).toString(16),toBlock:'0x'+B.toString(16),address:coin,topics}]);
     for(const l of lg.result||[]){const v=BigInt(l.data.slice(0,66));if((dirn==='in'&&v===delta)||(dirn==='out'&&-v===delta)){hit={dirn,block:parseInt(l.blockNumber),ago:B-parseInt(l.blockNumber),tx:l.transactionHash,from:'0x'+l.topics[1].slice(26),to:'0x'+l.topics[2].slice(26)};}}
   }
   n++;const key=hit?('matches one transfer '+hit.dirn):'no single transfer matches';summary[key]=(summary[key]||0)+1;
   console.log(d.block,d.pool.slice(0,10),d.kind,label,coin.slice(0,10),'delta',delta.toString(),hit?JSON.stringify(hit):'');
  }
 }
 console.log('SUMMARY',n,JSON.stringify(summary));
 const ch=fs.readFileSync(dir+'/checks.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse).filter(d=>d.verdict==='fast-missing');
 const acc={};for(const c of ch)for(const m of (c.fast?.missing||[])){const k=m.account+(m.slot?' slot':' basics');acc[k]=(acc[k]||0)+1;}
 console.log('CHECK MISSES top',JSON.stringify(Object.entries(acc).sort((a,b)=>b[1]-a[1]).slice(0,12)));
})();
