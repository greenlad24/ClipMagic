const ARGB=1500; const urls=[...new Set(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>/\.js(\?|$)/.test(u)))];
const pats=ARG.map(p=>new RegExp(p,'g')); const hits={};
for(const u of urls){ let t; try{ t=await (await fetch(u)).text(); }catch(e){continue;}
  for(const p of pats){ let m; p.lastIndex=0; let n=0; while((m=p.exec(t)) && n<6){ (hits[p.source]=hits[p.source]||[]).push(t.slice(Math.max(0,m.index-ARGB), m.index+ARGB)); n++; } } }
return {n:urls.length, hits};
