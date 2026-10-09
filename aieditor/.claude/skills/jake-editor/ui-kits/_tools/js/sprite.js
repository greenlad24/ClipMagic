const u=[...new Set([...document.querySelectorAll('use')].map(u=>(u.getAttribute('href')||'').split('#')[0]).filter(Boolean))];
const out={}; for(const x of u){ const r=await fetch(x); out[x]=await r.text(); } return out;
