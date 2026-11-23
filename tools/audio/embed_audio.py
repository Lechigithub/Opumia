"""Audio embeddings — the ears the agents and the gate listen with (one function for the reference and our films).

Two local models, weights from the Hugging Face cache only (local_files_only; nothing is downloaded):
  - AST fine-tuned on AudioSet (MIT/ast-finetuned-audioset-10-10-0.4593): what a stretch of sound IS — voice, music,
    effects, their balance and character (768-d, pooled);
  - wav2vec2 (facebook/wav2vec2-lv-60-espeak-cv-ft): how speech is spoken — phonetic and prosodic texture (1024-d, mean
    of the last hidden layer).
Input (stdin): JSON lines {"file": path, "t": seconds, "dur": seconds}. Each window is decoded with ffmpeg to 16 kHz mono.
Output: --out <path>.f16 — N × 1792 float16 rows (AST then wav2vec2, each L2-normalised), plus <path>.ok (1 byte per row).
Reads sources read-only.

usage: python -I embed_audio.py --out data/sound-taste/x < items.jsonl
"""
import argparse, json, subprocess, sys

import numpy as np
import torch
from transformers import ASTFeatureExtractor, ASTModel, Wav2Vec2Model, Wav2Vec2FeatureExtractor
from transformers.utils import logging as hf_logging

hf_logging.set_verbosity_error()
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
a = ap.parse_args()
items = [json.loads(l) for l in sys.stdin if l.strip()]
dev = "mps" if torch.backends.mps.is_available() else "cpu"
ast_fx = ASTFeatureExtractor.from_pretrained("MIT/ast-finetuned-audioset-10-10-0.4593", local_files_only=True)
ast = ASTModel.from_pretrained("MIT/ast-finetuned-audioset-10-10-0.4593", local_files_only=True).to(dev).eval()
w2_fx = Wav2Vec2FeatureExtractor.from_pretrained("facebook/wav2vec2-lv-60-espeak-cv-ft", local_files_only=True)
w2 = Wav2Vec2Model.from_pretrained("facebook/wav2vec2-lv-60-espeak-cv-ft", local_files_only=True).to(dev).eval()


def load(it):
    # every window — the channel's and ours — goes through the SAME chain first (one AAC encode at YouTube's rate,
    # the same loudness and bandwidth), so the ears judge the sound, not how a file happened to be encoded
    cut = ["ffmpeg", "-v", "error", "-ss", str(max(0.0, float(it.get("t") or 0))), "-t", str(float(it.get("dur") or 4)), "-i", it["file"], "-vn", "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "128k", "-f", "adts", "-"]
    aac = subprocess.run(cut, capture_output=True, check=False).stdout
    dec = ["ffmpeg", "-v", "error", "-f", "aac", "-i", "-", "-af", "highpass=f=70,lowpass=f=7600,loudnorm=I=-20:TP=-2:LRA=11", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]
    raw = subprocess.run(dec, input=aac, capture_output=True, check=False).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    return x if x.size > 16000 * 0.8 else None


rows = np.zeros((len(items), 1792), dtype=np.float16)
ok = bytearray(len(items))
for i, it in enumerate(items):
    try:
        x = load(it)
        if x is None:
            continue
        with torch.no_grad():
            f = ast_fx(x, sampling_rate=16000, return_tensors="pt").to(dev)
            e1 = ast(**f).pooler_output[0].float().cpu().numpy()
            g = w2_fx(x, sampling_rate=16000, return_tensors="pt").input_values.to(dev)
            e2 = w2(g).last_hidden_state[0].mean(0).float().cpu().numpy()
        e1 /= np.linalg.norm(e1) + 1e-9
        e2 /= np.linalg.norm(e2) + 1e-9
        rows[i] = np.concatenate([e1, e2]).astype(np.float16)
        ok[i] = 1
    except Exception as err:  # a window that cannot be read is a zero row
        print(f"skip {it.get('file')}: {err}", file=sys.stderr)
    if i % 25 == 0:
        print(f"{i}/{len(items)}", file=sys.stderr)
rows.tofile(a.out + ".f16")
open(a.out + ".ok", "wb").write(bytes(ok))
