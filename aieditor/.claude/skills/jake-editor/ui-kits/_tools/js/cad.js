const st=[...document.querySelectorAll('[role=status]')].find(s=>s.querySelector('span[aria-hidden]')); const outer=st.querySelector('span[aria-hidden]'); const inner=outer.firstElementChild;
const s=[]; const t0=performance.now(); while(performance.now()-t0<7000){ const a=outer.getAnimations()[0]; s.push([Math.round(performance.now()-t0), a? Math.round(a.currentTime): null, getComputedStyle(outer).transform.split(',')[4]]); await new Promise(r=>setTimeout(r,100)); }
const co=getComputedStyle(outer), ci=getComputedStyle(inner);
const rules=[]; for(const sh of document.styleSheets){ try{ for(const r of sh.cssRules){ const t=r.cssText; if(/cadenced|Shimmer/i.test(t)) rules.push(t.slice(0,600)); } }catch(e){} }
return {s, outer:{w:co.width, mask:co.maskImage||co.webkitMaskImage, pos:co.position, inset:co.inset}, inner:{color:ci.color, bg:ci.backgroundImage, clip:ci.backgroundClip||ci.webkitBackgroundClip}, rules:rules.slice(0,20)};
