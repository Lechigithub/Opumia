# How alike a film's own shots look to each other: a template film repeats one look (the same card, the same cut-out
# device, the same backdrop) from shot to shot; the channel's films change picture as the story moves.
# Measured on SigLIP picture embeddings, no model call: the channel's shots from data/reference-index (first --len s of
# every MagnatesMedia film), ours from data/world-profile/films/<name>.npz (one frame a second, written by world_check).
# Only pairs at least --gap s apart count, so one long shot is not compared with itself.
#   sameness   mean cosine of those pairs
#   repeats    share of those pairs that look nearly the same picture (cos > --dup)
#   python -I tools/world/self_sameness.py [--band] [name …] [--json]
import argparse, json, os, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("names", nargs="*"); ap.add_argument("--band", action="store_true", help="rebuild the channel band")
ap.add_argument("--len", type=float, default=70); ap.add_argument("--gap", type=float, default=8); ap.add_argument("--dup", type=float, default=0.85)
ap.add_argument("--channel", default="magnates-media"); ap.add_argument("--json", action="store_true")
a = ap.parse_args()
ROOT = os.getcwd()
BAND = os.path.join(ROOT, "data", "world-profile", a.channel, "self-sameness.json")

def stats(E, T):
    E = E / np.maximum(np.linalg.norm(E, axis=1, keepdims=True), 1e-6)
    S = E @ E.T; far = np.abs(T[:, None] - T[None, :]) >= a.gap
    iu = np.triu(np.ones_like(S, dtype=bool), 1) & far
    v = S[iu]
    if not len(v): return None
    return {"sameness": round(float(v.mean()), 4), "repeats": round(float((v > a.dup).mean()), 4), "pairs": int(len(v))}

def band():
    d = os.path.join(ROOT, "data", "reference-index")
    rows = [json.loads(l) for l in open(os.path.join(d, "shots.jsonl"))]
    X = np.fromfile(os.path.join(d, "shots.f16"), dtype=np.float16).reshape(len(rows), 1152).astype(np.float32)
    ok = np.fromfile(os.path.join(d, "shots.ok"), dtype=np.uint8).astype(bool)
    by = {}
    for k, r in enumerate(rows):
        if r["channel"] != a.channel or not ok[k] or r["t0"] >= a.len: continue
        by.setdefault(r["film"], []).append((k, (r["t0"] + r["t1"]) / 2))
    films = {}
    for f, ks in by.items():
        if len(ks) < 6: continue
        s = stats(X[[k for k, _ in ks]], np.array([t for _, t in ks]))
        if s: films[f] = s
    q = lambda key, p: round(float(np.percentile([v[key] for v in films.values()], p)), 4)
    out = {"what": "self_sameness.py: mean cosine of a film's shots at least gap s apart (first len s), and the share of near-duplicate pairs",
           "len": a.len, "gap": a.gap, "dup": a.dup, "films": len(films),
           "sameness": {"p10": q("sameness", 10), "p50": q("sameness", 50), "p90": q("sameness", 90), "max": q("sameness", 100)},
           "repeats": {"p10": q("repeats", 10), "p50": q("repeats", 50), "p90": q("repeats", 90), "max": q("repeats", 100)},
           "perFilm": films}
    os.makedirs(os.path.dirname(BAND), exist_ok=True); json.dump(out, open(BAND, "w"), indent=1)
    return out

B = band() if a.band or not os.path.exists(BAND) else json.load(open(BAND))
res = {}
for n in a.names:
    z = np.load(os.path.join(ROOT, "data", "world-profile", "films", f"{n}.npz"))
    E = z["full"]; T = np.arange(len(E)) + 0.5
    keep = T < a.len
    s = stats(E[keep], T[keep])
    if s:
        s["pass"] = s["sameness"] <= B["sameness"]["p90"] and s["repeats"] <= B["repeats"]["p90"]
        res[n] = s
if a.json: print(json.dumps({"band": {k: B[k] for k in ("sameness", "repeats", "films")}, "films": res}))
else:
    print(f"channel ({B['films']} films): sameness p10 {B['sameness']['p10']} / p50 {B['sameness']['p50']} / p90 {B['sameness']['p90']} (max {B['sameness']['max']}); repeats p50 {B['repeats']['p50']} / p90 {B['repeats']['p90']} (max {B['repeats']['max']})")
    for n, s in res.items(): print(f"  {n:14s} sameness {s['sameness']}  repeats {s['repeats']}  {'inside' if s['pass'] else 'OUTSIDE'} the channel's band")
