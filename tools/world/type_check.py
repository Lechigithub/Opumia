# How a film sets its words, against the channel's own films (build list 6, Wirecard v6 → v7, 2026-11-26).
# Owner on v6: "still looks like a template, the use of cards is too much, and repetition". Measured: v6 put words on
# small flat boxes on 0.26 of its text frames (channel p90 0.14), set them all at one size (spread 0.46, channel p10 0.56),
# almost never in capitals (0.09, p10 0.20), and carried words on 0.88 of frames (p90 0.74); v7 (words set into footage)
# 0.04 / 0.68 / 0.72 / 0.83. Same OCR measures as apps/cli/src/dev/hand/text-band.py (on-device, no model call).
#   python -I tools/world/type_check.py film.mp4 [--clips clips.json] [--frames a.jpg b.jpg …] [--channel magnates-media] [--json]
# --clips: the judge's preview stretches ([{file, fromS, len}]); --frames: still previews (the scene designer's own).
import argparse, json, os, subprocess, tempfile
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("film", nargs="?"); ap.add_argument("--clips", default=""); ap.add_argument("--frames", nargs="*", default=[])
ap.add_argument("--channel", default="magnates-media"); ap.add_argument("--n", type=int, default=60); ap.add_argument("--json", action="store_true")
a = ap.parse_args()
ROOT = os.getcwd()
OCR = os.path.join(ROOT, "data", ".cache", "ocr", "ocr")
LOGO = ("magnates", "media")

def grab(f, ts, tmp, tag):
    out = []
    for i, t in enumerate(ts):
        p = os.path.join(tmp, f"{tag}{i:03d}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", f, "-frames:v", "1", "-vf", "scale=960:540", p])
        if os.path.exists(p): out.append(p)
    return out

def dur(f): return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))

tmp = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
if a.frames:
    ps, span = a.frames, 0.0
elif a.clips:
    cl = json.load(open(a.clips)); tot = sum(c["len"] for c in cl); ps = []; span = tot
    for k, c in enumerate(cl):
        m = max(2, round(a.n * c["len"] / max(tot, 1e-6)))
        ps += grab(c["file"], [c["len"] * (0.03 + 0.94 * i / (m - 1)) for i in range(m)], tmp, f"c{k}_")
else:
    d = min(dur(a.film), 600); span = d
    ps = grab(a.film, [d * (0.02 + 0.96 * i / (a.n - 1)) for i in range(a.n)], tmp, "f")

def ocr(paths):
    rows = {}
    for i in range(0, len(paths), 40):
        r = subprocess.run([OCR, *paths[i:i + 40]], capture_output=True, text=True).stdout
        for l in r.splitlines():
            if l.strip():
                try: j = json.loads(l); rows[j["file"]] = j["boxes"]
                except Exception: pass
    return rows

def flat_box(img, b):
    g = np.asarray(img.convert("L").resize((960, 540)), dtype=np.float32) / 255
    H, W = g.shape; h = (b["y1"] - b["y0"]) * H
    x0, x1 = int(max(0, b["x0"] * W - h * 0.4)), int(min(W, b["x1"] * W + h * 0.4))
    y0, y1 = int(max(0, b["y0"] * H - h * 0.35)), int(min(H, b["y1"] * H + h * 0.35))
    ring = np.concatenate([g[y0:int(b["y0"] * H), x0:x1].ravel(), g[int(b["y1"] * H):y1, x0:x1].ravel()])
    return ring.size > 20 and ring.std() < 0.06 and abs(ring.mean() - 0.1) > 0.12  # flat and not just black

rows = ocr(ps)
tf, big, wide, boxed, capsN, capsY, heights, boxedAny = 0, [], [], 0, 0, 0, [], 0
for p in ps:
    bs = [b for b in rows.get(p, []) if len(b["text"].replace(" ", "")) >= 3 and not any(w in b["text"].lower() for w in LOGO)]
    bs = [b for b in bs if not ((b["x1"] < 0.15 or b["x0"] > 0.85) and (b["y1"] < 0.15 or b["y0"] > 0.85) and b["y1"] - b["y0"] < 0.05)]
    if not bs: continue
    tf += 1
    hs = [b["y1"] - b["y0"] for b in bs]
    big.append(max(hs)); wide.append(max(b["x1"] - b["x0"] for b in bs)); heights += hs
    img = Image.open(p)
    if any(h < 0.06 and b["y0"] > 0.6 and flat_box(img, b) for b, h in zip(bs, hs)): boxed += 1
    for b in bs:
        letters = [c for c in b["text"] if c.isalpha()]
        if len(letters) >= 4: capsN += 1; capsY += all(c.isupper() for c in letters)
md = lambda xs: float(np.median(xs)) if xs else 0.0
m = {"frames": len(ps), "textFrames": tf / max(1, len(ps)), "bigText": md(big), "wideText": md(wide), "smallBoxed": boxed / max(1, tf),
     "caps": capsY / max(1, capsN), "sizeSpread": float(np.std(np.log(heights))) if len(heights) > 2 else 0.0}

qp = os.path.join(ROOT, "data", "quality-profile")
bf = os.path.join(qp, f"{a.channel}-text-band-80s.json") if 0 < span <= 150 and os.path.exists(os.path.join(qp, f"{a.channel}-text-band-80s.json")) else os.path.join(qp, f"{a.channel}-text-band.json")
band = json.load(open(bf))["band"] if os.path.exists(bf) else {}
# the template tells: words on small flat boxes too often, one type size everywhere, words on too many frames
rules = {"smallBoxed": ("max", "p90"), "sizeSpread": ("min", "p10"), "textFrames": ("max", "p90"), "caps": ("min", "p10")}
verdict = {}
for k, (side, q) in rules.items():
    if k not in band: continue
    lim = band[k][q]
    ok = m[k] <= lim if side == "max" else m[k] >= lim
    if a.frames and k == "textFrames": ok = True  # still previews are chosen to show the words: their share means nothing
    if m["textFrames"] == 0 and k != "textFrames": ok = True
    verdict[k] = {"value": round(m[k], 3), "limit": round(lim, 3), "side": side, "median": round(band[k]["median"], 3), "pass": bool(ok)}
out = {"measures": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in m.items()}, "band": os.path.basename(bf), "verdict": verdict, "pass": all(v["pass"] for v in verdict.values())}
if a.json: print(json.dumps(out))
else:
    for k, v in verdict.items(): print(f"{k:11s} {v['value']:>6}  {'≤' if v['side'] == 'max' else '≥'} {v['limit']} (channel median {v['median']})  {'ok' if v['pass'] else 'OUTSIDE'}")
