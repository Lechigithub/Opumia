# Picture-to-line fit with the reference index's own SigLIP 2 (picture and text towers), no API.
# fit of a shot = rank of its own spoken line among all lines of its film (1.0 = its own line is the best match):
# a picture that shows what is said ranks its line high; a mood stand-in ranks it near chance (0.5).
import json, sys, numpy as np, torch
from transformers import AutoModel, AutoTokenizer
S=sys.argv[1]; d='data/reference-index/'
M="google/siglip2-so400m-patch14-384"
from transformers import GemmaTokenizerFast
tok=GemmaTokenizerFast.from_pretrained(M,local_files_only=True); model=AutoModel.from_pretrained(M,local_files_only=True).eval()
def T(texts):
  out=[]
  for i in range(0,len(texts),64):
    b=tok(texts[i:i+64],padding="max_length",max_length=64,truncation=True,return_tensors="pt")
    with torch.no_grad(): f=model.get_text_features(**b)
    f=f.pooler_output if hasattr(f,'pooler_output') else f
    out.append(torch.nn.functional.normalize(f,dim=-1).numpy())
  return np.concatenate(out)
def fits(P,L,film):
  P=P/np.maximum(np.linalg.norm(P,axis=1,keepdims=True),1e-6); out=[]
  for f in set(film):
    ix=[i for i,x in enumerate(film) if x==f]
    if len(ix)<8: continue
    Sm=P[ix]@L[ix].T
    for k in range(len(ix)): out.append((f,ix[k],(Sm[k]<Sm[k,k]).mean()))
  return out
rows=[json.loads(l) for l in open(d+'shots.jsonl')]
X=np.fromfile(d+'shots.f16',dtype=np.float16).reshape(len(rows),1152).astype(np.float32)
sel=[i for i,r in enumerate(rows) if r['film'].startswith('MM-') and r.get('line') and len(r['line'].split())>=4]
import os
L=np.load(S+'/chL.npy') if os.path.exists(S+'/chL.npy') else T([rows[i]['line'] for i in sel]); np.save(S+'/chL.npy',L); ch=fits(X[sel],L,[rows[i]['film'] for i in sel])
per={}
for f,_,v in ch: per.setdefault(f,[]).append(v)
fm=np.array([np.mean(v) for v in per.values()])
allv=np.array([v for *_,v in ch])
print('channel (MagnatesMedia, %d shots, %d films): mean fit %.3f; per film p10 %.3f p50 %.3f p90 %.3f; share of shots in the bottom quarter %.0f%%'%(len(allv),len(fm),allv.mean(),*np.percentile(fm,[10,50,90]),100*(allv<0.25).mean()))
# ours: frame every 2 s, the words spoken within ±1.5 s
our=[json.loads(l) for l in open(S+'/ours.jsonl')]
Y=np.fromfile(S+'/ours.f16',dtype=np.float16).reshape(len(our),1152).astype(np.float32)
TS={"wirecard-v3":"out/hand-wirecard/timed-script-marcus.json","wirecard-v2":"out/hand-wirecard/timed-script-marcus.json","ftx-v35":"out/hand-ftx/frozen/v35/timed-script-marcus3.json","ftx-v34":"out/hand-ftx/frozen/v35/timed-script-marcus3.json","theranos":"out/bl4b-theranos/timed-script.json","wework":"out/bl5b-wework/timed-script.json","quibi":"out/bl5c-quibi/timed-script.json","enron":"out/enron-mm/timed-script.json","ftx-agent":"out/ftx-hmw/timed-script.json"}
W={k:[w for s in json.load(open(v))['segments'] for w in s['words']] for k,v in TS.items()}
oi=[];ol=[];ofm=[];ot=[]
for i,r in enumerate(our):
  if r['film'] not in W: continue
  ws=" ".join(w.get('text',w.get('word','')) for w in W[r['film']] if r['t']-1.5<=w['startS']<=r['t']+1.5)
  if len(ws.split())>=4: oi.append(i); ol.append(ws); ofm.append(r['film']); ot.append(r['t'])
OL=T(ol); of=fits(Y[oi],OL,ofm)
pp={}
for f,k,v in of: pp.setdefault(f,[]).append((v,k))
print('ours:')
for f,v in sorted(pp.items(),key=lambda x:-np.mean([a for a,_ in x[1]])):
  a=np.array([x for x,_ in v]); print('  %-12s mean fit %.3f  bottom-quarter shots %.0f%%'%(f,a.mean(),100*(a<0.25).mean()))
json.dump([{"film":ofm[k],"t":ot[k],"line":ol[k],"fit":round(float(v),3)} for f,k,v in of if ofm[k]=="wirecard-v3"],open(S+'/fit-wirecard.json','w'),indent=0)
