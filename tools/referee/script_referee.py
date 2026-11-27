"""The script referee: does a narration read like the channel's? (owner, 2026-11-27: the writer must write any script,
at any length, the way the reference would.)

A topic-free style fingerprint, proven on narrations it never saw:
  - features: sentence rhythm (length, spread, short punches, long runs, change between neighbours), how the narrator
    talks (questions, you / I / we), how sentences open (But, So, And, Now…), figures per word, word variety, the rates
    of the channel's 110 most common FUNCTION words (the classic authorship signal; no names or subject words), and how
    each sentence picks up the one before;
  - style model: the channel's narrations against our narrations (logistic regression), scored on windows of the
    channel's ~30 s (100 words); a script's score is the mean over its windows;
  - structure model: the channel's narrations against planted fakes made from them (shuffled, choppy, filler, flat).
Held back: the six narrations the picture referee holds back. Our narrations are transcribed by the same kind of
recogniser as the channel's (whisper), so the referee cannot learn the transcriber.

  python tools/referee/script_referee.py build            → data/referee/magnates-media-script.json
  python tools/referee/script_referee.py score <txt|job>  → JSON: score, bar, windows, structure, gaps
"""
import collections, glob, json, os, random, re, subprocess, sys
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "data")
OUT_MODEL = os.path.join(DATA, "referee", "magnates-media-script.json")
OURS_DIR = os.path.join(DATA, "referee", "script-ours")
HELD = {"MM-20220119", "MM-20221027", "MM-20221115", "MM-20221210", "MM-20221229", "MM-20230327"}
WIN = 100  # words ≈ 30 s of the channel's narration

FUNCTION = set("""a about above after again against all also although am an and any are around as at be because been before
being below between both but by can could did do does doing down during each either even ever every few for from further
had has have having he her here hers herself him himself his how however i if in into is it its itself just least less
many may me might more most much must my myself neither never no nor not now of off often on once only or other our ours
out over own perhaps quite rather really same she should since so some still such than that the their theirs them
themselves then there these they this those though through thus to too under until up upon us very was we well were what
whatever when where whether which while who whom whose why will with within without would yet you your yours yourself
actually almost already back basically enough else instead later maybe simply soon""".split()) | {
    "it's", "that's", "he's", "they're", "didn't", "wasn't", "don't", "couldn't", "wouldn't", "isn't", "he'd", "they'd",
    "there's", "what's", "you're", "we're", "i'm", "let's"}
OPEN = ["but", "so", "and", "now", "because", "which", "this", "that", "in", "the", "it", "he", "they", "and so", "of course"]
PRON = {"he", "she", "they", "it", "this", "that", "these", "those", "his", "her", "their"}
FILLER = ["let's dive in", "buckle up", "but here's the thing", "little did they know", "in a world where",
          "it's important to note", "at the end of the day", "the rest is history"]

def sents(t): return [s.strip() for s in re.split(r"(?<=[.?!])\s+", t) if s.strip()]
def words(t): return re.findall(r"[a-z']+|\d[\d,.]*", t.lower())
def content(s): return {w for w in words(s) if w not in FUNCTION and len(w) > 2 and not w[0].isdigit()}

def coherence(ss):
    if len(ss) < 3: return [0.0, 0.0, 0.0]
    cs = [content(x) for x in ss]
    j = lambda a, b: len(a & b) / max(1, len(a | b))
    near = float(np.mean([j(cs[i], cs[i + 1]) for i in range(len(cs) - 1)]))
    far = float(np.mean([j(cs[i], cs[k]) for i in range(len(cs)) for k in range(i + 3, len(cs))] or [near]))
    pro = float(np.mean([words(x)[0] in PRON for x in ss[1:] if words(x)] or [0]))
    return [near, near - far, pro]

def names(vocab):
    return (["sentence length", "spread of sentence length", "median sentence length", "short punchy sentences (≤ 6 words)",
             "long sentences (≥ 30 words)", "questions", "talking to the viewer (you)", "the narrator as I", "we / us",
             "figures per word", "commas per sentence", "word variety (the channel repeats more, as speech does)",
             "word length"] + [f'sentences opening with "{o}"' for o in OPEN] + [f'the word "{w}"' for w in vocab] +
            ["each sentence picks up words from the one before", "linking to the sentence before more than to far ones",
             "sentences opening on he / they / this", "length change between neighbouring sentences",
             "names inside sentences", "the same name over and over"])

def feats(t, vocab):
    ss = sents(t); ws = words(t); n = max(1, len(ws))
    L = np.array([len(words(s)) for s in ss] or [0])
    c = collections.Counter(ws)
    f = [L.mean(), L.std(), np.median(L), (L <= 6).mean(), (L >= 30).mean(),
         sum(s.endswith("?") for s in ss) / max(1, len(ss)),
         (c["you"] + c["your"]) / n, (c["i"] + c["me"] + c["my"]) / n, (c["we"] + c["us"] + c["our"]) / n,
         sum(1 for w in ws if w[0].isdigit()) / n, t.count(",") / max(1, len(ss)),
         len(set(ws)) / n, float(np.mean([len(w) for w in ws])) if ws else 0.0]
    starts = [" ".join(words(s)[:2]) for s in ss]
    f += [sum(1 for x in starts if x.split(" ")[0] == o or x == o) / max(1, len(ss)) for o in OPEN]
    f += [c[w] / n for w in vocab]
    f += coherence(ss)
    Ls = L if len(L) > 2 else np.array([0, 0, 0])
    f += [float(np.abs(np.diff(Ls)).mean() / max(1, Ls.mean()))]
    caps = [m for x in ss for m in re.findall(r"(?<!^)(?<![.?!]\s)\b[A-Z][a-z]+", x[1:])]
    cc = collections.Counter(caps)
    f += [len(caps) / n, (max(cc.values()) if cc else 0) / n]
    return [float(x) for x in f]

def windows(t, size=WIN, stride=None):
    ws = t.split(); stride = stride or size
    if len(ws) < size * 0.6: return [t] if len(ws) >= 12 else []
    return [" ".join(ws[i:i + size]) for i in range(0, max(1, len(ws) - size + 1), stride)]

def game(t, rng):
    """Cheap tricks a writer could use to look like the channel without writing like it (they lifted one of our scripts
    from 0.07 to 0.62 on the first model): the channel's favourite openers and function words sprinkled in, questions
    and hedges removed. Trained on as ours, so they buy nothing."""
    ss = sents(t)
    ss = [(rng.choice(["This is where ", "And this is ", "Now, ", "But ", "So "]) + x[0].lower() + x[1:]) if i % 3 == 1 and x else x for i, x in enumerate(ss)]
    ss = [x[:-1] + "." if x.endswith("?") else x for x in ss]
    t = " ".join(ss)
    t = re.sub(r"\b(had|about|which)\s", lambda m: "" if rng.random() < 0.6 else m.group(0), t)
    t = re.sub(r"\bthe (\w+)", lambda m: f"the {m.group(1)} of their" if rng.random() < 0.08 else m.group(0), t)
    return t

def game_names(t, rng):
    """The blocking run's trick (2026-11-27, Blockbuster): a name repeated where the channel would say he, it or they,
    to lower word variety ("…so that is where you would rent from Blockbuster today")."""
    names_ = [m for m in re.findall(r"\b[A-Z][a-z]{3,}\b", t) if m.lower() not in FUNCTION]
    if not names_: return t
    top = collections.Counter(names_).most_common(1)[0][0]
    return re.sub(r"\b(it|he|she|they|its|his|their)\b", lambda m: (top + ("'s" if m.group(1) in ("its", "his", "their") else "")) if rng.random() < 0.7 else m.group(0), t)

def plant(t, kind, rng):
    ss = sents(t)
    if kind == "shuffled": rng.shuffle(ss); return " ".join(ss)
    if kind == "choppy": return " ".join(p.strip().capitalize() + "." for s in ss for p in re.split(r",\s*", s.rstrip(".?!")) if p.strip())
    if kind == "filler": return " ".join(s + (" " + rng.choice(FILLER).capitalize() + "." if i % 3 == 1 else "") for i, s in enumerate(ss))
    if kind == "flat": return " ".join(s for s in ss if not s.endswith("?") and not re.search(r"\b(you|your|i|we)\b", s.lower()))
    return t

# ---- a tiny logistic regression kept as plain numbers (no pickles): standardise, then a linear score
def fit(X, y, C=0.3):
    from sklearn.linear_model import LogisticRegression
    mu, sd = X.mean(0), X.std(0) + 1e-9
    m = LogisticRegression(C=C, class_weight="balanced", max_iter=4000).fit((X - mu) / sd, y)
    return {"mu": mu.tolist(), "sd": sd.tolist(), "coef": m.coef_[0].tolist(), "b": float(m.intercept_[0])}
def prob(model, X):
    z = (np.asarray(X) - np.array(model["mu"])) / np.array(model["sd"])
    return 1 / (1 + np.exp(-(z @ np.array(model["coef"]) + model["b"])))

def real_narrations():
    films = json.load(open(os.path.join(DATA, "story-profile", "magnates-media-films.json")))
    films = films if isinstance(films, list) else list(films.values())
    return {f["id"]: " ".join(l if isinstance(l, str) else l.get("text", "") for l in f["lines"]) for f in films}

def our_narrations():
    """Every distinct narration we produced, transcribed by whisper (cached), so ours and the channel's share a transcriber."""
    os.makedirs(OURS_DIR, exist_ok=True)
    model = os.path.join(DATA, "models", "ggml-large-v3-turbo-q5_0.bin")
    seen, out = set(), {}
    for d in sorted(glob.glob(os.path.join(ROOT, "out", "*"))):
        job, mp3, draft = os.path.basename(d), os.path.join(d, "narration.mp3"), os.path.join(d, "script.draft.json")
        if not (os.path.exists(mp3) and os.path.exists(draft)) or job.startswith(("hand-", "search-test")): continue
        try: key = json.load(open(draft))["segments"][0]["text"][:120]
        except Exception: continue
        if key in seen: continue
        seen.add(key)
        txt = os.path.join(OURS_DIR, job + ".txt")
        if not os.path.exists(txt):
            wav = os.path.join(OURS_DIR, job + ".wav")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-ar", "16000", "-ac", "1", wav], check=True)
            subprocess.run(["whisper-cli", "-m", model, "-f", wav, "-otxt", "-of", txt[:-4], "-np", "-nt"], capture_output=True)
            os.remove(wav)
        if os.path.exists(txt): out[job] = open(txt).read().strip()
    return out

def build():
    rng = random.Random(0)
    real, ours = real_narrations(), our_narrations()
    train_text = " ".join(t for k, t in real.items() if k not in HELD)
    vocab = [w for w, _ in collections.Counter(w for w in words(train_text) if w in FUNCTION).most_common(110)]
    Xr, gr = [], []
    for k, t in real.items():
        for w in windows(t): Xr.append(feats(w, vocab)); gr.append(k)
    Xo, go, Xg, gg = [], [], [], []
    for k, t in ours.items():
        for w in windows(t, stride=25):
            Xo.append(feats(w, vocab)); go.append(k)
            Xg.append(feats(game(w, rng), vocab)); gg.append(k)
            Xg.append(feats(game_names(w, rng), vocab)); gg.append(k)
    Xr, Xo, gr, go, Xg, gg = np.array(Xr), np.array(Xo), np.array(gr), np.array(go), np.array(Xg), np.array(gg)
    tr = np.array([g not in HELD for g in gr]); held = ~tr
    # our narrations scored out of fold (by a model that never saw them), the held-back ones by every fold
    names_o = sorted(set(go)); folds = [names_o[i::4] for i in range(4)]
    po = np.zeros(len(Xo)); pg = np.zeros(len(Xg)); ph = []
    for fo in folds:
        te = np.isin(go, fo); tg = np.isin(gg, fo)
        m = fit(np.vstack([Xr[tr], Xo[~te], Xg[~tg]]), np.r_[np.ones(tr.sum()), np.zeros((~te).sum()), np.zeros((~tg).sum())])
        po[te] = prob(m, Xo[te]); pg[tg] = prob(m, Xg[tg]); ph.append(prob(m, Xr[held]))
    ph = np.mean(ph, axis=0)
    film = lambda g, p: {k: float(np.mean(p[g == k])) for k in sorted(set(g))}
    held_films, our_films = film(gr[held], ph), film(go, po)
    style = fit(np.vstack([Xr[tr], Xo, Xg]), np.r_[np.ones(tr.sum()), np.zeros(len(Xo)), np.zeros(len(Xg))])
    # structure: the channel against planted fakes of its own narrations (training films only)
    trtxt = [t for k, t in real.items() if k not in HELD]
    Xp = np.array([feats(plant(w, kind, rng), vocab) for kind in ["shuffled", "choppy", "filler", "flat"] for t in trtxt for w in windows(t, stride=WIN * 3)])
    structure = fit(np.vstack([Xr[tr], Xp]), np.r_[np.ones(tr.sum()), np.zeros(len(Xp))])
    heldtxt = [t for k, t in real.items() if k in HELD]
    planted = {kind: float((prob(structure, [feats(plant(w, kind, rng), vocab) for t in heldtxt for w in windows(t)]) < 0.5).mean()) for kind in ["shuffled", "choppy", "filler", "flat"]}
    held_struct = float((prob(structure, Xr[held]) < 0.5).mean())
    bar = float(np.floor(min(held_films.values()) * 20) / 20)  # the weakest held-back channel narration, rounded down
    # a short script is judged like the channel's own openings of that length (one held-back 90 s opening scored 0.71)
    opens = {k: float(prob(style, [feats(w, vocab) for w in windows(" ".join(t.split()[:300]), stride=WIN // 2)]).mean()) for k, t in real.items() if k in HELD}
    short_bar = float(np.floor(min(opens.values()) * 20) / 20)
    report = {
        "channel": "magnates-media", "builtAt": __import__("datetime").date.today().isoformat(), "window": WIN,
        "held": sorted(HELD), "vocab": vocab, "style": style, "structure": structure,
        "bars": {"film": bar, "short": short_bar, "shortWords": 600, "window": float(np.percentile(ph, 10)), "structure": 0.5},
        "heldBackOpenings": opens,
        "test": {"heldBackWindowsFlagged": float((ph < 0.5).mean()), "ourWindowsCaught": float((po < 0.5).mean()),
                 "heldBackFilms": held_films, "ourFilms": our_films, "gamedWindowsCaught": float((pg < 0.5).mean()), "gamedFilms": film(gg, pg), "plantedCaught": planted,
                 "heldBackFlaggedByStructure": held_struct},
        "trainedOn": {"real": int(tr.sum()), "ours": len(Xo), "ourFilms": len(names_o), "planted": len(Xp)},
    }
    os.makedirs(os.path.dirname(OUT_MODEL), exist_ok=True)
    tmp = OUT_MODEL + ".tmp"; json.dump(report, open(tmp, "w"), indent=1); os.replace(tmp, OUT_MODEL)
    t = report["test"]
    print(f"held-back channel windows flagged {t['heldBackWindowsFlagged']:.0%}, our windows caught {t['ourWindowsCaught']:.0%}, our gamed windows caught {t['gamedWindowsCaught']:.0%} (never-seen scripts; gamed films up to {max(t['gamedFilms'].values()):.2f})")
    print(f"held-back channel films {min(held_films.values()):.2f}–{max(held_films.values()):.2f}; ours {min(our_films.values()):.2f}–{max(our_films.values()):.2f}; film bar {bar}; short-script bar {short_bar} (held-back 90 s openings {min(opens.values()):.2f}–{max(opens.values()):.2f})")
    print("planted fakes caught by the structure model:", ", ".join(f"{k} {v:.0%}" for k, v in planted.items()), f"(held-back channel flagged {held_struct:.0%})")

def text_of(arg):
    if os.path.isdir(arg):
        d = json.load(open(os.path.join(arg, "script.draft.json")))
        return " ".join(s["text"] for s in d["segments"])
    return open(arg).read()

def score(arg):
    M = json.load(open(OUT_MODEL)); vocab = M["vocab"]
    t = text_of(arg); ws = windows(t, stride=WIN // 2)
    if not ws: print(json.dumps({"error": "too short to judge (fewer than 12 words)"})); return
    X = np.array([feats(w, vocab) for w in ws])
    p, q = prob(M["style"], X), prob(M["structure"], X)
    s = float(p.mean())
    # what pulls it away from the channel: each feature's push on the style score, measured from the channel's mean
    mu, sd, coef = np.array(M["style"]["mu"]), np.array(M["style"]["sd"]), np.array(M["style"]["coef"])
    push = ((X.mean(0) - mu) / sd) * coef
    nm = names(vocab)
    craft = [i for i in range(len(nm)) if not nm[i].startswith('the word "')]
    push_c = np.full(len(push), 9.0); push_c[craft] = push[craft]
    gaps = [{"what": nm[i], "ours": round(float(X.mean(0)[i]), 4), "channel": round(float(mu[i]), 4), "more": bool(X.mean(0)[i] > mu[i]), "push": round(float(push[i]), 2)} for i in np.argsort(push_c)[:6] if push_c[i] < -0.15]
    bar = M["bars"]["short"] if len(t.split()) < M["bars"].get("shortWords", 600) else M["bars"]["film"]
    # words used far more than the channel uses them, in the windows that score low: shown as words to CUT (never words
    # to add — adding the channel's favourite words was the first trick). Proof run, Quibi: "had", "than", "before",
    # "after", "which" — written-history phrasing the writer could not see.
    weak = [i for i, x in enumerate(p) if x < 0.5]
    Xw = X[weak].mean(0) if weak else mu; pw = ((Xw - mu) / sd) * coef
    cut = [{"word": nm[i][10:-1], "ours": round(float(Xw[i]), 4), "channel": round(float(mu[i]), 4), "times": round(float(Xw[i] / max(mu[i], 1e-4)), 1)}
           for i in np.argsort(pw) if nm[i].startswith('the word "') and nm[i][10:-1] not in PRON | {"i", "you", "we"} and pw[i] < -0.3 and Xw[i] > mu[i] * 2 and Xw[i] >= 0.008][:6]
    print(json.dumps({"score": round(s, 2), "bar": bar, "pass": s >= bar, "cut": cut,
                      "windows": [round(float(x), 2) for x in p], "weakWindows": [i for i, x in enumerate(p) if x < M["bars"]["window"]],
                      "structure": round(float(q.mean()), 2), "structureFlagged": [i for i, x in enumerate(q) if x < 0.5], "gaps": gaps}))

if __name__ == "__main__":
    {"build": lambda: build(), "score": lambda: score(sys.argv[2])}[sys.argv[1]]()
