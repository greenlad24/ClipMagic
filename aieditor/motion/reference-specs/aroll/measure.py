# Measure A-roll digital camera motion in a reference: per sampled non-screencast frame, the
# similarity scale vs the shot's first frame (ORB+RANSAC), and each shot's level vs a prototype.
import json, subprocess, sys
import numpy as np, cv2
r = sys.argv[1]; STEP = 2; W, H = 640, 360; FPS = 30000 / 1001
a = json.load(open(f'/ref/work/sc5/{r}/analysis.json')); N = a['N']
insc = np.zeros(N + 10, bool)
for s, e in a['spans']:
    insc[max(0, s - 2):e + 3] = True
orb = cv2.ORB_create(1500, fastThreshold=10)
def feats(g):
    return orb.detectAndCompute(g, None)
bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
def sim(fa, fb):
    ka, da = fa; kb, db = fb
    if da is None or db is None or len(ka) < 30 or len(kb) < 30:
        return None
    m = bf.match(da, db)
    if len(m) < 25:
        return None
    pa = np.float32([ka[x.queryIdx].pt for x in m]); pb = np.float32([kb[x.trainIdx].pt for x in m])
    M, inl = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if M is None or inl.sum() < 20:
        return None
    s = float(np.hypot(M[0, 0], M[1, 0]))
    return s, float(M[0, 2]), float(M[1, 2]), int(inl.sum())
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', f'/ref/{r}/video.mp4', '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
fb = W * H; i = 0; prev = None; shot = None; out = []; pf = None; proto = None
first_sc_end = a['spans'][0][1] if a['spans'] and a['spans'][0][0] < 30 else 0
while True:
    buf = p.stdout.read(fb)
    if len(buf) < fb: break
    if i % STEP == 0 and not insc[i]:
        g = np.frombuffer(buf, np.uint8).reshape(H, W)
        small = cv2.resize(g, (64, 36)).astype(np.int16)
        d = 99.0 if prev is None or prev[0] != i - STEP else float(np.abs(small - prev[1]).mean())
        f = feats(g)
        new = shot is None or d > 6.0
        rel = None
        if not new:
            rel = sim(shot['f'], f)          # shot-first → this frame: scale>1 = zoomed IN further
            if rel is None or abs(np.log(rel[0])) > 0.35:
                new = True
        cr = None; pr = None
        if new:
            if pf is not None and pf[0] == i - STEP:
                c = sim(pf[1], f); cr = round(c[0], 4) if c else None
            if proto is None and i > first_sc_end and i > 60:
                proto = f
            if proto is not None:
                c = sim(proto, f); pr = round(c[0], 4) if c else None
            shot = {'i0': i, 'f': f}
            rel = (1.0, 0.0, 0.0, 999)
        out.append([i, round(i / FPS, 3), int(new), round(rel[0], 5), round(rel[1], 1), round(rel[2], 1), rel[3], round(d, 2), cr, pr])
        pf = (i, f)
        if new:
            shot['g'] = g.copy()
        prev = (i, small)
    i += 1
p.wait()
# shot levels: each shot's first frame vs a few prototypes
shots = [o for o in out if o[2]]
json.dump({'ref': r, 'step': STEP, 'samples': out, 'N': i}, open(f'/w/{r}.json', 'w'))
print(r, len(out), len(shots))
