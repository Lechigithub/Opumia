# Voice over bed while speaking, and how much the bed swells between lines (per 100 ms, as Reference sound.json).
# usage: python -I mix-measure.py stem-voice.wav stem-bed.wav
import subprocess, sys
import numpy as np
def load(f): return np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", f, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout, dtype=np.float32)
v, b = load(sys.argv[1]), load(sys.argv[2]); n = min(len(v), len(b)) // 1600
db = lambda x: 20 * np.log10(np.sqrt((x.reshape(-1, 1600) ** 2).mean(1)) + 1e-9)
vd, bd = db(v[: n * 1600]), db(b[: n * 1600])
sp = vd > np.percentile(vd, 95) - 20
gap = (~sp) & (bd > np.percentile(bd, 5) + 6)
print(f"voice over bed while speaking {np.median(vd[sp] - bd[sp]):.1f} dB (channel 17.4) | bed between lines vs under voice {np.median(bd[gap]) - np.median(bd[sp]):.1f} dB (channel duck 14.5)")
