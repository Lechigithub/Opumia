"""Motion and sound referees, second attempt (2026-11-27). The first used blunt window statistics and did not separate
real channel films from ours (28–32 % of real windows flagged). This one measures what the channel's motion and sound
are made of, by the same function on both sides:
  motion — camera moves from block motion (NumPy phase correlation on a 3×3 grid, 320×180 at 8 fps): static / push /
           pull / pan / whip shares, how long a move holds, shake, move speed, cuts per minute;
  sound  — voice and music bed separated by Demucs with the reference's own settings (htdemucs, two stems, shifts 0,
           overlap 0.1; the reference's sound.json holds its levels every 100 ms): voice over bed, ducking, bed movement,
           drop-outs, bed rises (hits), speech share — relative levels only, so no film's loudness is learned.
Same held-back films as before; same two measures (real channels vs ours, MagnatesMedia vs the other channels).
  python tools/referee/motion_sound2.py build | score <mp4>
"""
import glob, hashlib, json, os, subprocess, sys, tempfile
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import motion_sound as V1

ROOT, DATA, REF = V1.ROOT, V1.DATA, V1.REF
OUT = os.path.join(DATA, "referee", "magnates-media-motion-sound2.json")
CACHE = os.path.join(DATA, ".cache", "motion-sound2")
W, H, FPS, WIN = 320, 180, 8, 20.0
MOTION = ["static", "push", "pull", "pan", "whip_per_min", "move_hold_s", "shake", "move_speed", "cuts_per_min"]
SOUND = ["voice_over_bed", "ducking", "bed_movement", "drops_per_min", "bed_rises_per_min", "speech_share", "bed_presence"]

def key(*parts): return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:16]

def shift(a, b):
    """Translation of block b relative to a by phase correlation (pixels)."""
    A, B = np.fft.fft2(a - a.mean()), np.fft.fft2(b - b.mean())
    R = A * np.conj(B); R /= np.abs(R) + 1e-9
    r = np.fft.ifft2(R).real
    y, x = np.unravel_index(np.argmax(r), r.shape)
    # sub-pixel: a parabola through the peak and its neighbours (a slow push moves less than a pixel a frame)
    def sub(c, axis):
        n = r.shape[axis]; m, p_ = ((y - 1) % n, (y + 1) % n) if axis == 0 else ((x - 1) % n, (x + 1) % n)
        a_, b_, c_ = (r[m, x], r[y, x], r[p_, x]) if axis == 0 else (r[y, m], r[y, x], r[y, p_])
        d = a_ - 2 * b_ + c_
        return c + (0.5 * (a_ - c_) / d if abs(d) > 1e-9 else 0.0)
    fy, fx = sub(float(y), 0), sub(float(x), 1)
    if fy > r.shape[0] / 2: fy -= r.shape[0]
    if fx > r.shape[1] / 2: fx -= r.shape[1]
    return -fx, -fy

def motion_frames(frames):
    """Per frame pair: pan (dx, dy), zoom (outward spread of the blocks), residual, cut."""
    n = len(frames)
    if n < 3: return None
    by, bx = H // 3, W // 3
    centres = [((j + 0.5) * bx - W / 2, (i + 0.5) * by - H / 2) for i in range(3) for j in range(3)]
    out = []
    for t in range(n - 1):
        a, b = frames[t], frames[t + 1]
        diff = float(np.abs(b - a).mean())
        sh = [shift(a[i * by:(i + 1) * by, j * bx:(j + 1) * bx], b[i * by:(i + 1) * by, j * bx:(j + 1) * bx]) for i in range(3) for j in range(3)]
        sh = np.array(sh, dtype=np.float32)
        pan = np.median(sh, axis=0)
        rel = sh - pan
        radial = [(rel[k] @ np.array(c)) / (np.linalg.norm(c) + 1e-9) for k, c in enumerate(centres) if np.linalg.norm(c) > 1]
        out.append((pan[0], pan[1], float(np.mean(radial)), float(np.abs(rel).mean()), diff))
    return np.array(out)

def motion_features(m):
    pan = np.hypot(m[:, 0], m[:, 1]); zoom = m[:, 2]; diff = m[:, 4]
    cut = diff > max(18.0, np.percentile(diff, 97))
    ok = ~cut
    state = np.where(pan > 6, 4, np.where(zoom > 0.12, 1, np.where(zoom < -0.12, 2, np.where(pan > 0.35, 3, 0))))  # 0 static 1 push 2 pull 3 pan 4 whip
    s = state[ok]
    runs, cur, ln = [], None, 0
    for v in s:
        if v == cur: ln += 1
        else:
            if cur not in (None, 0): runs.append(ln)
            cur, ln = v, 1
    if cur not in (None, 0): runs.append(ln)
    mins = len(m) / FPS / 60
    whips = int(((state == 4) & np.r_[True, state[:-1] != 4]).sum())
    return {"static": float((s == 0).mean()), "push": float((s == 1).mean()), "pull": float((s == 2).mean()), "pan": float((s == 3).mean()),
            "whip_per_min": whips / mins, "move_hold_s": float(np.median(runs) / FPS) if runs else 0.0,
            "shake": float(np.std(np.diff(m[ok, 0]))) if ok.sum() > 3 else 0.0, "move_speed": float(np.median(pan[ok & (state != 0)])) if (ok & (state != 0)).any() else 0.0,
            "cuts_per_min": float(cut.sum() / mins)}

def decode_video(f, t0, t1):
    v = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t0), "-t", str(t1 - t0), "-i", f, "-vf", f"fps={FPS},scale={W}:{H},format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
    return np.frombuffer(v, dtype=np.uint8)[: (len(v) // (W * H)) * W * H].reshape(-1, H, W).astype(np.float32)

# ---- sound: the reference's own Demucs levels, and ours separated the same way
def db100(x, sr):
    hop = sr // 10; n = len(x) // hop
    return (20 * np.log10(np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9)).tolist()

def our_stems(f):
    os.makedirs(CACHE, exist_ok=True)
    st = os.stat(f); k = os.path.join(CACHE, f"stems-{key(f, st.st_size, int(st.st_mtime))}.json")
    if os.path.exists(k): return json.load(open(k))
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "in.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-vn", "-ac", "2", "-ar", "44100", wav], check=True)
        subprocess.run([sys.executable, "-m", "demucs", "-n", "htdemucs", "--two-stems", "vocals", "--shifts", "0", "--overlap", "0.1", "-o", d, wav], check=True, capture_output=True)
        import soundfile as sf
        base = glob.glob(os.path.join(d, "htdemucs", "in"))[0]
        v, sr = sf.read(os.path.join(base, "vocals.wav")); b, _ = sf.read(os.path.join(base, "no_vocals.wav"))
        out = {"voice_db_100ms": db100(v.mean(1), sr), "bed_db_100ms": db100(b.mean(1), sr)}
    json.dump(out, open(k, "w")); return out

def sound_features(voice, bed):
    v, b = np.array(voice), np.array(bed)
    if len(v) < 50: return None
    speaking = v > np.percentile(v, 95) - 20
    vob = float(np.median(v[speaking] - b[speaking])) if speaking.any() else 0.0
    duck = float(np.median(b[~speaking]) - np.median(b[speaking])) if speaking.any() and (~speaking).any() else 0.0
    ref = np.percentile(b, 90)
    gone = b < ref - 15
    drops = int((gone & np.r_[True, ~gone[:-1]]).sum())
    rises = int(((np.r_[0, np.diff(b)] > 8) & (b > ref - 6)).sum())
    mins = len(v) / 10 / 60
    return {"voice_over_bed": vob, "ducking": duck, "bed_movement": float(np.std(b[b > ref - 25])) if (b > ref - 25).any() else 0.0,
            "drops_per_min": drops / mins, "bed_rises_per_min": rises / mins, "speech_share": float(speaking.mean()), "bed_presence": float((b > ref - 20).mean())}

def film_rows(kind, f, t0, t1, max_windows=15):
    os.makedirs(CACHE, exist_ok=True)
    st = os.stat(f); k = os.path.join(CACHE, f"rows-{key(f, st.st_size, int(st.st_mtime), t0, t1)}.json")
    if os.path.exists(k): return json.load(open(k))
    D = V1.dur(f); a, b = (min(t0, max(0, D - WIN * 2)), min(t1, D)) if D > 90 else (0.0, D)
    frames = decode_video(f, a, b)
    snd = None
    if kind == "ours": snd = our_stems(f)
    else:
        sj = os.path.join(os.path.dirname(f), "sound.json")
        if os.path.exists(sj): s = json.load(open(sj)); snd = {"voice_db_100ms": s["voice_db_100ms"], "bed_db_100ms": s["bed_db_100ms"]}
    rows = []
    for w in range(int((b - a) // WIN))[:max_windows]:
        fr = frames[int(w * WIN * FPS): int((w + 1) * WIN * FPS)]
        m = motion_frames(fr)
        row = motion_features(m) if m is not None else None
        if row is None: continue
        if snd:
            s0, s1 = int((a + w * WIN) * 10), int((a + (w + 1) * WIN) * 10)
            sf_ = sound_features(snd["voice_db_100ms"][s0:s1], snd["bed_db_100ms"][s0:s1])
            if sf_: row.update(sf_)
        rows.append(row)
    json.dump(rows, open(k, "w")); return rows

def build():
    films = V1.reference_films() + V1.our_films()
    rows = {}
    for i, (kind, fid, f, held) in enumerate(films):
        rows[fid] = film_rows(kind, f, *((0.0, 600.0) if kind == "ours" else (30.0, 330.0)))
        print(f"\r  measured {i + 1}/{len(films)}", end="", flush=True)
    print()
    report = {"version": 2, "window_s": WIN, "motion": MOTION, "sound": SOUND, "models": {}, "test": {}, "bars": {}}
    our_ids = sorted(k for kind, k, _, _ in films if kind == "ours"); folds = [our_ids[i::4] for i in range(4)]
    for name, keys in [("motion", MOTION), ("sound", SOUND)]:
        def X_of(sel):
            rs = [(k, r) for kind, k, _, held in films if sel(kind, held) for r in rows[k] if all(x in r for x in keys)]
            return np.array([[r[x] for x in keys] for _, r in rs]).reshape(-1, len(keys)), np.array([k for k, _ in rs])
        Xr, gr = X_of(lambda k, h: k != "ours" and not h); Xh, gh = X_of(lambda k, h: k != "ours" and h); Xo, go = X_of(lambda k, h: k == "ours")
        Xm, _ = X_of(lambda k, h: k == "mm" and not h); Xx, _ = X_of(lambda k, h: k == "other" and not h)
        Xmh, gmh = X_of(lambda k, h: k == "mm" and h); Xxh, gxh = X_of(lambda k, h: k == "other" and h)
        if min(len(Xr), len(Xo), len(Xh), len(Xmh), len(Xxh)) == 0: print(name, "not enough data"); continue
        po = np.zeros(len(Xo)); ph = []
        for fo in folds:
            te = np.isin(go, fo); m = V1.fit(np.vstack([Xr, Xo[~te]]), np.r_[np.ones(len(Xr)), np.zeros((~te).sum())])
            po[te] = V1.prob(m, Xo[te]); ph.append(V1.prob(m, Xh))
        ph = np.mean(ph, 0)
        film = lambda g, p: {k: float(np.mean(p[g == k])) for k in sorted(set(g))}
        ch = V1.fit(np.vstack([Xm, Xx]), np.r_[np.ones(len(Xm)), np.zeros(len(Xx))])
        hf, of = film(gh, ph), film(go, po)
        cm, cx, cu = film(gmh, V1.prob(ch, Xmh)), film(gxh, V1.prob(ch, Xxh)), film(go, V1.prob(ch, Xo))
        fl = lambda x: float(np.floor(x * 20) / 20)
        report["models"][name] = {"reference": V1.fit(np.vstack([Xr, Xo]), np.r_[np.ones(len(Xr)), np.zeros(len(Xo))]), "channel": ch}
        report["test"][name] = {"reference": {"heldReal": hf, "ours": of, "heldWindowsFlagged": float((ph < 0.5).mean()), "ourWindowsCaught": float((po < 0.5).mean())}, "channel": {"heldMagnates": cm, "heldOthers": cx, "ours": cu}}
        report["bars"][name] = {"reference": fl(min(hf.values())), "channel": fl(min(cm.values()))}
        r_ = lambda d: f"{min(d.values()):.2f}–{max(d.values()):.2f}"
        print(f"{name.upper():6s} reference: held-back real {r_(hf)}, ours {r_(of)} (our windows caught {np.mean(po < 0.5):.0%}, real windows flagged {np.mean(ph < 0.5):.0%})")
        print(f"       channel:   held-back MagnatesMedia {r_(cm)}, held-back others {r_(cx)}, ours {r_(cu)}")
        mu = np.array(report["models"][name]["reference"]["mu"]); co = np.array(report["models"][name]["reference"]["coef"])
        print("       real vs ours, by feature (real mean | ours mean):", ", ".join(f"{keys[i]} {Xr[:, i].mean():.2f}|{Xo[:, i].mean():.2f}" for i in np.argsort(-np.abs(co))[:6]))
    tmp = OUT + ".tmp"; json.dump(report, open(tmp, "w"), indent=1); os.replace(tmp, OUT)
    print("bars", report["bars"])

if __name__ == "__main__":
    {"build": build}[sys.argv[1]]()
