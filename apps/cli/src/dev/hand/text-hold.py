# How long the words stay up (owner, 2026-11-24: "words transition into scenes smoothly and never feel rushed, so
# viewers can actually see what the word says clearly"). Same function on the channel's films and ours: frames at 4 fps
# over the first WINDOW s, on-device OCR (macOS Vision), every big line (height >= 4 % of the frame, >= 3 letters)
# followed while it stays on screen.
#   holdMed      median seconds a big line stays readable (from the first frame it is read to the last)
#   perWord      median seconds on screen per word of the line
#   shortShare   share of big lines that are up for less than 1.25 s
#   holdTime     the hold of the typical second of words on screen (time-weighted median: OCR flicker on textures and
#                banknotes is many tiny readings that weigh almost nothing)
#   readable     share of the time words are on screen that belongs to lines held >= 1.5 s
#   python -I text-hold.py <film.mp4> [--window 60]
#   python -I text-hold.py --band <list.txt> [--window 60]
import json, os, re, subprocess, sys, tempfile
from difflib import SequenceMatcher
import numpy as np

OCR = os.path.join(os.path.dirname(__file__), "../../../../../data/.cache/ocr/ocr")
FPS = 4
GAP = 4  # a line the OCR misses for up to 1 s (motion blur, a word moving) is still the same line
LOGO = ("magnates", "media")


def frames(path, window):
    tmp = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
    subprocess.run(["ffmpeg", "-v", "error", "-t", str(window), "-i", path, "-vf", f"fps={FPS},scale=960:540", os.path.join(tmp, "f%04d.png")], check=True)
    return sorted(os.path.join(tmp, x) for x in os.listdir(tmp))


def ocr(paths):
    rows = {}
    for i in range(0, len(paths), 60):
        r = subprocess.run([OCR, *paths[i:i + 60]], capture_output=True, text=True).stdout
        for l in r.splitlines():
            if l.strip():
                j = json.loads(l)
                rows[j["file"]] = j["boxes"]
    return rows


WORDS = set(w.strip().lower() for w in open("/usr/share/dict/words")) if os.path.exists("/usr/share/dict/words") else set()


def real(t):
    """a line a viewer would read: most of its tokens are words or figures (OCR noise on textures and bills is not)"""
    toks = [x for x in t.split() if len(x) >= 2]
    if not toks:
        return False
    ok = sum(1 for x in toks if x in WORDS or re.fullmatch(r"[$]?[0-9][0-9.,%]*[a-z]?", x) or (x.endswith("s") and x[:-1] in WORDS))
    return ok / len(toks) >= 0.6 and any(len(x) >= 4 for x in toks)


def same(a, b):
    if a == b or (len(b) > 4 and (b in a or a in b)):
        return True
    if SequenceMatcher(None, a, b).ratio() > 0.6:
        return True
    ta, tb = set(a.split()), set(b.split())
    return len(ta & tb) >= max(1, min(len(ta), len(tb)) // 2)


def norm(t):
    return re.sub(r"[^a-z0-9$%]+", " ", t.lower()).strip()


def measure(path, window=60.0):
    ps = frames(path, window)
    rows = ocr(ps)
    open_ = []  # [text, first, last]
    done = []
    for k, p in enumerate(ps):
        lines = [norm(b["text"]) for b in rows.get(p, []) if b["y1"] - b["y0"] >= 0.05 and sum(c.isalpha() for c in b["text"]) >= 3 and not any(w in b["text"].lower() for w in LOGO)]
        seen = set()
        for ln in lines:
            hit = next((o for o in open_ if o[2] >= k - GAP and same(o[0], ln)), None)
            if hit:
                hit[2] = k
                if len(ln) > len(hit[0]):
                    hit[0] = ln
                seen.add(id(hit))
            else:
                o = [ln, k, k]
                open_.append(o)
                seen.add(id(o))
        for o in [o for o in open_ if o[2] < k - GAP]:
            done.append(o)
            open_.remove(o)
    done += open_
    for p in ps:
        os.remove(p)
    if os.environ.get("DEBUG"):
        done = [o for o in done if real(o[0])]
        for o in sorted(done, key=lambda o: o[1]):
            print(f"{o[1] / FPS:6.2f} {(o[2] - o[1] + 1) / FPS:5.2f}  {o[0][:60]}", file=sys.stderr)
    done = [o for o in done if real(o[0])]
    holds = [((o[2] - o[1] + 1) / FPS, max(1, len(o[0].split()))) for o in done]
    if not holds:
        return None
    hs = sorted(h for h, _ in holds)
    cum = np.cumsum(hs)
    tw = float(hs[int(np.searchsorted(cum, cum[-1] / 2))])
    return {
        "lines": len(holds),
        "holdTime": round(tw, 2),
        "readable": round(float(sum(h for h in hs if h >= 1.5) / max(1e-6, cum[-1])), 3),
        "holdMed": round(float(np.median([h for h, _ in holds])), 2),
        "perWord": round(float(np.median([h / w for h, w in holds])), 2),
        "shortShare": round(float(np.mean([h < 1.25 for h, _ in holds])), 3),
    }


def main():
    a = sys.argv[1:]
    window = float(a[a.index("--window") + 1]) if "--window" in a else 60.0
    if a[0] == "--band":
        rows = {}
        for p in [x.strip() for x in open(a[1]) if x.strip()]:
            try:
                m = measure(p, window)
            except Exception:
                m = None
            if m:
                rows[p.split("/")[-2][:40]] = m
                print(json.dumps(m), file=sys.stderr, flush=True)
        keys = ["holdTime", "readable", "holdMed", "perWord", "shortShare"]
        band = {k: {q: round(float(np.percentile([r[k] for r in rows.values()], p)), 3) for q, p in (("p10", 10), ("med", 50), ("p90", 90))} for k in keys}
        print(json.dumps({"films": rows, "band": band, "window": window}, indent=1))
    else:
        print(json.dumps(measure(a[0], window)))


main()
