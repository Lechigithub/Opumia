"""SigLIP 2 (so400m-patch14-384) picture embeddings — the one function that embeds the reference and our own pictures.

Input (stdin): JSON lines {"file": path, "t": seconds or null}. A video is read at time t (ffmpeg seek), a still as is.
Output: --out <path>.f16 — N × 1152 float16, L2-normalised, in input order (a picture that cannot be read is a zero row),
plus <path>.ok (one byte per row: 1 read, 0 failed). Progress on stderr. Model weights from the local Hugging Face cache
only (local_files_only); nothing is downloaded. Reads sources read-only.

usage: python -I embed.py --out data/reference-index/shots < items.jsonl
"""
import argparse, io, json, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel
from transformers.utils import logging as hf_logging

hf_logging.set_verbosity_error()
MODEL = "google/siglip2-so400m-patch14-384"
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--batch", type=int, default=32)
ap.add_argument("--workers", type=int, default=8)
a = ap.parse_args()

items = [json.loads(l) for l in sys.stdin if l.strip()]
dev = "mps" if torch.backends.mps.is_available() else "cpu"
dtype = torch.float16 if dev != "cpu" else torch.float32
model = AutoModel.from_pretrained(MODEL, local_files_only=True, dtype=dtype).to(dev).eval()
proc = AutoImageProcessor.from_pretrained(MODEL, local_files_only=True)


def degrade(im, kind, seed):
    """Known-bad versions of a real picture (taste-scorer negatives). Deterministic per seed. Nothing is generated:
    every pixel comes from the source picture."""
    from PIL import ImageEnhance, ImageFilter, ImageOps
    import random
    rnd = random.Random(seed)
    w, h = im.size
    if kind == "soft":  # an upscaled, low-resolution source
        f = rnd.choice([4, 6, 8])
        return im.resize((max(8, w // f), max(8, h // f)), Image.BILINEAR).resize((w, h), Image.BILINEAR)
    if kind == "blur":
        return im.filter(ImageFilter.GaussianBlur(rnd.uniform(3, 7)))
    if kind == "flat":  # washed out, low contrast, dull
        return ImageEnhance.Color(ImageEnhance.Contrast(im).enhance(rnd.uniform(0.35, 0.6))).enhance(rnd.uniform(0.3, 0.6))
    if kind == "mono_tint":  # everything pushed into one colour
        c = rnd.choice([(255, 120, 30), (220, 40, 40), (40, 120, 255), (255, 200, 60)])
        return Image.blend(ImageOps.grayscale(im).convert("RGB"), Image.new("RGB", im.size, c), rnd.uniform(0.35, 0.55))
    if kind == "pasted":  # a small picture pasted on an empty flat stage (no composition)
        bg = Image.new("RGB", im.size, rnd.choice([(18, 18, 22), (240, 236, 228), (30, 40, 70)]))
        s = rnd.uniform(0.35, 0.55)
        sm = im.resize((int(w * s), int(h * s)))
        bg.paste(sm, (rnd.randint(0, w - sm.width), rnd.randint(0, h - sm.height)))
        return bg
    if kind == "corners":  # every channel's logo bug and corner furniture masked (a fair style comparison)
        from PIL import ImageDraw
        d = ImageDraw.Draw(im)
        cw, chh = int(w * 0.16), int(h * 0.16)
        for x0, y0 in ((0, 0), (w - cw, 0), (0, h - chh), (w - cw, h - chh)):
            d.rectangle([x0, y0, x0 + cw, y0 + chh], fill=(0, 0, 0))
        return im
    if kind == "jpeg":
        b = io.BytesIO(); im.save(b, "JPEG", quality=rnd.choice([6, 10, 14])); return Image.open(b).convert("RGB")
    return im


def load(it):
    try:
        if it.get("t") is None:
            im = Image.open(it["file"]).convert("RGB")
        else:
            out = subprocess.run(["ffmpeg", "-v", "error", "-ss", f'{float(it["t"]):.3f}', "-i", it["file"], "-frames:v", "1",
                                  "-vf", "scale=768:-2", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, timeout=60).stdout
            im = Image.open(io.BytesIO(out)).convert("RGB") if out else None
        if im is not None and it.get("degrade"):
            im = degrade(im, it["degrade"], it.get("seed", 0))
        return im
    except Exception:
        return None


vecs = np.zeros((len(items), 1152), dtype=np.float16)
ok = np.zeros(len(items), dtype=np.uint8)
t0 = time.time()
with ThreadPoolExecutor(a.workers) as pool:
    for s in range(0, len(items), a.batch):
        chunk = items[s:s + a.batch]
        ims = list(pool.map(load, chunk))
        good = [i for i, im in enumerate(ims) if im is not None]
        if good:
            with torch.no_grad():
                x = proc(images=[ims[i] for i in good], return_tensors="pt")["pixel_values"].to(dev, dtype)
                e = model.get_image_features(pixel_values=x)
                e = getattr(e, "pooler_output", e)
                e = torch.nn.functional.normalize(e.float(), dim=-1).cpu().numpy()
            for j, i in enumerate(good):
                vecs[s + i] = e[j]
                ok[s + i] = 1
        done = min(len(items), s + a.batch)
        if done % (a.batch * 20) < a.batch or done == len(items):
            r = done / max(1e-6, time.time() - t0)
            print(f"{done}/{len(items)} · {r:.1f}/s · eta {(len(items) - done) / max(r, 1e-6) / 60:.1f} min", file=sys.stderr, flush=True)

vecs.tofile(a.out + ".f16.tmp")
ok.tofile(a.out + ".ok.tmp")
import os
os.replace(a.out + ".f16.tmp", a.out + ".f16")
os.replace(a.out + ".ok.tmp", a.out + ".ok")
print(json.dumps({"rows": len(items), "read": int(ok.sum()), "seconds": round(time.time() - t0, 1)}))
