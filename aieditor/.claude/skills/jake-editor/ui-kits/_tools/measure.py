import cv2, numpy as np, sys
f = 2560 / 1536
def bbox(img, bgr, tol=12):
    m = np.all(np.abs(img.astype(int) - bgr) <= tol, axis=2)
    ys, xs = np.nonzero(m)
    return None if not len(ys) else [round(v / f, 1) for v in (xs.min(), ys.min(), xs.max() - xs.min(), ys.max() - ys.min())]
def rows_bright(img, x0, x1, thr=120):
    g = img[:, int(x0 * f):int(x1 * f)].max(axis=2).max(axis=1)
    on = g > thr; out = []; s = None
    for y, v in enumerate(on):
        if v and s is None: s = y
        if not v and s is not None: out.append((round(s / f, 1), round(y / f, 1))); s = None
    return out
for which in ("real", "rep"):
    for n in ("result-image", "result-text"):
        im = cv2.imread(f"/s/{which}/{n}.png")
        print(which, n, "bubble", bbox(im, (118, 62, 23)), "rows(x24-260)", rows_bright(im, 24, 260)[:12])
