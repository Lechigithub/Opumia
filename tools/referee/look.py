# The referee's look measures (2026-11-26): the same function on the channel's stretches and ours, no model.
#   python -I look.py <items.json> <out.json>
# items: [{"id", "video", "from", "to"}]; six frames per stretch (masked corners: the channel's logo bug is not style).
# Per stretch: brightness, contrast, dark share, saturation, colourfulness, grain, sharpness, vignette, warmth.
import json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageFilter

items = json.load(open(sys.argv[1]))
tmp = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))

def frames(video, a, b, n=6):
    out = []
    for i in range(n):
        t = a + (b - a) * (0.08 + 0.84 * i / (n - 1))
        p = os.path.join(tmp, f"f{i}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1", "-vf", "scale=640:360", p])
        if os.path.exists(p):
            out.append(np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) / 255.0)
            os.remove(p)
    return out

def mask(img):
    h, w, _ = img.shape
    keep = np.ones((h, w), bool)
    keep[int(h * 0.80):, : int(w * 0.22)] = False  # bottom-left bug
    keep[: int(h * 0.14), int(w * 0.80):] = False  # top-right bug
    return keep

def feats(img):
    k = mask(img)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    yk = y[k]
    mx, mn = img.max(2), img.min(2)
    sat = np.where(mx > 1e-3, (mx - mn) / np.maximum(mx, 1e-3), 0)[k]
    rg, yb = (r - g)[k], (0.5 * (r + g) - b)[k]
    colourful = np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
    pil = Image.fromarray((y * 255).astype(np.uint8))
    med = np.asarray(pil.filter(ImageFilter.MedianFilter(3)), dtype=np.float32) / 255.0
    resid = (y - med)[k]
    # grain: residual noise where the picture is locally flat (texture, not edges)
    gx = np.abs(np.diff(med, axis=1, append=med[:, -1:]))[k]
    flat = gx < np.percentile(gx, 40)
    grain = float(resid[flat].std()) if flat.any() else 0.0
    lap = np.asarray(pil.filter(ImageFilter.FIND_EDGES), dtype=np.float32)[k] / 255.0
    h, w = y.shape
    c = y[int(h * 0.3): int(h * 0.7), int(w * 0.3): int(w * 0.7)].mean()
    edge = np.concatenate([y[: int(h * 0.12)].ravel(), y[int(h * 0.88):].ravel(), y[:, : int(w * 0.08)].ravel(), y[:, int(w * 0.92):].ravel()]).mean()
    return {
        "luma": float(yk.mean()),
        "contrast": float(np.percentile(yk, 95) - np.percentile(yk, 5)),
        "dark": float((yk < 0.15).mean()),
        "sat": float(sat.mean()),
        "colourful": float(colourful),
        "grain": grain,
        "sharp": float(lap.var()),
        "vignette": float(c - edge),
        "warm": float((r - b)[k].mean()),
    }

res = {}
for it in items:
    fs = frames(it["video"], float(it["from"]), float(it["to"]))
    if not fs:
        continue
    fv = [feats(f) for f in fs]
    res[it["id"]] = {k: float(np.median([x[k] for x in fv])) for k in fv[0]}
json.dump(res, open(sys.argv[2], "w"))
print(f"look: {len(res)} of {len(items)} stretches measured")
