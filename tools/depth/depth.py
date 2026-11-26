"""Depth map of a still (Depth Anything V2 Small, local Hugging Face cache, nothing downloaded): an 8-bit greyscale PNG,
near = white, far = black, the same size as the picture. Used by @craft DepthPlate to move a real camera through a real
photo with true parallax (build list 6, F1).
  python -I depth.py <in.jpg|png> <out.png> [<in2> <out2> …]
"""
import sys, numpy as np, torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation
M = "depth-anything/Depth-Anything-V2-Small-hf"
proc = AutoImageProcessor.from_pretrained(M, local_files_only=True); model = AutoModelForDepthEstimation.from_pretrained(M, local_files_only=True).eval()
a = sys.argv[1:]
for src, dst in zip(a[0::2], a[1::2]):
    im = Image.open(src).convert("RGB")
    with torch.no_grad():
        d = model(**proc(images=im, return_tensors="pt")).predicted_depth
    d = torch.nn.functional.interpolate(d.unsqueeze(1), size=im.size[::-1], mode="bicubic", align_corners=False)[0, 0].numpy()
    d = (d - d.min()) / max(1e-6, d.max() - d.min())
    from PIL import ImageFilter
    d = np.asarray(Image.fromarray((d * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=max(2, im.size[0] // 500)))) / 255.0  # soften edges so the surface does not tear
    Image.fromarray((d * 255).astype(np.uint8)).save(dst)  # 8-bit: a browser texture is read as 8-bit anyway
    print(dst, im.size)
