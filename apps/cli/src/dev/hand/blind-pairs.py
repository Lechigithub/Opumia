# Blind pairs for the owner (2026-11-24): ten 8 s stretches of our film beside a real MagnatesMedia film at the same
# point of its opening, ten different real films, random order per pair. The corners of both are blurred (the
# channel's logo bug would give it away), both are matched in size, frame rate and loudness. One video plays every
# pair (A, then B, then the question). The answer key is written to key.json and never printed.
#   python -I blind-pairs.py <our film> <film list> <out dir>
import json, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
ours, lst, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
refs = [l.strip() for l in open(lst) if l.strip()]
rnd = random.Random(20261124)
pick = rnd.sample(refs, 10)
starts = [round(i * 8.4, 1) for i in range(10)]
W, H = 1280, 720
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 72)
small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 40)
def card(text, sub, f, dur):
    im = Image.new("RGB", (W, H), (12, 12, 12)); d = ImageDraw.Draw(im)
    d.text((W / 2, H / 2 - 30), text, fill=(255, 255, 255), font=font, anchor="mm")
    if sub: d.text((W / 2, H / 2 + 50), sub, fill=(200, 200, 200), font=small, anchor="mm")
    png = f + ".png"; im.save(png)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", png, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", str(dur), "-r", "24", "-vf", "format=yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", f], check=True)
CORNERS = "split=5[a][b][c][d][e];[b]crop=iw*0.16:ih*0.16:0:0,gblur=sigma=18[tl];[c]crop=iw*0.16:ih*0.16:iw*0.84:0,gblur=sigma=18[tr];[d]crop=iw*0.16:ih*0.16:0:ih*0.84,gblur=sigma=18[bl];[e]crop=iw*0.16:ih*0.16:iw*0.84:ih*0.84,gblur=sigma=18[br];[a][tl]overlay=0:0[x1];[x1][tr]overlay=W*0.84:0[x2];[x2][bl]overlay=0:H*0.84[x3];[x3][br]overlay=W*0.84:H*0.84"
def clip(src, t, f):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", src, "-t", "8", "-filter_complex", f"[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps=24,{CORNERS},format=yuv420p[v];[0:a]loudnorm=I=-16:TP=-1.5,aresample=48000[a]", "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", f], check=True)
key, parts = [], []
for i in range(10):
    t = starts[i]
    real_first = rnd.random() < 0.5
    a, b = (pick[i], ours) if real_first else (ours, pick[i])
    ta, tb = t, t
    fa, fb = f"{out}/p{i+1:02d}_A.mp4", f"{out}/p{i+1:02d}_B.mp4"
    clip(a, ta, fa); clip(b, tb, fb)
    ca, cb, cq = f"{out}/c{i+1:02d}a.mp4", f"{out}/c{i+1:02d}b.mp4", f"{out}/c{i+1:02d}q.mp4"
    card(f"Pair {i+1} — A", "", ca, 1.2); card(f"Pair {i+1} — B", "", cb, 1.2); card(f"Pair {i+1}", "Which one is the real channel: A or B?", cq, 2)
    parts += [ca, fa, cb, fb, cq]
    key.append({"pair": i + 1, "real": "A" if real_first else "B", "realFilm": os.path.basename(os.path.dirname(pick[i])), "at": t})
json.dump(key, open(f"{out}/key.json", "w"), indent=1)
with open(f"{out}/list.txt", "w") as fl:
    for p in parts: fl.write(f"file '{os.path.abspath(p)}'\n")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{out}/list.txt", "-c:v", "libx264", "-crf", "23", "-c:a", "aac", f"{out}/blind_pairs.mp4"], check=True)
print("blind pairs written; key saved (not printed)")
