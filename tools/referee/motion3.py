"""Motion referee, third attempt (2026-11-27). Block motion on a 3×3 grid was too noisy on the channel's dark frames
(26 % of real windows flagged). This measures whole-frame camera movement by Fourier–Mellin: the shift between two
frames by phase correlation of the whole (Hann-windowed) frame, the scale and rotation by phase correlation of their
log-polar magnitude spectra. Per 20 s window: how much of the time the camera pushes, pulls, pans or holds, how fast,
how steadily (sign consistency, run length), whips, cuts. Same films, held-back sets and two measures as before.
  python tools/referee/motion3.py build
"""
import hashlib, json, os, sys
import numpy as np
from scipy.ndimage import map_coordinates
sys.path.insert(0, os.path.dirname(__file__))
import motion_sound as V1

DATA = V1.DATA
OUT = os.path.join(DATA, "referee", "magnates-media-motion3.json")
CACHE = os.path.join(DATA, ".cache", "motion3")
W, H, FPS, WIN = 256, 144, 6, 20.0
FEATS = ["zoom_rate", "zoom_active", "push_share", "pull_share", "pan_rate", "pan_active", "whip_per_min", "steady", "move_run_s", "hold_share", "cuts_per_min"]
HANN = np.outer(np.hanning(H), np.hanning(W)).astype(np.float32)
NA, NR = 180, 384
cy, cx = H / 2, W / 2
rmax = min(cy, cx)
logr = np.exp(np.linspace(0, np.log(rmax), NR))
ang = np.linspace(0, np.pi, NA, endpoint=False)
LP_Y = (cy + logr[None, :] * np.sin(ang[:, None])).astype(np.float32)
LP_X = (cx + logr[None, :] * np.cos(ang[:, None])).astype(np.float32)
fy, fx = np.meshgrid(np.fft.fftshift(np.fft.fftfreq(H)), np.fft.fftshift(np.fft.fftfreq(W)), indexing="ij")
HP = (1 - np.cos(np.pi * np.clip(np.hypot(fy, fx) * 2, 0, 1))).astype(np.float32)  # high-pass emphasis

def phase(a, b):
    A, B = np.fft.fft2(a), np.fft.fft2(b)
    R = A * np.conj(B); R /= np.abs(R) + 1e-9
    r = np.fft.ifft2(R).real
    y, x = np.unravel_index(np.argmax(r), r.shape)
    peak = r[y, x]
    def sub(c, n, m_, p_):
        d = m_ - 2 * peak + p_
        return c + (0.5 * (m_ - p_) / d if abs(d) > 1e-9 else 0.0)
    fy_ = sub(float(y), r.shape[0], r[(y - 1) % r.shape[0], x], r[(y + 1) % r.shape[0], x])
    fx_ = sub(float(x), r.shape[1], r[y, (x - 1) % r.shape[1]], r[y, (x + 1) % r.shape[1]])
    if fy_ > r.shape[0] / 2: fy_ -= r.shape[0]
    if fx_ > r.shape[1] / 2: fx_ -= r.shape[1]
    return fx_, fy_, float(peak)

def logpolar_mag(f):
    m = np.abs(np.fft.fftshift(np.fft.fft2((f - f.mean()) * HANN))) * HP
    return map_coordinates(m, [LP_Y, LP_X], order=1)

# zoom by direct search: scale frame a about its centre (after removing the pan) and keep the factor that best matches
# frame b — golden-section search on 0.97–1.03 at 128×72 (Fourier–Mellin missed slow pushes on this material)
SH, SW = 72, 128
_yy, _xx = np.mgrid[0:SH, 0:SW].astype(np.float32)
_inner = (slice(int(SH * 0.15), int(SH * 0.85)), slice(int(SW * 0.15), int(SW * 0.85)))
def _small(f): return f.reshape(SH, H // SH, SW, W // SW).mean(axis=(1, 3))
def _err(a, b, s, dx, dy):
    ys = (_yy - SH / 2) / s + SH / 2 - dy; xs = (_xx - SW / 2) / s + SW / 2 - dx
    w = map_coordinates(a, [ys, xs], order=1, mode="nearest")
    return float(np.abs(w[_inner] - b[_inner]).mean())
def _zoom(a, b, dx, dy):
    lo, hi, g = 0.97, 1.03, 0.6180339887
    c, d = hi - g * (hi - lo), lo + g * (hi - lo)
    fc, fd = _err(a, b, c, dx, dy), _err(a, b, d, dx, dy)
    for _ in range(14):
        if fc < fd: hi, d, fd = d, c, fc; c = hi - g * (hi - lo); fc = _err(a, b, c, dx, dy)
        else: lo, c, fc = c, d, fd; d = lo + g * (hi - lo); fd = _err(a, b, d, dx, dy)
    s_ = (lo + hi) / 2
    return s_ if _err(a, b, s_, dx, dy) < _err(a, b, 1.0, dx, dy) * 0.995 else 1.0

def camera(frames):
    """Per frame pair: pan (px at 256 wide), zoom (scale − 1 per frame), cut."""
    out = []
    small = [_small(f) for f in frames]
    for t in range(len(frames) - 1):
        a, b = frames[t], frames[t + 1]
        diff = float(np.abs(b - a).mean())
        dx, dy, _ = phase((a - a.mean()) * HANN, (b - b.mean()) * HANN)
        s_ = _zoom(small[t], small[t + 1], -dx * SW / W, -dy * SH / H)
        out.append((float(np.hypot(dx, dy)), s_ - 1.0, diff))
    return np.array(out)

def features(m):
    pan, zoom, diff = m[:, 0], m[:, 1], m[:, 2]
    cut = diff > max(18.0, np.percentile(diff, 97))
    ok = ~cut
    z, p = zoom[ok], pan[ok]
    zt, pt = 0.0015, 0.4  # per frame at 6 fps: ~0.9 % a second of scale, ~2.4 px a second of pan at 256 px
    zact, pact = np.abs(z) > zt, p > pt
    state = np.where(p > 10, 3, np.where(zact, np.sign(z), np.where(pact, 2, 0)))  # 1 push, -1 pull, 2 pan, 3 whip, 0 hold
    runs, cur, ln = [], None, 0
    for v in state:
        if v == cur: ln += 1
        else:
            if cur not in (None, 0): runs.append(ln)
            cur, ln = v, 1
    if cur not in (None, 0): runs.append(ln)
    mins = len(m) / FPS / 60
    zs = np.sign(z[zact]) if zact.any() else np.array([0.0])
    return {"zoom_rate": float(np.median(np.abs(z))) * FPS, "zoom_active": float(zact.mean()), "push_share": float((state == 1).mean()), "pull_share": float((state == -1).mean()),
            "pan_rate": float(np.median(p)) * FPS / W, "pan_active": float(pact.mean()), "whip_per_min": float(((state == 3) & np.r_[True, state[:-1] != 3]).sum() / mins),
            "steady": float(abs(zs.mean())), "move_run_s": float(np.median(runs) / FPS) if runs else 0.0, "hold_share": float((state == 0).mean()), "cuts_per_min": float(cut.sum() / mins)}

def film_rows(f, t0, t1, max_windows=15):
    os.makedirs(CACHE, exist_ok=True)
    st = os.stat(f); k = os.path.join(CACHE, hashlib.sha1(f"{f}|{st.st_size}|{int(st.st_mtime)}|{t0}|{t1}".encode()).hexdigest()[:16] + ".json")
    if os.path.exists(k): return json.load(open(k))
    import subprocess
    D = V1.dur(f); a, b = (min(t0, max(0, D - WIN * 2)), min(t1, D)) if D > 90 else (0.0, D)
    v = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(a), "-t", str(b - a), "-i", f, "-vf", f"fps={FPS},scale={W}:{H},format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
    frames = np.frombuffer(v, dtype=np.uint8)[: (len(v) // (W * H)) * W * H].reshape(-1, H, W).astype(np.float32)
    rows = []
    for w in range(int((b - a) // WIN))[:max_windows]:
        fr = frames[int(w * WIN * FPS): int((w + 1) * WIN * FPS)]
        if len(fr) > 10: rows.append(features(camera(fr)))
    json.dump(rows, open(k, "w")); return rows

def build():
    films = V1.reference_films() + V1.our_films()
    rows = {}
    for i, (kind, fid, f, held) in enumerate(films):
        rows[fid] = film_rows(f, *((0.0, 600.0) if kind == "ours" else (30.0, 330.0)))
        print(f"\r  measured {i + 1}/{len(films)}", end="", flush=True)
    print()
    our_ids = sorted(k for kind, k, _, _ in films if kind == "ours"); folds = [our_ids[i::4] for i in range(4)]
    def X_of(sel):
        rs = [(k, r) for kind, k, _, held in films if sel(kind, held) for r in rows[k]]
        return np.array([[r[x] for x in FEATS] for _, r in rs]).reshape(-1, len(FEATS)), np.array([k for k, _ in rs])
    Xr, gr = X_of(lambda k, h: k != "ours" and not h); Xh, gh = X_of(lambda k, h: k != "ours" and h); Xo, go = X_of(lambda k, h: k == "ours")
    Xm, _ = X_of(lambda k, h: k == "mm" and not h); Xx, _ = X_of(lambda k, h: k == "other" and not h)
    Xmh, gmh = X_of(lambda k, h: k == "mm" and h); Xxh, gxh = X_of(lambda k, h: k == "other" and h)
    po = np.zeros(len(Xo)); ph = []
    for fo in folds:
        te = np.isin(go, fo); m = V1.fit(np.vstack([Xr, Xo[~te]]), np.r_[np.ones(len(Xr)), np.zeros((~te).sum())])
        po[te] = V1.prob(m, Xo[te]); ph.append(V1.prob(m, Xh))
    ph = np.mean(ph, 0)
    film = lambda g, p: {k: float(np.mean(p[g == k])) for k in sorted(set(g))}
    ch = V1.fit(np.vstack([Xm, Xx]), np.r_[np.ones(len(Xm)), np.zeros(len(Xx))])
    hf, of = film(gh, ph), film(go, po)
    cm, cx_, cu = film(gmh, V1.prob(ch, Xmh)), film(gxh, V1.prob(ch, Xxh)), film(go, V1.prob(ch, Xo))
    fl = lambda x: float(np.floor(x * 20) / 20)
    rep = {"version": 3, "feats": FEATS, "models": {"reference": V1.fit(np.vstack([Xr, Xo]), np.r_[np.ones(len(Xr)), np.zeros(len(Xo))]), "channel": ch},
           "test": {"reference": {"heldReal": hf, "ours": of, "heldWindowsFlagged": float((ph < 0.5).mean()), "ourWindowsCaught": float((po < 0.5).mean())}, "channel": {"heldMagnates": cm, "heldOthers": cx_, "ours": cu}},
           "bars": {"reference": fl(min(hf.values())), "channel": fl(min(cm.values()))},
           "means": {"real": dict(zip(FEATS, Xr.mean(0).round(4).tolist())), "magnates": dict(zip(FEATS, Xm.mean(0).round(4).tolist())), "ours": dict(zip(FEATS, Xo.mean(0).round(4).tolist()))}}
    tmp = OUT + ".tmp"; json.dump(rep, open(tmp, "w"), indent=1); os.replace(tmp, OUT)
    r_ = lambda d: f"{min(d.values()):.2f}–{max(d.values()):.2f}"
    print(f"MOTION reference: held-back real {r_(hf)}, ours {r_(of)} (our windows caught {np.mean(po < 0.5):.0%}, real windows flagged {np.mean(ph < 0.5):.0%})")
    print(f"       channel:   held-back MagnatesMedia {r_(cm)}, held-back others {r_(cx_)}, ours {r_(cu)}")
    print("       means (MagnatesMedia | ours):", ", ".join(f"{k} {rep['means']['magnates'][k]}|{rep['means']['ours'][k]}" for k in FEATS))

LABEL = {"push_share": "pushing in", "pull_share": "pulling out", "steady": "moving one way only (the channel alternates in and out)", "whip_per_min": "whips a minute", "pan_rate": "pan speed", "pan_active": "time panning", "hold_share": "time holding still"}
def score(f):
    """A whole film against the real channels' motion: the score, its bar, and how its camera differs from MagnatesMedia's."""
    M = json.load(open(OUT)); rows = film_rows(f, 0.0, 3600.0, max_windows=400)
    if not rows: print(json.dumps({"error": "too short"})); return
    X = np.array([[r[k] for k in M["feats"]] for r in rows])
    s_ = float(V1.prob(M["models"]["reference"], X).mean())
    ours = X.mean(0); mm = M["means"]["magnates"]
    gaps = []
    for k, lab in LABEL.items():
        i = M["feats"].index(k); a, b = float(ours[i]), mm[k]
        if b > 0 and (a / b > 1.4 or a / b < 0.7): gaps.append({"what": lab, "film": round(a, 3), "magnates": round(b, 3), "more": a > b})
    print(json.dumps({"score": round(s_, 2), "bar": M["bars"]["reference"], "pass": s_ >= M["bars"]["reference"], "gaps": gaps}))

if __name__ == "__main__":
    {"build": build, "score": lambda: score(sys.argv[2])}[sys.argv[1]]()
