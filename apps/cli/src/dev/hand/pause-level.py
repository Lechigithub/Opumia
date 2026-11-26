"""Voice against music without separating stems: in the finished mix, the loudness while the narrator speaks against the
loudness in his pauses (≥ 0.3 s between words, where only the bed plays). The same measure on the channel's films and
ours, so it is not biased by a separation model. Local, no API.
  python -I pause-level.py --channel [--len 70]          # the 37 MagnatesMedia films (first --len s)
  python -I pause-level.py film.mp4 timed-script.json …  # ours
"""
import json, glob, subprocess, sys, numpy as np
L = 70.0
args = sys.argv[1:]
if "--len" in args: L = float(args[args.index("--len") + 1]); args = [a for i, a in enumerate(args) if a != "--len" and (i == 0 or args[i - 1] != "--len")]
def rms_db(f):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", f, "-t", str(L), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True).stdout
    x = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768; n = len(x) // 1600
    return 20 * np.log10(np.sqrt((x[: n * 1600].reshape(n, 1600) ** 2).mean(1)) + 1e-9)
def measure(f, words):
    d = rms_db(f); t = np.arange(len(d)) * 0.1 + 0.05
    speak = np.zeros(len(d), bool); pause = np.zeros(len(d), bool)
    for a, b in words:
        speak[(t >= a) & (t < b)] = True
    for (a0, b0), (a1, b1) in zip(words, words[1:]):
        if a1 - b0 >= 0.3: pause[(t >= b0 + 0.08) & (t < a1 - 0.05)] = True
    pause &= ~speak
    if speak.sum() < 20 or pause.sum() < 5: return None
    return float(np.median(d[speak]) - np.median(d[pause]))
if args and args[0] == "--channel":
    out = []
    for d in sorted(glob.glob("Reference/MagnatesMedia/*/")):
        mp = glob.glob(d + "*.mp4"); pj = glob.glob(d + "pretrain.json")
        if not mp or not pj: continue
        w = [(x["start"], x["end"]) for x in json.load(open(pj[0]))["words"] if x["start"] < L]
        m = measure(mp[0], w)
        if m is not None: out.append(m)
    o = np.array(out)
    print(f"channel, first {L:.0f} s: speech over pauses p10 {np.percentile(o,10):.1f} median {np.median(o):.1f} p90 {np.percentile(o,90):.1f} dB (n={len(o)})")
else:
    for f, ts in zip(args[0::2], args[1::2]):
        w = [(x["startS"], x["endS"]) for s in json.load(open(ts))["segments"] for x in s["words"] if x["startS"] < L]
        print(f"{f}: speech over pauses {measure(f, w):.1f} dB")
