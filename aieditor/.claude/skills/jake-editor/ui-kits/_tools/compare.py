import cv2, numpy as np, json, sys
names = ["composer","composer-short","composer-multiline","composer-pill","composer-attachments","menu","result-image","result-text"]
rows, stats = [], {}
for n in names:
    a = cv2.imread(f"/s/real/{n}.png"); b = cv2.imread(f"/s/rep/{n}.png")
    h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1]); a, b = a[:h, :w], b[:h, :w]
    d = cv2.absdiff(a, b); g = d.max(axis=2)
    stats[n] = {"mean_abs": round(float(d.mean()), 2), "px_over_40": round(float((g > 40).mean() * 100), 2)}
    dv = cv2.applyColorMap(np.clip(g.astype(np.float32) * 3, 0, 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
    pad = lambda im: cv2.copyMakeBorder(im, 34, 6, 6, 6, cv2.BORDER_CONSTANT, value=(40, 40, 40))
    row = np.hstack([pad(a), pad(b), pad(dv)])
    for i, lab in enumerate([f"REAL {n}", "KIT REPLICA", f"DIFF x3  mean {stats[n]['mean_abs']}  >40: {stats[n]['px_over_40']}%"]):
        cv2.putText(row, lab, (12 + i * (w + 12), 25), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2, cv2.LINE_AA)
    rows.append(row)
W = max(r.shape[1] for r in rows)
sheet = np.vstack([cv2.copyMakeBorder(r, 0, 0, 0, W - r.shape[1], cv2.BORDER_CONSTANT, value=(40, 40, 40)) for r in rows])
sheet = cv2.resize(sheet, (sheet.shape[1] // 2, sheet.shape[0] // 2), interpolation=cv2.INTER_AREA)
cv2.imwrite("/s/replica-compare.png", sheet)
json.dump(stats, open("/s/compare-stats.json", "w"), indent=1)
print(json.dumps(stats, indent=1), sheet.shape)
