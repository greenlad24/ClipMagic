// ARG = {sel, nth?, maxDepth?, closest?}
let root = document.querySelectorAll(ARG.sel)[ARG.nth||0];
if (root && ARG.closest) root = root.closest(ARG.closest);
if (!root) return {error:'no root'};
const R = root.getBoundingClientRect();
const P = ['display','position','box-sizing','width','height','min-height','max-height','padding','margin','gap','flex-direction','align-items','justify-content','grid-template-columns',
 'font-family','font-size','font-weight','line-height','letter-spacing','color','background-color','background-image','border','border-top','border-bottom','border-radius','box-shadow','opacity','backdrop-filter','overflow','fill','stroke','cursor','outline','text-overflow','white-space','transform','filter','z-index','inset'];
const DEF = {display:'',opacity:'1',transform:'none',filter:'none','backdrop-filter':'none','box-shadow':'none','background-image':'none','z-index':'auto',outline:'',cursor:'auto'};
let n=0; const nodes=[];
function walk(e, depth, path){
  if (n>600) return;
  const cs=getComputedStyle(e); const b=e.getBoundingClientRect();
  if (cs.display==='none') return; if (cs.display==='contents'){ for(const c of e.children) walk(c, depth); return; } if (b.width===0&&b.height===0&&e.tagName!=='svg') return;
  const st={}; for(const p of P){const v=cs.getPropertyValue(p); if(v && v!==DEF[p] && v!=='normal' && v!=='0px' && v!=='rgba(0, 0, 0, 0)' && v!=='auto' && v!=='none') st[p]=v;}
  const id=n++;
  const own=[...e.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent.trim()).join(' ').trim();
  nodes.push({id, depth, tag:e.tagName.toLowerCase(), cls:(e.getAttribute('class')||'').slice(0,300), attrs:Object.fromEntries([...e.attributes].filter(a=>/^(aria-|data-testid|role|type|placeholder|data-placeholder|viewBox|d|fill|stroke|width|height|href|xlink:href|stroke-width|stroke-linecap|stroke-linejoin|fill-rule|clip-rule)/.test(a.name)).map(a=>[a.name,a.value.slice(0,2000)])),
    box:[b.x-R.x,b.y-R.y,b.width,b.height].map(v=>Math.round(v*10)/10), text: own.slice(0,200), st, svg: e.tagName.toLowerCase()==='svg' ? e.outerHTML.slice(0,6000) : undefined});
  if (e.tagName.toLowerCase()==='svg') return;
  if (depth < (ARG.maxDepth||30)) for(const c of e.children) walk(c, depth+1);
}
walk(root,0);
return {rootBox:[R.x,R.y,R.width,R.height], nodes};
