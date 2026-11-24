# Type as type (owner, 2026-11-24): every line of words on sampled frames, found by on-device OCR, cut out and reduced
# to its letter shapes (a white-on-black mask, so the footage behind and the colour are gone), with the properties
# that make a typeface look the way it does:
#   stroke   stroke thickness / line height (heavy display caps ≈ 0.15+, light type ≈ 0.06)
#   ink      share of the line's box covered by letters
#   aspect   letter width / line height (condensed < 0.5, wide > 0.65)
#   caps     the line is set in capitals
# The masks feed the type-only scorer (type-style.ts). Same function on every channel and on our film.
#   python -I type-crops.py <out-dir> <frames-per-film> <label>=<film.mp4> …   or   <out-dir> <n> @<list.tsv>
import json, sys, os, subprocess, tempfile
import numpy as np
from PIL import Image
from scipy import ndimage

OCR = os.path.join(os.getcwd(), "data", ".cache", "ocr", "ocr")
LOGO = ("magnates", "media", "moon", "logically", "modern mba", "how money works")
out_dir, N = sys.argv[1], int(sys.argv[2])
items = []
for a in sys.argv[3:]:
    if a.startswith("@"):
        items += [tuple(l.rstrip("\n").split("\t")) for l in open(a[1:]) if l.strip()]
    else:
        k, f = a.split("=", 1); items.append(("ours", k, f))
os.makedirs(out_dir, exist_ok=True)
rows_out = open(os.path.join(out_dir, "crops.jsonl"), "a")
done = {json.loads(l)["film"] for l in open(os.path.join(out_dir, "crops.jsonl"))} if os.path.getsize(os.path.join(out_dir, "crops.jsonl")) else set()

def otsu(g):
    h, _ = np.histogram(g, 64, (0, 1)); p = h / max(1, h.sum()); w = np.cumsum(p); m = np.cumsum(p * np.arange(64)); mt = m[-1]
    s = (mt * w - m) ** 2 / np.maximum(w * (1 - w), 1e-9); return (np.argmax(s) + 0.5) / 64

def mask_of(img, b):
    W, H = img.size
    h = (b["y1"] - b["y0"]) * H
    x0, x1 = max(0, int(b["x0"] * W - h * 0.1)), min(W, int(b["x1"] * W + h * 0.1))
    y0, y1 = max(0, int(b["y0"] * H - h * 0.06)), min(H, int(b["y1"] * H + h * 0.06))
    if x1 - x0 < 8 or y1 - y0 < 8: return None
    # brightness of the strongest colour channel: a gold or red gradient fill stays one class (grey luma splits it)
    g = np.asarray(img.crop((x0, y0, x1, y1)).convert("RGB"), dtype=np.float32).max(2) / 255
    t = otsu(g); m = g > t
    border = np.concatenate([m[0], m[-1], m[:, 0], m[:, -1]])
    if border.mean() > 0.5: m = ~m  # letters are the class that keeps off the border
    lab, n = ndimage.label(m)
    if n == 0: return None
    # drop specks and anything touching the border (background leaking in)
    keep = np.zeros(n + 1, bool)
    sizes = ndimage.sum(m, lab, range(n + 1))
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    sl = ndimage.find_objects(lab)
    for i in range(1, n + 1):
        ys, xs = sl[i - 1]
        big = (ys.stop - ys.start) > 0.8 * m.shape[0] or (xs.stop - xs.start) > 0.6 * m.shape[1]
        keep[i] = sizes[i] > m.size * 0.002 and not (i in edge and big and sizes[i] > m.size * 0.25)  # only big background blobs
    m = keep[lab]
    return m if m.mean() > 0.03 else None

def film(label, name, f):
    d = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))
    d = min(d, 600)
    tmp = tempfile.mkdtemp()
    ps, tof = [], {}
    for i in range(N):
        p = os.path.join(tmp, f"f{i:03d}.png")
        t = d * (0.02 + 0.96 * i / max(1, N - 1))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", f, "-frames:v", "1", "-vf", "scale=1280:720", p])
        if os.path.exists(p): ps.append(p); tof[p] = round(t, 2)
    boxes = {}
    for i in range(0, len(ps), 40):
        for l in subprocess.run([OCR, *ps[i:i + 40]], capture_output=True, text=True).stdout.splitlines():
            if l.strip(): j = json.loads(l); boxes[j["file"]] = j["boxes"]
    fd = os.path.join(out_dir, name); os.makedirs(fd, exist_ok=True)
    k = 0
    for p in ps:
        img = Image.open(p)
        for b in boxes.get(p, []):
            txt = b["text"].strip(); chars = len(txt.replace(" ", ""))
            if chars < 3 or b["y1"] - b["y0"] < 0.03 or any(w in txt.lower() for w in LOGO): continue
            if (b["x1"] < 0.15 or b["x0"] > 0.85) and (b["y1"] < 0.15 or b["y0"] > 0.85) and b["y1"] - b["y0"] < 0.05: continue
            m = mask_of(img, b)
            if m is None: continue
            hp = m.shape[0]
            dt = ndimage.distance_transform_edt(m)
            letters = [c for c in txt if c.isalpha()]
            row = {"film": name, "channel": label, "t": tof[p], "text": txt, "h": round(b["y1"] - b["y0"], 4),
                   "stroke": round(float(2 * np.percentile(dt[m], 90) / hp), 4), "ink": round(float(m.mean()), 4),
                   "aspect": round(float(m.shape[1] / (chars * hp)), 4), "caps": bool(len(letters) >= 3 and all(c.isupper() for c in letters))}
            # the mask the scorer sees: letters only, white on black, height 96, on a 384×384 canvas
            s = 96 / hp; w = min(368, max(8, int(m.shape[1] * s))); hh = min(368, int(hp * min(s, 368 / max(1, m.shape[1]))))
            g = Image.fromarray((m * 255).astype(np.uint8)).resize((w, max(8, hh)), Image.LANCZOS)
            can = Image.new("L", (384, 384), 0); can.paste(g, ((384 - g.size[0]) // 2, (384 - g.size[1]) // 2))
            mf = os.path.join(fd, f"{k:04d}.png"); can.convert("RGB").save(mf); row["mask"] = mf; k += 1
            rows_out.write(json.dumps(row) + "\n")
    rows_out.flush()
    print(label, name, k, "lines", flush=True)

for label, name, f in items:
    if name in done and label != "ours": continue
    film(label, name, f)
