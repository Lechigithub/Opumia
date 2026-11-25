# Zero template share (owner, 2026-11-24): "every film designed from scratch without sharing anything with any other
# film; even the same film produced twice with the same script and voiceover should never look similar; only the
# reference style should be similar". A new film against EVERY earlier film or version, the same topic included.
# Each measure is reported as excess over chance: the same comparison with the other film shifted in time (what two
# unrelated films on the same narration would share by accident).
#   pictures   share of A's screen time showing a source picture or clip B also used (by source URL/ref)
#   cuts       share of A's cuts within 0.3 s of one of B's cuts
#   devices    share of A's time where B, at the same moment, uses the same device (backdrop/world kind + the set of
#              element kinds and kit components)
#   frames     share of A's seconds whose frame looks like B's frame at the same second (coarse layout correlation
#              > 0.6 and colour histogram intersection > 0.7)
#   python -I likeness.py <jobA> <jobB> [<jobC> …]     (a job dir holds film_16x9.mp4, storyboard.json, scenes.json,
#                                                      resolution.json; frozen versions live in out/<job>/frozen/<tag>)
import json, os, subprocess, sys
import numpy as np

SHIFT = 17.0


def load(job):
    sb = json.load(open(os.path.join(job, "storyboard.json")))["shots"]
    sc = {s["shotId"]: s for s in json.load(open(os.path.join(job, "scenes.json")))["scenes"]}
    rs = json.load(open(os.path.join(job, "resolution.json")))["media"]
    shots = []
    for s in sb:
        x = sc.get(s["id"], {})
        world = (x.get("world") or {}).get("kind") or x.get("backdrop", "footage")
        els = sorted({e.get("name") or e.get("type") for e in x.get("elements", [])})
        pics = {m.get("sourceUrl") or m.get("ref") for m in rs if m.get("shotId") == s["id"] and m.get("role") in ("primary", "layer")}
        shots.append({"t0": s["startS"], "t1": s["endS"], "dev": world + "|" + ",".join(els), "pics": {p for p in pics if p}})
    return shots


def frames(job, n):
    f = os.path.join(job, "film_16x9.mp4")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-t", str(n), "-i", f, "-vf", "fps=1,scale=96:54:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    k = len(raw) // (96 * 54 * 3)
    return np.frombuffer(raw[: k * 96 * 54 * 3], dtype=np.uint8).reshape(k, 54, 96, 3).astype(np.float32)


def at(shots, t):
    for s in shots:
        if s["t0"] <= t < s["t1"]:
            return s
    return None


def compare(A, B, fa, fb, shift):
    dur = max(s["t1"] for s in A)
    durB = max(s["t1"] for s in B)
    ts = np.arange(0, dur, 0.1)
    tb = lambda t: (t + shift) % durB
    # pictures: is the picture on A at t used ANYWHERE in B (shift-free by nature; chance = 0)
    allB = set().union(*[s["pics"] for s in B])
    pic = np.mean([bool(at(A, t) and at(A, t)["pics"] & allB) for t in ts]) if shift == 0 else 0.0
    dev = np.mean([bool(at(A, t) and at(B, tb(t)) and at(A, t)["dev"] == at(B, tb(t))["dev"]) for t in ts])
    cb = [(s["t0"] - shift) % durB for s in B]
    cuts = np.mean([min(abs(s["t0"] - c) for c in cb) < 0.3 for s in A[1:]])
    n = min(len(fa), len(fb))
    like = []
    for i in range(n):
        j = int(tb(i)) % len(fb)
        a, b = fa[i], fb[j]
        ga, gb = a.mean(axis=2)[::6, ::6].ravel(), b.mean(axis=2)[::6, ::6].ravel()
        ga, gb = ga - ga.mean(), gb - gb.mean()
        den = np.sqrt((ga * ga).sum() * (gb * gb).sum())
        c = (ga * gb).sum() / den if den > 1e-6 else 0
        ha = np.histogramdd(a.reshape(-1, 3), bins=(4, 4, 4), range=[(0, 256)] * 3)[0].ravel(); ha /= ha.sum()
        hb = np.histogramdd(b.reshape(-1, 3), bins=(4, 4, 4), range=[(0, 256)] * 3)[0].ravel(); hb /= hb.sum()
        like.append(c > 0.6 and np.minimum(ha, hb).sum() > 0.7)
    return {"pictures": float(pic), "cuts": float(cuts), "devices": float(dev), "frames": float(np.mean(like))}


def main():
    jobs = sys.argv[1:]
    A = load(jobs[0])
    fa = frames(jobs[0], 200)
    out = {}
    for jb in jobs[1:]:
        B = load(jb)
        fb = frames(jb, 200)
        same = compare(A, B, fa, fb, 0.0)
        chance = compare(A, B, fa, fb, SHIFT)
        out[jb] = {k: round(max(0.0, same[k] - (chance[k] if k != "pictures" else 0)), 3) for k in same}
        out[jb]["raw"] = {k: round(v, 3) for k, v in same.items()}
        print(os.path.basename(jb.rstrip("/")), json.dumps(out[jb]), flush=True)
    worst = {k: max(v[k] for v in out.values()) for k in ("pictures", "cuts", "devices", "frames")}
    print("worst", json.dumps(worst))


main()
