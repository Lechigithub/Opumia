"""What the channel's frames show that ours do not, in words: SigLIP 2 text prompts scored against the channel's real
shot embeddings (reference index, MagnatesMedia) and against our film's frames (data/world-profile/films/<name>.npz).
Local, no API.  python -I concepts.py <name>
"""
import json, sys, numpy as np, torch
from transformers import AutoModel, GemmaTokenizerFast
M = "google/siglip2-so400m-patch14-384"; name = sys.argv[1]
P = ["a cinematic film still", "a scene from a movie with actors", "a dramatic close-up of a face", "a person's face in shadow",
     "people talking in a room", "a crowd of people", "a businessman in a suit", "an old black and white photograph",
     "archival historical footage", "a news broadcast", "a stock video", "a stock photo of a building", "a modern office building exterior",
     "a city skyline", "a city street at night", "a document or receipt", "a newspaper page", "text on a plain background",
     "a big bold title", "a logo", "a chart or graph", "a map", "money and banknotes", "a computer screen", "a phone screen",
     "hands doing something", "a car", "an airplane", "luxury and wealth", "danger and crime", "a dark moody scene",
     "a bright colourful image", "a vintage film look", "a 3D render", "an illustration or cartoon", "a collage of photos",
     "fire and explosion", "a statue", "a building facade in daylight", "warm golden light", "cold blue light"]
tok = GemmaTokenizerFast.from_pretrained(M, local_files_only=True); model = AutoModel.from_pretrained(M, local_files_only=True).eval()
b = tok(P, padding="max_length", max_length=64, truncation=True, return_tensors="pt")
with torch.no_grad(): t = model.get_text_features(**b)
t = t.pooler_output if hasattr(t, "pooler_output") else t
T = torch.nn.functional.normalize(t, dim=-1).numpy()
rows = [json.loads(l) for l in open("data/reference-index/shots.jsonl")]
X = np.fromfile("data/reference-index/shots.f16", dtype=np.float16).reshape(len(rows), 1152).astype(np.float32)
ix = [i for i, r in enumerate(rows) if r["film"].startswith("MM-") and r["t0"] < 70]
C = X[ix]; C /= np.linalg.norm(C, axis=1, keepdims=True)
O = np.load(f"data/world-profile/films/{name}.npz")["full"]; O = O / np.maximum(np.linalg.norm(O, axis=1, keepdims=True), 1e-6)
# share of frames for which the concept is among the frame's 5 best-matching prompts (robust to scale)
def share(E):
    S = E @ T.T; top = np.argsort(-S, axis=1)[:, :5]
    return np.array([(top == k).any(1).mean() for k in range(len(P))])
c, o = share(C), share(O)
order = np.argsort(-(c - o))
print(f"channel: {len(C)} shots (first 70 s of 37 films) | ours: {len(O)} frames of {name}")
print("THE CHANNEL SHOWS MORE OF:")
for k in order[:12]: print(f"  {P[k]:38s} channel {c[k]:.2f}  ours {o[k]:.2f}")
print("WE SHOW MORE OF:")
for k in order[::-1][:10]: print(f"  {P[k]:38s} channel {c[k]:.2f}  ours {o[k]:.2f}")
