# How a film moves from one picture to the next (owner, 2026-11-24: "the reference moves smoothly between scenes, sometimes
# with no cut, a continuous hold and movement from scene to scene"). Same function on the channel's films and ours.
# Frames at 12 fps, 192x108 grey, over a window (default the first 120 s):
#   cutsPerMin   hard cuts (an isolated spike of frame difference)
#   softPerMin   scene changes WITHOUT a cut: the picture became a different picture (diff to the last reference frame
#                over a threshold) through movement, a dissolve, a push-through or a layer change
#   softShare    soft / (soft + cuts): how often the picture changes by moving rather than by cutting
#   moving       share of the time the picture is visibly moving (frame-to-frame diff above a floor)
#   still        share of the time it is near still
#   motionMed    median frame-to-frame difference while not cutting (how fast things move)
#   segMed       median time between hard cuts
#   python -I motion-band.py <film.mp4> [--window 120]          → one film's JSON
#   python -I motion-band.py --band <list.txt> [--window 120]   → per-film rows + p10/median/p90 of every measure
import json, sys, subprocess
import numpy as np

W, H, FPS = 192, 108, 12


def frames(path, window):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-t", str(window), "-i", path, "-vf", f"fps={FPS},scale={W}:{H}:flags=area,format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    n = len(raw) // (W * H)
    return np.frombuffer(raw[: n * W * H], dtype=np.uint8).reshape(n, H, W).astype(np.float32)


def measure(path, window=120.0):
    f = frames(path, window)
    n = len(f)
    if n < 24:
        return None
    d = np.abs(f[1:] - f[:-1]).mean(axis=(1, 2))  # d[i]: change from frame i to i+1
    cuts = []
    for i in range(len(d)):
        a = d[i - 1] if i > 0 else 0
        b = d[i + 1] if i + 1 < len(d) else 0
        if d[i] > 18 and d[i] > 2.5 * max(a, b, 1.5):
            cuts.append(i + 1)
    cutset = set(cuts)
    # soft changes: the picture drifts away from where it was (no cut in between)
    # coarse layout (24x14 block means): a "different picture" is one whose layout no longer correlates with where the
    # stretch was (falling money or flicker changes pixels, not the layout)
    c = f[:, : 14 * (H // 14), : 24 * (W // 24)].reshape(n, 14, H // 14, 24, W // 24).mean(axis=(2, 4)).reshape(n, -1)
    def corr(a, b):
        a = a - a.mean(); b = b - b.mean()
        den = np.sqrt((a * a).sum() * (b * b).sum())
        return float((a * b).sum() / den) if den > 1e-6 else 1.0
    soft = 0
    ref = c[0]
    last = 0
    for i in range(1, n):
        if i in cutset:
            ref, last = c[i], i
            continue
        if i - last >= 6 and corr(c[i], ref) < 0.35:
            soft += 1
            ref, last = c[i], i
    mins = n / FPS / 60
    nc = np.array([d[i] for i in range(len(d)) if (i + 1) not in cutset])
    bounds = [0] + cuts + [n]
    segs = [(bounds[k + 1] - bounds[k]) / FPS for k in range(len(bounds) - 1)]
    return {
        "cutsPerMin": round(len(cuts) / mins, 2),
        "softPerMin": round(soft / mins, 2),
        "softShare": round(soft / max(1, soft + len(cuts)), 3),
        "moving": round(float((nc > 2.0).mean()), 3),
        "still": round(float((nc < 0.6).mean()), 3),
        "motionMed": round(float(np.median(nc)), 2),
        "segMed": round(float(np.median(segs)), 2),
    }


def main():
    a = sys.argv[1:]
    window = 120.0
    if "--window" in a:
        window = float(a[a.index("--window") + 1])
    if a[0] == "--band":
        rows = {}
        for p in [x.strip() for x in open(a[1]) if x.strip()]:
            try:
                m = measure(p, window)
            except Exception:
                m = None
            if m:
                rows[p.split("/")[-2][:40]] = m
        keys = list(next(iter(rows.values())).keys())
        band = {k: {q: round(float(np.percentile([r[k] for r in rows.values()], p)), 3) for q, p in (("p10", 10), ("med", 50), ("p90", 90))} for k in keys}
        print(json.dumps({"films": rows, "band": band, "window": window}, indent=1))
    else:
        print(json.dumps(measure(a[0], window)))


main()
