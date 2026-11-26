"""Search the public-domain film library (Library/footage: 240 films, 20,946 indexed shots, SigLIP 2 picture embeddings
from the same model as the reference index) by what a beat needs, ranked by meaning × the channel's trained taste.
Credits, intertitles and title cards are skipped. Writes a numbered contact sheet per query. Local, no API.
  python -I film-search.py <outdir> "query a" "query b" … [--n 12] [--era-from 1900]
"""
import json, os, re, sys, subprocess, numpy as np, torch
from PIL import Image, ImageDraw
from transformers import AutoModel, GemmaTokenizerFast
args = sys.argv[1:]; out = args[0]; qs = [a for a in args[1:] if not a.startswith("--")]
N = int(args[args.index("--n") + 1]) if "--n" in args else 12
os.makedirs(out, exist_ok=True)
M = "google/siglip2-so400m-patch14-384"
tok = GemmaTokenizerFast.from_pretrained(M, local_files_only=True); model = AutoModel.from_pretrained(M, local_files_only=True).eval()
rows = [json.loads(l) for l in open("Library/footage/index/shots.jsonl")]
X = np.load("Library/footage/index/img.npy").astype(np.float32); X /= np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-6)
tm = json.load(open("data/taste/magnates-media-shot.json"))
sig = lambda z: 1 / (1 + np.exp(-z))
taste = 10 * np.sqrt(sig(X @ np.array(tm["pro"]["w"]) + tm["pro"]["b"]) * sig(X @ np.array(tm["channelHead"]["w"]) + tm["channelHead"]["b"]))
bad = re.compile(r"credit|intertitle|title card|text card|caption reads|the end|written text|title screen|subtitle", re.I)
ok = np.array([not bad.search(r.get("caption", "") + " " + json.dumps(r.get("tags", {}).get("action", ""))) for r in rows])
lic = {}
for l in open("Library/footage/licenses.csv").read().splitlines()[1:]:
    p = l.split(","); lic[p[0]] = p
res = {}
for q in qs:
    b = tok([q], padding="max_length", max_length=64, truncation=True, return_tensors="pt")
    with torch.no_grad(): t = model.get_text_features(**b)
    t = t.pooler_output if hasattr(t, "pooler_output") else t
    t = torch.nn.functional.normalize(t, dim=-1).numpy()[0]
    sim = X @ t
    score = np.where(ok, sim + 0.012 * taste, -9)
    top = np.argsort(-score)[: N * 3]
    seen, pick = {}, []
    for i in top:  # at most two shots per film
        f = rows[i]["film"]
        if seen.get(f, 0) >= 2: continue
        seen[f] = seen.get(f, 0) + 1; pick.append(i)
        if len(pick) >= N: break
    sheet = Image.new("RGB", (320 * 4, 180 * ((len(pick) + 3) // 4)))
    for k, i in enumerate(pick):
        try: im = Image.open(rows[i]["key"]).convert("RGB").resize((320, 180))
        except Exception: continue
        ImageDraw.Draw(im).text((5, 5), str(k), fill=(255, 255, 0)); sheet.paste(im, ((k % 4) * 320, (k // 4) * 180))
    name = re.sub(r"\W+", "_", q)[:50]; sheet.save(f"{out}/fs_{name}.jpg", quality=85)
    res[q] = [{"k": k, "sid": rows[i]["sid"], "file": rows[i]["file"], "in": rows[i]["in"], "out": rows[i]["out"], "sim": round(float(sim[i]), 3), "taste": round(float(taste[i]), 2), "caption": rows[i]["caption"][:110]} for k, i in enumerate(pick)]
    print(f"== {q}")
    for r in res[q]: print(f"  [{r['k']}] sim {r['sim']} taste {r['taste']} {r['sid'][:60]} {r['in']:.0f}-{r['out']:.0f}s | {r['caption']}")
json.dump(res, open(f"{out}/film-search.json", "w"), indent=1)
