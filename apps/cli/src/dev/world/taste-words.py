"""What the trained taste rewards, in words: across the channel's own shots, the correlation between each concept's
SigLIP text match and the taste score (10 × √(pro × channel), data/taste/<channel>-shot.json). Local, no API.
  python -I taste-words.py [name]   (with a name: also our film's frames, from data/world-profile/films/<name>.npz)
"""
import json, sys, numpy as np, torch
from transformers import AutoModel, GemmaTokenizerFast
M = "google/siglip2-so400m-patch14-384"
P = ["a cinematic film still", "a scene from a movie with actors", "a dramatic close-up of a face", "a person's face in shadow",
     "people talking in a room", "a crowd of people", "a businessman in a suit", "an old black and white photograph",
     "archival historical footage", "a news broadcast", "a stock video", "a stock photo of a building", "a modern office building exterior",
     "a city skyline", "a city street at night", "a document or receipt", "a newspaper page", "text on a plain background",
     "a big bold title", "a logo", "a chart or graph", "a map", "money and banknotes", "a computer screen", "a phone screen",
     "hands doing something", "a car", "an airplane", "luxury and wealth", "danger and crime", "a dark moody scene",
     "a bright colourful image", "a vintage film look", "a 3D render", "an illustration or cartoon", "a collage of photos",
     "fire and explosion", "a statue", "a building facade in daylight", "warm golden light", "cold blue light",
     "a famous person", "a celebrity portrait", "a film poster", "a red and black design", "neon lights", "a stage with spotlights",
     "a historical painting", "a factory", "soldiers and war", "a courtroom", "a party", "a luxury car", "a mansion", "a yacht"]
tok = GemmaTokenizerFast.from_pretrained(M, local_files_only=True); model = AutoModel.from_pretrained(M, local_files_only=True).eval()
b = tok(P, padding="max_length", max_length=64, truncation=True, return_tensors="pt")
with torch.no_grad(): t = model.get_text_features(**b)
t = t.pooler_output if hasattr(t, "pooler_output") else t
T = torch.nn.functional.normalize(t, dim=-1).numpy()
tm = json.load(open("data/taste/magnates-media-shot.json"))
wp, bp = np.array(tm["pro"]["w"]), tm["pro"]["b"]; wc, bc = np.array(tm["channelHead"]["w"]), tm["channelHead"]["b"]
sig = lambda z: 1 / (1 + np.exp(-z))
def taste(E): return 10 * np.sqrt(sig(E @ wp + bp) * sig(E @ wc + bc))
rows = [json.loads(l) for l in open("data/reference-index/shots.jsonl")]
X = np.fromfile("data/reference-index/shots.f16", dtype=np.float16).reshape(len(rows), 1152).astype(np.float32)
ix = [i for i, r in enumerate(rows) if r["film"].startswith("MM-")]
C = X[ix] / np.linalg.norm(X[ix], axis=1, keepdims=True)
tc = taste(C); S = C @ T.T
cor = np.array([np.corrcoef(S[:, k], tc)[0, 1] for k in range(len(P))])
print(f"channel shots: {len(C)}, taste median {np.median(tc):.2f}")
print("TASTE RISES WITH:"); [print(f"  {cor[k]:+.2f}  {P[k]}") for k in np.argsort(-cor)[:12]]
print("TASTE FALLS WITH:"); [print(f"  {cor[k]:+.2f}  {P[k]}") for k in np.argsort(cor)[:10]]
if len(sys.argv) > 1:
    O = np.load(f"data/world-profile/films/{sys.argv[1]}.npz")["full"]; O = O / np.maximum(np.linalg.norm(O, axis=1, keepdims=True), 1e-6)
    to = taste(O); print(f"\nours ({sys.argv[1]}): taste median {np.median(to):.2f} over {len(O)} frames; the weakest frames match:")
    So = O @ T.T
    for k in np.argsort(to)[:8]: print(f"  {k + 0.5:5.1f}s taste {to[k]:.2f}  ~ {', '.join(P[j] for j in np.argsort(-So[k])[:3])}")
