# Per-film grade band of the channel (every MagnatesMedia film, 40 frames each) and one film of ours, same function.
# sat, luma, contrast (p95-p5), hi (share > 0.85 luma), oneColour (share of frames carried by one hue family:
# >= 50 % of all pixels saturated pixels of one 30-degree family).
#   python -I grade-band.py <ours.mp4> <ref-file-list.txt>
import json, sys, subprocess, io
import numpy as np
from PIL import Image
def frames(f, n=40):
    d = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))
    for i in range(n):
        t = d * (0.03 + 0.94 * i / (n - 1))
        b = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", f, "-frames:v", "1", "-vf", "scale=320:180", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True).stdout
        if b: yield np.asarray(Image.open(io.BytesIO(b)).convert("RGB"), dtype=np.float32) / 255
def look(a):
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 0.04, (mx - mn) / np.maximum(mx, 1e-3), 0)
    y = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    hue = (np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) + 360) % 360
    m = (sat > 0.35) & (mx > 0.15)
    fam = np.bincount((hue[m] // 30).astype(int), minlength=12) / m.size if m.any() else np.zeros(12)
    return [sat.mean(), y.mean(), np.percentile(y, 95) - np.percentile(y, 5), (y > 0.85).mean(), float(fam.max() >= 0.5)]
K = ["sat", "luma", "contrast", "hi", "oneColour"]
def film(f, n=40):
    v = np.array([look(a) for a in frames(f, n)])
    return {k: float(np.median(v[:, i])) if k != "oneColour" else float(v[:, i].mean()) for i, k in enumerate(K)}
ours = film(sys.argv[1], 60)
if len(sys.argv) < 3:  # ours only (the ratchet)
    print(json.dumps(ours)); sys.exit(0)
refs = [film(l.strip()) for l in open(sys.argv[2]) if l.strip()]
out = {"ours": ours, "channel": {k: {"p10": float(np.percentile([r[k] for r in refs], 10)), "median": float(np.median([r[k] for r in refs])), "p90": float(np.percentile([r[k] for r in refs], 90))} for k in K}, "films": len(refs)}
print(json.dumps(out, indent=1))
