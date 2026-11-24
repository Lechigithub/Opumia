# How a film sets its words, measured from on-device OCR (macOS Vision, data/.cache/ocr/ocr), the same function on the
# channel's films and ours (owner, 2026-11-24: "why can't it see names, figure size or type style?").
# Per film, over frames that carry words (the channel's corner logo and 1-2 character boxes ignored):
#   textFrames   share of frames with words
#   bigText      median height of the largest line, share of frame height (huge figures and names)
#   wideText     median width of the widest line, share of frame width
#   smallBoxed   share of text frames whose words are small (< 6 % of height), in the lower 40 %, on a flat box
#                (lower-third name tags)
#   caps         share of lines (>= 4 letters) set in capitals
#   sizeSpread   spread of line heights across the film (std of log height): one size everywhere = template
#   python -I text-band.py <ours.mp4> [<ref-film-list.txt> <out.json>]
import json, sys, os, subprocess, tempfile, io
import numpy as np
from PIL import Image

OCR = os.path.join(os.getcwd(), "data", ".cache", "ocr", "ocr")
LOGO = ("magnates", "media")

def frames(f, n, span):
    d = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))
    d = min(d, span)
    tmp = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
    out = []
    for i in range(n):
        t = d * (0.02 + 0.96 * i / (n - 1))
        p = os.path.join(tmp, f"f{i:03d}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", f, "-frames:v", "1", "-vf", "scale=960:540", p])
        if os.path.exists(p): out.append(p)
    return out

def ocr(paths):
    rows = {}
    for i in range(0, len(paths), 40):
        r = subprocess.run([OCR, *paths[i:i + 40]], capture_output=True, text=True).stdout
        for l in r.splitlines():
            if l.strip():
                j = json.loads(l); rows[j["file"]] = j["boxes"]
    return rows

def flat_box(img, b):
    a = np.asarray(img.convert("L"), dtype=np.float32) / 255
    H, W = a.shape
    h = (b["y1"] - b["y0"]) * H
    x0, x1 = int(max(0, b["x0"] * W - h * 0.4)), int(min(W, b["x1"] * W + h * 0.4))
    y0, y1 = int(max(0, b["y0"] * H - h * 0.35)), int(min(H, b["y1"] * H + h * 0.35))
    ring = np.concatenate([a[y0:int(b["y0"] * H), x0:x1].ravel(), a[int(b["y1"] * H):y1, x0:x1].ravel()])
    return ring.size > 20 and ring.std() < 0.06 and abs(ring.mean() - 0.1) > 0.12  # flat and not just black

def film(f, n=60, span=600):
    ps = frames(f, n, span)
    rows = ocr(ps)
    tf, big, wide, boxed, capsN, capsY, heights = 0, [], [], 0, 0, 0, []
    for p in ps:
        bs = [b for b in rows.get(p, []) if len(b["text"].replace(" ", "")) >= 3 and not any(w in b["text"].lower() for w in LOGO)]
        # the corner bug: small boxes inside the outer 12 % corners
        bs = [b for b in bs if not ((b["x1"] < 0.15 or b["x0"] > 0.85) and (b["y1"] < 0.15 or b["y0"] > 0.85) and b["y1"] - b["y0"] < 0.05)]
        if not bs: continue
        tf += 1
        hs = [b["y1"] - b["y0"] for b in bs]
        big.append(max(hs)); wide.append(max(b["x1"] - b["x0"] for b in bs))
        heights += hs
        img = Image.open(p)
        if any(h < 0.06 and b["y0"] > 0.6 and flat_box(img, b) for b, h in zip(bs, hs)): boxed += 1
        for b in bs:
            letters = [c for c in b["text"] if c.isalpha()]
            if len(letters) >= 4:
                capsN += 1; capsY += all(c.isupper() for c in letters)
    md = lambda xs: float(np.median(xs)) if xs else 0.0
    return {"textFrames": tf / max(1, len(ps)), "bigText": md(big), "wideText": md(wide), "smallBoxed": boxed / max(1, tf),
            "caps": capsY / max(1, capsN), "sizeSpread": float(np.std(np.log(heights))) if len(heights) > 2 else 0.0}

ours = film(sys.argv[1], 60, 600)
if len(sys.argv) < 3:
    print(json.dumps(ours)); sys.exit(0)
K = list(ours)
refs = []
for l in open(sys.argv[2]):
    if l.strip():
        r = film(l.strip(), 60, float(os.environ.get("SPAN", 600))); refs.append(r); print(os.path.basename(os.path.dirname(l.strip()))[:40], {k: round(v, 3) for k, v in r.items()}, flush=True)
band = {k: {"p10": float(np.percentile([r[k] for r in refs], 10)), "median": float(np.median([r[k] for r in refs])), "p90": float(np.percentile([r[k] for r in refs], 90))} for k in K}
json.dump({"what": "text-band.py: OCR text measures over 60 frames of the first 600 s of every MagnatesMedia film", "films": len(refs), "band": band}, open(sys.argv[3], "w"), indent=1)
print("OURS", {k: round(v, 3) for k, v in ours.items()})
print("BAND", {k: {q: round(x, 3) for q, x in v.items()} for k, v in band.items()})
