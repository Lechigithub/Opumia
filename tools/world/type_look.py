"""Type look: how a film sets its words on screen, compared with our earlier films against the channel's own spread
(2026-11-28). MoviePass came out a copy of the Juicero rebuild (same condensed capitals, same glow, same centred
caption with a small spaced line under it, every shot) and the SigLIP word look did not see it (0.63 against the
channel's p90 0.664). This reads the treatment itself from every on-screen word box (on-device OCR, no model):
size, position, letter width (condensed / spaced), capitals, colour, glow and a smaller line stacked under it.

  python -I tools/world/type_look.py build [--channel MagnatesMedia] [--films 30]   # channel bands (once)
  python -I tools/world/type_look.py save  <name> <film.mp4>                         # register a finished film of ours
  python -I tools/world/type_look.py check <name> (<film.mp4> | --frames a.jpg …) [--json]

Bands (data/world-profile/magnates-media/type-look.json): the distance between two of the channel's own films (both
ways, nearest box), and from a scene-sized window of one channel film to another whole film. A film or a scene of ours
is too close when it sits nearer to one of our earlier films than all but the closest 5 % of the channel's own pairs —
we may resemble each other exactly as much as the channel's films resemble each other, no more.
"""
import argparse, glob, json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image

ROOT = os.getcwd()
OCR = os.path.join(ROOT, "data", ".cache", "ocr", "ocr")
OUT = os.path.join(ROOT, "data", "world-profile", "films")
BANDF = os.path.join(ROOT, "data", "world-profile", "magnates-media", "type-look.json")
CACHE = os.path.join(ROOT, "data", ".cache", "type-look")
LOGO = ("magnates", "media")
FEATS = ["logH", "cx", "cy", "glyphW", "caps", "lum", "hueC", "hueS", "glow", "stacked"]

def dur(f): return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))

def grab(f, ts, tmp):
    out = []
    for i, t in enumerate(ts):
        p = os.path.join(tmp, f"f{i:03d}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", f, "-frames:v", "1", "-vf", "scale=960:540", p])
        if os.path.exists(p): out.append(p)
    return out

def ocr(paths):
    rows = {}
    for i in range(0, len(paths), 40):
        r = subprocess.run([OCR, *paths[i:i + 40]], capture_output=True, text=True).stdout
        for l in r.splitlines():
            try: j = json.loads(l); rows[j["file"]] = j["boxes"]
            except Exception: pass
    return rows

def box_feats(img, b, others):
    W, H = img.size
    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255
    x0, x1 = max(0, int(b["x0"] * W)), min(W, int(b["x1"] * W)); y0, y1 = max(0, int(b["y0"] * H)), min(H, int(b["y1"] * H))
    if x1 - x0 < 4 or y1 - y0 < 4: return None
    h = (b["y1"] - b["y0"])
    box = a[y0:y1, x0:x1].reshape(-1, 3)
    lum = box @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    med = np.median(lum)
    k = np.abs(lum - med); ink = box[k >= np.percentile(k, 85)]  # the letters: the pixels furthest from the box's median
    r, g, bb = ink.mean(0)
    mx, mn = max(r, g, bb), min(r, g, bb); sat = (mx - mn) / (mx + 1e-6)
    hue = np.arctan2(np.sqrt(3) * (g - bb), 2 * r - g - bb)
    ph = max(2, int((y1 - y0) * 0.5)); po = max(4, int((y1 - y0) * 1.2))
    def ring(p):
        ya, yb, xa, xb = max(0, y0 - p), min(H, y1 + p), max(0, x0 - p), min(W, x1 + p)
        m = np.ones((yb - ya, xb - xa), bool); m[y0 - ya:y1 - ya, x0 - xa:x1 - xa] = False
        return (a[ya:yb, xa:xb] @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[m]
    inner, outer = ring(ph), ring(po)
    glow = float(inner.mean() - outer.mean()) if inner.size and outer.size else 0.0
    letters = [c for c in b["text"] if c.isalpha()]
    n = max(1, len(b["text"].replace(" ", "")))
    cx = (b["x0"] + b["x1"]) / 2
    stacked = any((o["y1"] - o["y0"]) < 0.65 * h and 0 <= o["y0"] - b["y1"] < 1.3 * h and abs((o["x0"] + o["x1"]) / 2 - cx) < 0.12 for o in others) \
        or any((o["y1"] - o["y0"]) * 0.65 > h and 0 <= b["y0"] - o["y1"] < 1.3 * (o["y1"] - o["y0"]) and abs((o["x0"] + o["x1"]) / 2 - cx) < 0.12 for o in others)
    return [float(np.log(h)), float(cx), float((b["y0"] + b["y1"]) / 2), float((b["x1"] - b["x0"]) * W / (n * h * H)),
            float(sum(c.isupper() for c in letters) / len(letters)) if letters else 0.5, float((ink @ np.array([0.299, 0.587, 0.114], dtype=np.float32)).mean()),
            float(sat * np.cos(hue)), float(sat * np.sin(hue)), glow, float(stacked)]

def frame_boxes(paths):
    rows, out = ocr(paths), []
    for p in paths:
        bs = [b for b in rows.get(p, []) if len(b["text"].replace(" ", "")) >= 3 and not any(w in b["text"].lower() for w in LOGO)]
        bs = [b for b in bs if not ((b["x1"] < 0.15 or b["x0"] > 0.85) and (b["y1"] < 0.15 or b["y0"] > 0.85) and b["y1"] - b["y0"] < 0.05)]
        if not bs: continue
        img = Image.open(p)
        fs = [f for f in (box_feats(img, b, [o for o in bs if o is not b]) for b in bs) if f]
        if fs: out.append(fs)
    return out  # per frame with words: its boxes' features

def film_boxes(film, t0=0.0, t1=None, n=60):
    tmp = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
    d = dur(film); t1 = min(d, t1 or d)
    ts = [t0 + (t1 - t0) * (0.02 + 0.96 * i / (n - 1)) for i in range(n)]
    return frame_boxes(grab(film, ts, tmp))

def norm(X, sd): return np.asarray(X, dtype=np.float32) / sd

def one_way(A, B):
    """mean over A's boxes of the distance to B's nearest box"""
    if not len(A) or not len(B): return None
    d = np.sqrt(((A[:, None, :] - B[None, :, :]) ** 2).sum(-1))
    return float(d.min(1).mean())

def both(A, B):
    x, y = one_way(A, B), one_way(B, A)
    return None if x is None or y is None else (x + y) / 2

def flat(frames): return [f for fr in frames for f in fr]

def build(a):
    ch = os.path.join(ROOT, "Reference", a.channel)
    held = set()
    try: held = {h.split("-")[-1][:8] for h in json.load(open(os.path.join(ROOT, "data", "referee", "magnates-media.json"))).get("holdout", [])}
    except Exception: pass
    films = sorted(glob.glob(os.path.join(ch, "*", "*.mp4")))[: a.films]
    os.makedirs(CACHE, exist_ok=True)
    per = {}
    for i, f in enumerate(films):
        key = os.path.join(CACHE, os.path.basename(os.path.dirname(f))[:8] + ".json")
        if os.path.exists(key): per[f] = json.load(open(key))
        else:
            per[f] = film_boxes(f, 30.0, 150.0, 60); json.dump(per[f], open(key, "w"))
        print(f"\r  channel films measured {i + 1}/{len(films)}", end="", flush=True)
    print()
    allb = np.array(flat([fr for v in per.values() for fr in v]), dtype=np.float32)
    sd = allb.std(0) + 1e-3
    keys = [f for f in films if len(flat(per[f])) >= 8]
    F = {f: norm(flat(per[f]), sd) for f in keys}
    pairs, wins = [], []
    rng = np.random.default_rng(7)
    for i, f in enumerate(keys):
        for g in keys[i + 1:]:
            pairs.append(both(F[f], F[g]))
        # scene-sized windows: 3 consecutive text frames of this film against each other channel film
        fr = per[f]
        for s in range(0, max(1, len(fr) - 2), 3):
            W = norm(flat(fr[s:s + 3]), sd)
            for g in rng.choice([k for k in keys if k != f], size=min(6, len(keys) - 1), replace=False):
                wins.append(one_way(W, F[g]))
    pairs = [p for p in pairs if p is not None]; wins = [w for w in wins if w is not None]
    band = {"channel": a.channel, "films": len(keys), "feats": FEATS, "sd": sd.tolist(),
            "film": {"p05": float(np.percentile(pairs, 5)), "p10": float(np.percentile(pairs, 10)), "p50": float(np.percentile(pairs, 50)), "min": float(min(pairs))},
            "window": {"p05": float(np.percentile(wins, 5)), "p10": float(np.percentile(wins, 10)), "p50": float(np.percentile(wins, 50))},
            "how": "distance in channel-normalised type features (size, position, letter width, capitals, colour, glow, stacked line); film: both ways nearest box; window: 3 text frames one way to a whole film"}
    os.makedirs(os.path.dirname(BANDF), exist_ok=True)
    json.dump(band, open(BANDF, "w"), indent=1)
    print(json.dumps({k: band[k] for k in ("films", "film", "window")}))

def ours():
    out = {}
    for p in glob.glob(os.path.join(OUT, "*.type.json")):
        out[os.path.basename(p)[:-len(".type.json")]] = json.load(open(p))
    return out

def save(a):
    fr = film_boxes(a.film)
    os.makedirs(OUT, exist_ok=True)
    json.dump(fr, open(os.path.join(OUT, f"{a.name}.type.json"), "w"))
    print(f"saved {a.name}: {len(fr)} frames with words, {len(flat(fr))} word boxes")

def check(a):
    band = json.load(open(BANDF)); sd = np.array(band["sd"], dtype=np.float32)
    if a.frames:
        tmp = tempfile.mkdtemp(dir=os.environ.get("TMPDIR")); ps = []
        for i, f in enumerate(a.frames):
            p = os.path.join(tmp, f"s{i:03d}.png"); subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-vf", "scale=960:540", p])
            if os.path.exists(p): ps.append(p)
        fr = frame_boxes(ps); mode, bar = "window", band["window"]["p05"]
    else:
        fr = film_boxes(a.film); mode, bar = "film", band["film"]["p05"]
    A = norm(flat(fr), sd)
    rows = []
    for name, other in ours().items():
        if name == a.name or name in (a.version_of or "").split(","): continue
        B = norm(flat(other), sd)
        d = one_way(A, B) if mode == "window" else both(A, B)
        if d is not None: rows.append({"film": name, "distance": round(d, 3)})
    rows.sort(key=lambda r: r["distance"])
    close = [r for r in rows if r["distance"] < bar]
    rep = {"name": a.name, "mode": mode, "boxes": int(len(A)), "bar": round(bar, 3), "channelMedian": round(band[mode]["p50"], 3), "nearest": rows[:5], "tooClose": close, "pass": not close}
    if a.json: print(json.dumps(rep))
    else:
        print(f"type look ({mode}, {len(A)} word boxes): nearest of ours {rows[0] if rows else '—'}; the channel's own films sit ≥ {bar:.3f} apart (median {band[mode]['p50']:.3f})")
        print("PASS" if not close else "TOO CLOSE to " + ", ".join(f"{r['film']} ({r['distance']})" for r in close))

ap = argparse.ArgumentParser()
sp = ap.add_subparsers(dest="cmd", required=True)
b = sp.add_parser("build"); b.add_argument("--channel", default="MagnatesMedia"); b.add_argument("--films", type=int, default=30)
s = sp.add_parser("save"); s.add_argument("name"); s.add_argument("film")
c = sp.add_parser("check"); c.add_argument("name"); c.add_argument("film", nargs="?"); c.add_argument("--frames", nargs="*", default=[]); c.add_argument("--version-of", default=""); c.add_argument("--json", action="store_true")
a = ap.parse_args()
{"build": build, "save": save, "check": check}[a.cmd](a)
