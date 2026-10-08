import json,sys,statistics as st
def q(xs,ps=(10,25,50,75,90)):
    xs=sorted(xs); return [round(xs[min(len(xs)-1,int(p/100*len(xs)))],3) for p in ps] if xs else []
for r in ['kwysV2smgfY','3Jq-L6uLd28','Geg9TyNoi3w','AZxFgIVgHjg']:
    d=json.load(open(r+'.json')); S=d['samples']; FPS=30000/1001
    shots=[];cur=None
    for o in S:
        if o[2]:
            cur={'t0':o[1],'pts':[],'cr':o[8],'pr':o[9]}; shots.append(cur)
        cur['pts'].append((o[1],o[3],o[6]))
    good=[]
    for s in shots:
        p=s['pts']; dur=p[-1][0]-p[0][0]
        inl=st.median([x[2] for x in p[1:]]) if len(p)>1 else 0
        s['dur']=dur; s['inl']=inl; s['end']=p[-1][1]
        s['ok']= dur>=0.6 and inl>=60
    ok=[s for s in shots if s['ok']]
    rates=[];caps=[];still=0;tot=0;moving=0
    for s in ok:
        p=s['pts']
        # rate over first 3 s
        early=[x for x in p if x[0]-p[0][0]<=3.0]
        if len(early)>3 and early[-1][0]>early[0][0]: rates.append((early[-1][1]-1)/(early[-1][0]-early[0][0])*100)
        if s['dur']>=6: caps.append(max(x[1] for x in p))
        for a,b in zip(p,p[1:]):
            dt=b[0]-a[0]; tot+=dt
            if abs(b[1]-a[1])/dt>0.004: moving+=dt
    # cut ratios between consecutive OK shots (presenter-presenter jump cuts)
    crs=[s['cr'] for s in ok if s['cr'] is not None]
    jumps=[c for c in crs if abs(c-1)>0.08]
    # level vs prototype
    prs=[s['pr'] for s in ok if s['pr'] is not None]
    atime=sum(s['dur'] for s in ok)
    print(f"== {r}: presenter shots {len(ok)}/{len(shots)}, presenter time {atime:.0f}s, shot dur q {q([s['dur'] for s in ok])}")
    print(f"  push rate %/s q {q(rates)}; cap (shots>=6s) q {q(caps)}; moving frac {moving/max(tot,1e-9):.2f}")
    print(f"  cut ratios (n={len(crs)}) q {q(crs)}; framing changes |r-1|>8%: {len(jumps)} ({len(jumps)/max(1,len(crs)):.2f}); per presenter-min {len(jumps)/atime*60:.1f}; jump cuts/presenter-min {len(crs)/atime*60:.1f}")
    print(f"  level vs proto q {q(prs)}")
    print('  jumps', [round(c,2) for c in jumps][:30])
