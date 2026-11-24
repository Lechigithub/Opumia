# Does a film live in one visual world? (owner, 2026-11-24: "the film you created is clearly not at the style
# reference quality"; by eye the real films hold one grade and one accent colour, ours was a patchwork).
# Per sampled frame: the colour family that carries it (saturation-weighted hue histogram over 12 families of 30°),
# or "mono" when under 6 % of the frame is saturated colour. Per film:
#   coherence   share of frames that are mono or in the film's two main families (±1 family)
#   familiesUsed number of families carrying at least 8 % of the coloured frames
#   monoShare   share of frames that are mono
#   python -I coherence.py <film.mp4> [<ref list> <out.json>]
import json, sys, subprocess, io
import numpy as np
from PIL import Image
def frames(f, n=60, span=90):
    d = min(span, float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])))
    for i in range(n):
        b = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{d * (0.02 + 0.96 * i / (n - 1)):.2f}", "-i", f, "-frames:v", "1", "-vf", "scale=160:90", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True).stdout
        if b: yield np.asarray(Image.open(io.BytesIO(b)).convert("RGB"), dtype=np.float32) / 255
def family(a):
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 0.08, (mx - mn) / np.maximum(mx, 1e-3), 0)
    m = (sat > 0.3) & (mx > 0.15)
    if m.mean() < 0.06: return "mono"
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    hue = (np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) + 360) % 360
    h = np.bincount((hue[m] // 30).astype(int), weights=sat[m], minlength=12)
    return int(np.argmax(h))
def concentration(a):
    # how close a frame is to one hue: length of the saturation-weighted mean hue vector (1 = one hue, 0 = scattered)
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 0.08, (mx - mn) / np.maximum(mx, 1e-3), 0)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    hue = np.radians((np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) + 360) % 360)
    w = sat.sum()
    if w < 1e-6 or (sat > 0.15).mean() < 0.02: return 1.0  # monochrome counts as fully concentrated
    return float(np.hypot((sat * np.cos(hue)).sum(), (sat * np.sin(hue)).sum()) / w)
def film(f, n=60, span=90):
    fr = list(frames(f, n, span))
    conc = float(np.median([concentration(a) for a in fr]))
    fam = [family(a) for a in fr]
    col = [x for x in fam if x != "mono"]
    mono = 1 - len(col) / max(1, len(fam))
    if not col: return {"coherence": 1.0, "familiesUsed": 0, "monoShare": mono, "hueConcentration": conc}
    cnt = np.bincount(col, minlength=12)
    top = list(np.argsort(cnt)[::-1][:2])
    near = lambda x: any(min((x - t) % 12, (t - x) % 12) <= 1 for t in top)
    coh = sum(1 for x in fam if x == "mono" or near(x)) / len(fam)
    return {"coherence": float(coh), "familiesUsed": int((cnt / len(col) >= 0.08).sum()), "monoShare": float(mono), "hueConcentration": conc}
ours = film(sys.argv[1])
if len(sys.argv) < 3:
    print(json.dumps(ours)); sys.exit(0)
refs = [film(l.strip()) for l in open(sys.argv[2]) if l.strip()]
band = {k: {"p10": float(np.percentile([r[k] for r in refs], 10)), "median": float(np.median([r[k] for r in refs])), "p90": float(np.percentile([r[k] for r in refs], 90))} for k in ours}
json.dump({"what": "coherence.py over the first 90 s of every MagnatesMedia film (60 frames each)", "films": len(refs), "band": band}, open(sys.argv[3], "w"), indent=1)
print("OURS", ours); print("BAND", band)
