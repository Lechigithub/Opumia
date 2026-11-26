"""Voice over bed, measured the way the channel's numbers were (build list 6, G2): the finished mix separated by demucs
htdemucs (two stems, shifts 0, overlap 0.1 — reproduces Reference sound.json at r = 0.999), then per 100 ms: the voice
over the bed while speaking, and how far the bed swells between lines. Local, no API.
  python -I stem-gap.py <film.mp4> [len s = 70]
Channel, first 70 s (37 films): voice over bed p10 8.9 / median 15.8 / p90 21.7 dB; swell p10 1.6 / median 6.7 / p90 13.5.
"""
import os, subprocess, sys, tempfile, numpy as np, soundfile as sf
f = sys.argv[1]; L = sys.argv[2] if len(sys.argv) > 2 else "70"
d = tempfile.mkdtemp(prefix="stemgap-"); w = os.path.join(d, "mix.wav")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-t", L, "-i", f, "-ac", "2", "-ar", "44100", w], check=True)
subprocess.run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs", "--shifts", "0", "--overlap", "0.1", "-o", d, w], check=True, capture_output=True)
def db100(p):
    x, sr = sf.read(p); x = x.mean(1) if x.ndim > 1 else x; h = sr // 10; n = len(x) // h
    return 20 * np.log10(np.sqrt((x[: n * h].reshape(n, h) ** 2).mean(1)) + 1e-9)
v = db100(os.path.join(d, "htdemucs", "mix", "vocals.wav")); b = db100(os.path.join(d, "htdemucs", "mix", "no_vocals.wav"))
sp = v > np.percentile(v, 95) - 20; gap = (~sp) & (b > np.percentile(b, 5) + 6)
print(f"voice over bed {np.median(v[sp] - b[sp]):.1f} dB (channel 8.9–21.7, median 15.8) | bed swell between lines {np.median(b[gap]) - np.median(b[sp]):.1f} dB (channel 1.6–13.5, median 6.7)")
