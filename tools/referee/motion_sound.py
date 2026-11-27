"""Motion and sound referees (2026-11-27): the picture referee sees still frames; nothing proven judged how a film cuts,
moves and sounds against the reference. Same method as the script referee:
  - per 20 s window of a film: motion (frame-to-frame change, near-still share, cuts per minute, shot length, brightness
    change) and sound (loudness spread relative to the film's own level, hits and strong hits per minute, low-frequency
    weight, silences, spectral centre) — measured by ffmpeg + numpy, the same function on every film;
  - "reference": real documentary films of all five reference channels against our films — does it cut, move and sound
    like a real channel?
  - "channel": MagnatesMedia against the other four channels — like THIS channel?
Held back: the picture referee's eight MagnatesMedia films and every fifth film of the others; bars from those, unseen.
  python tools/referee/motion_sound.py build        → data/referee/magnates-media-motion-sound.json (+ a feature cache)
  python tools/referee/motion_sound.py score <mp4>  → JSON: reference / channel scores for motion and sound, gaps
"""
import glob, json, os, subprocess, sys
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "data"); REF = os.path.join(ROOT, "Reference")
OUT = os.path.join(DATA, "referee", "magnates-media-motion-sound.json")
CACHE = os.path.join(DATA, ".cache", "motion-sound")
W, H, FPS, SR, WIN = 160, 90, 8, 16000, 20.0
MOTION = ["movement", "movement_p90", "near_still", "cuts_per_min", "shot_median_s", "brightness_change"]
SOUND = ["loud_spread_db", "loud_p10_rel", "hits_per_min", "strong_hits_per_min", "low_share", "silence_share", "centroid"]

def dur(f): return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], capture_output=True, text=True).stdout.strip() or 0)

def decode(f, t0, t1):
    v = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t0), "-t", str(t1 - t0), "-i", f, "-vf", f"fps={FPS},scale={W}:{H},format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
    a = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t0), "-t", str(t1 - t0), "-i", f, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True).stdout
    frames = np.frombuffer(v, dtype=np.uint8)[: (len(v) // (W * H)) * W * H].reshape(-1, H, W).astype(np.float32)
    audio = np.frombuffer(a, dtype=np.float32)
    return frames, audio

def features(frames, audio, film_ref_db):
    out = {}
    if len(frames) > 2:
        d = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
        cut = d > max(18.0, np.percentile(d, 97) if len(d) > 10 else 18.0)
        cuts = np.where(cut)[0]
        shots = np.diff(np.r_[0, cuts, len(d)]) / FPS
        out.update(movement=float(np.median(d)), movement_p90=float(np.percentile(d, 90)), near_still=float((d < 1.0).mean()),
                   cuts_per_min=float(cut.sum() / (len(d) / FPS) * 60), shot_median_s=float(np.median(shots)) if len(shots) else WIN,
                   brightness_change=float(np.abs(np.diff(frames.mean(axis=(1, 2)))).mean()))
    if len(audio) > SR:
        hop = SR // 20  # 50 ms
        n = len(audio) // hop
        fr = audio[: n * hop].reshape(n, hop)
        rms = np.sqrt((fr ** 2).mean(1)) + 1e-9
        db = 20 * np.log10(rms) - film_ref_db
        spec = np.abs(np.fft.rfft(fr * np.hanning(hop), axis=1))
        freqs = np.fft.rfftfreq(hop, 1 / SR)
        flux = np.r_[0, np.maximum(0, np.diff(spec, axis=0)).sum(1)]
        fz = (flux - np.median(flux)) / (np.percentile(flux, 90) - np.median(flux) + 1e-9)
        peaks = (fz[1:-1] > fz[:-2]) & (fz[1:-1] >= fz[2:])
        mins = len(fr) * 0.05 / 60
        low = spec[:, freqs < 150].sum(1) / (spec.sum(1) + 1e-9)
        out.update(loud_spread_db=float(np.percentile(db, 95) - np.percentile(db, 10)), loud_p10_rel=float(np.percentile(db, 10)),
                   hits_per_min=float((peaks & (fz[1:-1] > 2.0)).sum() / mins), strong_hits_per_min=float((peaks & (fz[1:-1] > 4.0)).sum() / mins),
                   low_share=float(low.mean()), silence_share=float((db < -30).mean()),
                   centroid=float(((spec * freqs).sum(1) / (spec.sum(1) + 1e-9)).mean()))
    return out

def film_windows(f, t0=30.0, t1=330.0, max_windows=15):
    """Feature rows for 20 s windows of one film (cached by path, size and time)."""
    os.makedirs(CACHE, exist_ok=True)
    import hashlib
    st = os.stat(f); key = os.path.join(CACHE, hashlib.sha1(f"{f}|{st.st_size}|{int(st.st_mtime)}|{t0}|{t1}".encode()).hexdigest()[:16] + ".json")
    if os.path.exists(key): return json.load(open(key))
    D = dur(f); a, b = (min(t0, max(0, D - WIN * 2)), min(t1, D)) if D > 90 else (0.0, D)
    frames, audio = decode(f, a, b)
    ref_db = 20 * np.log10(np.percentile(np.sqrt((audio[: len(audio) // 800 * 800].reshape(-1, 800) ** 2).mean(1)) + 1e-9, 95)) if len(audio) > 1600 else 0.0
    rows = []
    for k in range(int((b - a) // WIN))[:max_windows]:
        fr = frames[int(k * WIN * FPS): int((k + 1) * WIN * FPS)]; au = audio[int(k * WIN * SR): int((k + 1) * WIN * SR)]
        x = features(fr, au, ref_db)
        if len(x) == len(MOTION) + len(SOUND): rows.append(x)
    json.dump(rows, open(key, "w"))
    return rows

def fit(X, y, C=0.5):
    from sklearn.linear_model import LogisticRegression
    mu, sd = X.mean(0), X.std(0) + 1e-9
    m = LogisticRegression(C=C, class_weight="balanced", max_iter=4000).fit((X - mu) / sd, y)
    return {"mu": mu.tolist(), "sd": sd.tolist(), "coef": m.coef_[0].tolist(), "b": float(m.intercept_[0])}
def prob(m, X):
    z = (np.asarray(X) - np.array(m["mu"])) / np.array(m["sd"]); return 1 / (1 + np.exp(-(z @ np.array(m["coef"]) + m["b"])))

def reference_films():
    picture = json.load(open(os.path.join(DATA, "referee", "magnates-media.json")))
    held_mm = set(picture["holdout"])
    out = []
    for d in sorted(glob.glob(os.path.join(REF, "MagnatesMedia", "*"))):
        mp4 = sorted(glob.glob(os.path.join(d, "*.mp4")))
        if not mp4: continue
        fid = "MM-" + os.path.basename(d)[:8]
        out.append(("mm", fid, mp4[0], fid in held_mm))
    for ch in ["How Money Works", "Logically Answered", "Modern MBA", "Moon", "Big Company"]:
        root = os.path.join(REF, ch, "Videos") if ch == "Big Company" else os.path.join(REF, ch)
        dirs = sorted(d for d in glob.glob(os.path.join(root, "*")) if glob.glob(os.path.join(d, "*.mp4")))
        pick = dirs[:: max(1, len(dirs) // 12)][:12]
        for i, d in enumerate(pick): out.append(("other", f"{ch}:{os.path.basename(d)}", sorted(glob.glob(os.path.join(d, "*.mp4")))[0], i % 5 == 0))
    return out

OURS = ["agent-juicero-2/film_16x9.mp4", "agent-juicero-3/film_16x9.mp4", "bl4b-theranos/*_16x9.mp4", "bl4c-nokia/*_16x9.mp4", "bl5-blockbuster/*_16x9.mp4",
        "bl5b-wework/*_16x9.mp4", "bl5c-quibi/*_16x9.mp4", "enron-mm/*_16x9.mp4", "eval-quick-kodak/*_16x9.mp4", "eval-quick-theranos/*_16x9.mp4",
        "film1-kodak-3/*_16x9.mp4", "ftx-hmw/how-ftx-collapsed_16x9.mp4", "ftx-hmw/how-ftx-lost-its-king_16x9.mp4", "hand-ftx/film_16x9.mp4", "hand-juicero-r/film_16x9.mp4",
        "hand-wirecard/film_16x9.mp4", "hand-wirecard-v5/film_16x9.mp4", "hand-wirecard-v6/film_16x9.mp4", "hand-wirecard-v7/film_16x9.mp4",
        "nokia-longform-16x9/*_16x9.mp4", "nokia-magnates-v2/*_16x9.mp4", "nokia-magnates-v3/*_16x9.mp4"]
def our_films():
    out = []
    for p in OURS:
        g = sorted(glob.glob(os.path.join(ROOT, "out", p)))
        if g: out.append(("ours", p.split("/")[0] + ("" if "*" in p else "/" + p.split("/")[1]), g[0], False))
    return out

def matrix(rows, keys): return np.array([[r[k] for k in keys] for r in rows])

def build():
    films = reference_films() + our_films()
    feats = {}
    for i, (kind, fid, f, held) in enumerate(films):
        feats[fid] = film_windows(f, *((0.0, 600.0) if kind == "ours" else (30.0, 330.0)))
        print(f"\r  measured {i + 1}/{len(films)}", end="", flush=True)
    print()
    report = {"version": 1, "window_s": WIN, "motion": MOTION, "sound": SOUND, "films": {k: {"kind": kind, "held": held} for kind, k, _, held in films}, "models": {}, "test": {}, "bars": {}}
    our_ids = sorted(k for kind, k, _, _ in films if kind == "ours"); folds = [our_ids[i::4] for i in range(4)]
    for name, keys in [("motion", MOTION), ("sound", SOUND)]:
        def X_of(sel): rows = [(k, r) for kind, k, _, held in films if sel(kind, held) for r in feats[k]]; return matrix([r for _, r in rows], keys), np.array([k for k, _ in rows])
        Xr, gr = X_of(lambda k, h: k != "ours" and not h); Xh, gh = X_of(lambda k, h: k != "ours" and h); Xo, go = X_of(lambda k, h: k == "ours")
        Xm, _ = X_of(lambda k, h: k == "mm" and not h); Xx, _ = X_of(lambda k, h: k == "other" and not h)
        Xmh, gmh = X_of(lambda k, h: k == "mm" and h); Xxh, gxh = X_of(lambda k, h: k == "other" and h)
        po = np.zeros(len(Xo)); ph = []
        for fo in folds:
            te = np.isin(go, fo); m = fit(np.vstack([Xr, Xo[~te]]), np.r_[np.ones(len(Xr)), np.zeros((~te).sum())])
            po[te] = prob(m, Xo[te]); ph.append(prob(m, Xh))
        ph = np.mean(ph, 0)
        ref = fit(np.vstack([Xr, Xo]), np.r_[np.ones(len(Xr)), np.zeros(len(Xo))])
        ch = fit(np.vstack([Xm, Xx]), np.r_[np.ones(len(Xm)), np.zeros(len(Xx))])
        film = lambda g, p: {k: float(np.mean(p[g == k])) for k in sorted(set(g))}
        hf, of = film(gh, ph), film(go, po)
        cm, cx, cu = film(gmh, prob(ch, Xmh)), film(gxh, prob(ch, Xxh)), film(go, prob(ch, Xo))
        fl = lambda x: float(np.floor(x * 20) / 20)
        report["models"][name] = {"reference": ref, "channel": ch}
        report["test"][name] = {"reference": {"heldReal": hf, "ours": of, "heldWindowsFlagged": float((ph < 0.5).mean()), "ourWindowsCaught": float((po < 0.5).mean())},
                                "channel": {"heldMagnates": cm, "heldOthers": cx, "ours": cu}}
        report["bars"][name] = {"reference": fl(min(hf.values())), "channel": fl(min(cm.values()))}
        r_ = lambda d: f"{min(d.values()):.2f}–{max(d.values()):.2f}"
        print(f"{name.upper():6s} reference: held-back real {r_(hf)}, ours {r_(of)} (windows caught {np.mean(po < 0.5):.0%}, real flagged {np.mean(ph < 0.5):.0%})")
        print(f"       channel:   held-back MagnatesMedia {r_(cm)}, held-back others {r_(cx)}, ours {r_(cu)}")
    tmp = OUT + ".tmp"; json.dump(report, open(tmp, "w"), indent=1); os.replace(tmp, OUT)
    print("bars", report["bars"])

def score(f):
    M = json.load(open(OUT)); rows = film_windows(f, 0.0, 3600.0, max_windows=200)
    out = {}
    for name, keys in [("motion", M["motion"]), ("sound", M["sound"])]:
        X = matrix(rows, keys); mods = M["models"][name]; B = M["bars"][name]
        pr, pc = prob(mods["reference"], X), prob(mods["channel"], X)
        mu, sd, coef = (np.array(mods["reference"][k]) for k in ("mu", "sd", "coef"))
        push = ((X.mean(0) - mu) / sd) * coef
        gaps = [{"what": keys[i], "ours": round(float(X.mean(0)[i]), 3), "real": round(float(mu[i]), 3)} for i in np.argsort(push)[:3] if push[i] < -0.2]
        out[name] = {"reference": round(float(pr.mean()), 2), "referenceBar": B["reference"], "channel": round(float(pc.mean()), 2), "channelBar": B["channel"],
                     "pass": bool(pr.mean() >= B["reference"] and pc.mean() >= B["channel"]), "weakWindows": [round(i * WIN) for i, p in enumerate(pr) if p < 0.5], "gaps": gaps}
    print(json.dumps(out))

if __name__ == "__main__":
    {"build": build, "score": lambda: score(sys.argv[2])}[sys.argv[1]]()
