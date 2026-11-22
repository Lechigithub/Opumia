"""Which frame of a reference shot do the stored pretrain_vec.npy vectors come from? Embed a few candidate moments
of some shots with the same SigLIP 2 model and compare to the stored vector (cosine). Read-only on Reference/.
usage: python probe_frame.py <film_dir> <shot indices comma-separated>
"""
import json, subprocess, sys, io
import numpy as np, torch
from PIL import Image
from transformers import AutoModel, AutoImageProcessor

MODEL = "google/siglip2-so400m-patch14-384"
film, idx = sys.argv[1], [int(x) for x in sys.argv[2].split(",")]
p = json.load(open(f"{film}/pretrain.json"))
vec = np.load(f"{film}/pretrain_vec.npy")
mp4 = [f for f in __import__("os").listdir(film) if f.endswith(".mp4")][0]
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModel.from_pretrained(MODEL, local_files_only=True, torch_dtype=torch.float16).to(dev).eval()
proc = AutoImageProcessor.from_pretrained(MODEL, local_files_only=True)


def frame(t):
    out = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", f"{film}/{mp4}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True).stdout
    return Image.open(io.BytesIO(out)).convert("RGB")


for i in idx:
    s = p["shots"][i]
    ts = {"start+0.1": s["t0"] + 0.1, "mid": (s["t0"] + s["t1"]) / 2, "end-0.1": s["t1"] - 0.1}
    with torch.no_grad():
        ims = [frame(t) for t in ts.values()]
        x = proc(images=ims, return_tensors="pt").to(dev)
        e = model.get_image_features(pixel_values=x["pixel_values"].half())
        e = getattr(e, "pooler_output", e)
        e = torch.nn.functional.normalize(e.float(), dim=-1).cpu().numpy()
    print(i, {k: round(float(e[j] @ vec[i]), 4) for j, k in enumerate(ts)})
