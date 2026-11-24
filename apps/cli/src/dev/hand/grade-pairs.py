# Grade of each of our shots against its content-matched MagnatesMedia shots (side-by-side/pairs.json frames).
# Same function on both: mean saturation, mean luma, contrast (p95-p5 luma), share of pixels above 0.85 luma.
import json, sys, os
import numpy as np
from PIL import Image
d = sys.argv[1]
pairs = json.load(open(os.path.join(d, "pairs.json")))
def look(f):
    a = np.asarray(Image.open(f).convert("RGB"), dtype=np.float32) / 255
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 0.04, (mx - mn) / np.maximum(mx, 1e-3), 0)
    y = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    h, w = y.shape
    edge = np.concatenate([y[: h // 8].ravel(), y[-h // 8 :].ravel(), y[:, : w // 10].ravel(), y[:, -w // 10 :].ravel()])
    return dict(sat=float(sat.mean()), luma=float(y.mean()), contrast=float(np.percentile(y, 95) - np.percentile(y, 5)), hi=float((y > 0.85).mean()), edge=float(edge.mean() / max(y.mean(), 1e-3)))
rows = []
for p in pairs:
    me = look(os.path.join(d, "frames", f"{p['shot']}.jpg"))
    rs = [look(os.path.join(d, "frames", f"{p['shot']}_{n['ref'].replace(':', '_').replace('-', '_')}.jpg")) for n in p["nearest"]]
    rm = {k: float(np.median([r[k] for r in rs])) for k in me}
    rows.append((p["shot"], me, rm))
    print(p["shot"], " ".join(f"{k} {me[k]:.2f}/{rm[k]:.2f}" for k in me))
print("MEDIAN ours/real:", " ".join(f"{k} {np.median([r[1][k] for r in rows]):.3f}/{np.median([r[2][k] for r in rows]):.3f}" for k in rows[0][1]))
print("shots where ours is more saturated than its matches by >0.08:", sum(r[1]['sat'] - r[2]['sat'] > 0.08 for r in rows), "of", len(rows))
print("shots brighter by >0.06:", sum(r[1]['luma'] - r[2]['luma'] > 0.06 for r in rows))
