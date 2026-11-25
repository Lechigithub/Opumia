"""World check (build list 6, B1/B2/B4): one film against the channel's bands and against every earlier film of ours.
Local only (on-device OCR + the reference index's SigLIP 2), no API.

  ~/lechi_tts/venv/bin/python -I apps/cli/src/dev/world/world_check.py <name> <film.mp4> <timed-script.json> [--len 70]

Measures, per film (cached in data/world-profile/films/<name>.npz so later films compare against it):
  - line fit with on-screen words blurred out: rank of each shot's own spoken line among the film's lines;
  - word look: SigLIP on crops of the on-screen words, nearest-crop both ways (20-crop samples) against every film;
  - pictures: SigLIP of the frames, nearest-frame both ways against every film.
Bands (data/world-profile/magnates-media/bands.json, measured on the channel's own films 2026-11-25):
  line fit p10 0.614; word look p90 0.664 (max 0.707); pictures first 70 s p90 0.698 (max 0.793).
A film passes when its line fit is at or above the channel's p10, and no earlier film of ours is closer than the
channel's p90 in word look or pictures (versions of the same film are skipped with --version-of).
Prints one JSON report; writes data/world-profile/films/<name>.json.
"""
import argparse, json, os, subprocess, sys, tempfile, glob
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("name"); ap.add_argument("film"); ap.add_argument("timed")
ap.add_argument("--len", type=float, default=70); ap.add_argument("--step", type=float, default=1.0)  # 1 s: steady to ±0.005 (2 s moved ±0.04)
ap.add_argument("--version-of", default="", help="comma list of our film names this is a version of (not compared)")
a = ap.parse_args()
ROOT = os.getcwd(); PY = sys.executable
OUT = os.path.join(ROOT, "data", "world-profile", "films"); os.makedirs(OUT, exist_ok=True)
BANDS = json.load(open(os.path.join(ROOT, "data", "world-profile", "magnates-media", "bands.json")))
OCR = os.path.join(ROOT, "data", ".cache", "ocr", "ocr")
EMBED = os.path.join(ROOT, "tools", "siglip", "embed.py")
from PIL import Image, ImageFilter

tmp = tempfile.mkdtemp(prefix="world-")
ts = [a.step * k + a.step / 2 for k in range(int(a.len // a.step))]
frames = []
for k, t in enumerate(ts):
    f = f"{tmp}/f{k}.jpg"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", a.film, "-frames:v", "1", "-vf", "scale=768:-2", "-pix_fmt", "yuvj420p", f])
    if os.path.exists(f): frames.append((t, f))
boxes = {}
r = subprocess.run([OCR, *[f for _, f in frames]], capture_output=True, text=True)
for l in r.stdout.splitlines():
    try: j = json.loads(l); boxes[j["file"]] = j["boxes"]
    except Exception: pass

items_full, items_mask, items_crop = [], [], []
for t, f in frames:
    im = Image.open(f).convert("RGB"); W, H = im.size; bl = im.filter(ImageFilter.GaussianBlur(28))
    bs = boxes.get(f, [])
    masked = im.copy()
    for b in bs:
        p = 0.012; box = (int(max(0, b["x0"] - p) * W), int(max(0, b["y0"] - p) * H), int(min(1, b["x1"] + p) * W), int(min(1, b["y1"] + p) * H))
        if box[2] > box[0] and box[3] > box[1]: masked.paste(bl.crop(box), box)
    mf = f.replace(".jpg", "_m.jpg"); masked.save(mf, quality=90)
    items_full.append({"file": f, "t": None}); items_mask.append({"file": mf, "t": None, "time": t})
    big = [b for b in bs if (b["x1"] - b["x0"]) * (b["y1"] - b["y0"]) > 0.002 and len(b["text"]) >= 3]
    if big:
        x0 = min(b["x0"] for b in big); y0 = min(b["y0"] for b in big); x1 = max(b["x1"] for b in big); y1 = max(b["y1"] for b in big)
        cf = f.replace(".jpg", "_c.jpg"); im.crop((int(max(0, x0 - .03) * W), int(max(0, y0 - .03) * H), int(min(1, x1 + .03) * W), int(min(1, y1 + .03) * H))).save(cf, quality=92)
        items_crop.append({"file": cf, "t": None})

def embed(items, name):
    if not items: return np.zeros((0, 1152), np.float32)
    p = f"{tmp}/{name}"
    subprocess.run([PY, "-I", EMBED, "--out", p], input="\n".join(json.dumps(i) for i in items), text=True, capture_output=True, check=True)
    e = np.fromfile(p + ".f16", dtype=np.float16).reshape(len(items), 1152).astype(np.float32)
    ok = np.fromfile(p + ".ok", dtype=np.uint8).astype(bool)
    return e[ok]

E_full, E_mask, E_crop = embed(items_full, "full"), embed(items_mask, "mask"), embed(items_crop, "crop")

# line fit (masked): words spoken within ±1.5 s of each frame
import torch
from transformers import AutoModel, GemmaTokenizerFast
M = "google/siglip2-so400m-patch14-384"
tok = GemmaTokenizerFast.from_pretrained(M, local_files_only=True); model = AutoModel.from_pretrained(M, local_files_only=True).eval()
words = [w for s in json.load(open(a.timed))["segments"] for w in s["words"]]
lines, ix = [], []
for k, it in enumerate(items_mask):
    ws = " ".join(w.get("text", w.get("word", "")) for w in words if it["time"] - 1.5 <= w["startS"] <= it["time"] + 1.5)
    if len(ws.split()) >= 4 and k < len(E_mask): lines.append(ws); ix.append(k)
b = tok(lines, padding="max_length", max_length=64, truncation=True, return_tensors="pt")
with torch.no_grad(): tf = model.get_text_features(**b)
tf = tf.pooler_output if hasattr(tf, "pooler_output") else tf
T = torch.nn.functional.normalize(tf, dim=-1).numpy()
P = E_mask[ix]; P = P / np.maximum(np.linalg.norm(P, axis=1, keepdims=True), 1e-6)
Sm = P @ T.T
fit = np.array([(Sm[k] < Sm[k, k]).mean() for k in range(len(P))])
weak = [{"t": items_mask[ix[k]]["time"], "line": lines[k], "fit": round(float(fit[k]), 2)} for k in np.argsort(fit)[:6]]

np.savez(os.path.join(OUT, f"{a.name}.npz"), full=E_full, crop=E_crop)
rng = np.random.default_rng(0)
def nn(A, B, n=20, reps=20):
    if len(A) < 6 or len(B) < 6: return None
    out = []
    for _ in range(reps):
        x = A[rng.choice(len(A), min(n, len(A)), replace=False)]; y = B[rng.choice(len(B), min(n, len(B)), replace=False)]
        S_ = x @ y.T; out.append((S_.max(1).mean() + S_.max(0).mean()) / 2)
    return round(float(np.mean(out)), 3)
def nnall(A, B):
    if not len(A) or not len(B): return None
    S_ = A @ B.T; return round(float((S_.max(1).mean() + S_.max(0).mean()) / 2), 3)

skip = {a.name, *[x for x in a.version_of.split(",") if x]}
others = []
for f in sorted(glob.glob(os.path.join(OUT, "*.npz"))):
    n = os.path.basename(f)[:-4]
    if n in skip: continue
    z = np.load(f)
    others.append({"film": n, "words": nn(E_crop, z["crop"]), "pictures": nnall(E_full, z["full"])})
wl, pl = BANDS["wordLook"]["p90"], BANDS["pictures70"]["p90"]
too_close = [o for o in others if (o["words"] or 0) > wl or (o["pictures"] or 0) > pl]
rep = {
    "film": a.name, "seconds": a.len, "frames": len(frames), "framesWithWords": len(items_crop),
    "lineFit": {"mean": round(float(fit.mean()), 3), "bottomQuarter": round(float((fit < 0.25).mean()), 3), "band": BANDS["lineFit"], "pass": bool(fit.mean() >= BANDS["lineFit"]["p10"]), "weakest": weak},
    "againstOurFilms": sorted(others, key=lambda o: -max(o["words"] or 0, o["pictures"] or 0)),
    "tooClose": too_close, "pass": bool(fit.mean() >= BANDS["lineFit"]["p10"]) and not too_close,
}
json.dump(rep, open(os.path.join(OUT, f"{a.name}.json"), "w"), indent=1)
print(json.dumps({k: v for k, v in rep.items() if k != "againstOurFilms"}, indent=1))
print("closest of ours:", rep["againstOurFilms"][:4])
