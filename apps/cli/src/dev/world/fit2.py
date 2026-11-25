# Line fit with words masked out of the picture (both sides), so writing the line on screen earns nothing.
import json, sys, numpy as np, torch, os
from transformers import AutoModel, GemmaTokenizerFast
S=sys.argv[1]; d='data/reference-index/'; M="google/siglip2-so400m-patch14-384"
rows=[json.loads(l) for l in open(d+'shots.jsonl')]
X=np.fromfile(d+'shots.f16',dtype=np.float16).reshape(len(rows),1152).astype(np.float32)
mi=[json.loads(l) for l in open(S+'/masked/items.jsonl')]
E=np.fromfile(S+'/masked/emb.f16',dtype=np.float16).reshape(len(mi),1152).astype(np.float32); ok=np.fromfile(S+'/masked/emb.ok',dtype=np.uint8)
ME={x['key']:E[i] for i,x in enumerate(mi) if ok[i]}
films=set(json.load(open(S+'/mask/items.json'))['films'])
sel=[i for i,r in enumerate(rows) if r['film'].startswith('MM-') and r.get('line') and len(r['line'].split())>=4]
L=np.load(S+'/chL.npy'); pos={i:k for k,i in enumerate(sel)}
def rank(P,Lx):
  P=P/np.maximum(np.linalg.norm(P,axis=1,keepdims=True),1e-6); Sm=P@Lx.T; return np.array([(Sm[k]<Sm[k,k]).mean() for k in range(len(P))])
per=[];allv=[];raw=[]
for f in sorted(films):
  ix=[i for i in sel if rows[i]['film']==f]
  P=np.stack([ME.get(f"c{i}",X[i]) for i in ix]); Lx=L[[pos[i] for i in ix]]
  v=rank(P,Lx); per.append(v.mean()); allv+=list(v); raw.append(rank(X[ix],Lx).mean())
allv=np.array(allv)
print('channel, words masked (%d films, %d shots): mean fit %.3f (unmasked %.3f); per film p10 %.3f p50 %.3f p90 %.3f; bottom quarter %.0f%%'%(len(per),len(allv),allv.mean(),np.mean(raw),*np.percentile(per,[10,50,90]),100*(allv<0.25).mean()))
tok=GemmaTokenizerFast.from_pretrained(M,local_files_only=True); model=AutoModel.from_pretrained(M,local_files_only=True).eval()
def T(texts):
  b=tok(texts,padding="max_length",max_length=64,truncation=True,return_tensors="pt")
  with torch.no_grad(): f=model.get_text_features(**b)
  f=f.pooler_output if hasattr(f,'pooler_output') else f
  return torch.nn.functional.normalize(f,dim=-1).numpy()
our=[json.loads(l) for l in open(S+'/ours.jsonl')]
TS={"wirecard-v3":"out/hand-wirecard/timed-script-marcus.json","wirecard-v2":"out/hand-wirecard/timed-script-marcus.json","ftx-v35":"out/hand-ftx/frozen/v35/timed-script-marcus3.json","ftx-v34":"out/hand-ftx/frozen/v35/timed-script-marcus3.json","theranos":"out/bl4b-theranos/timed-script.json","wework":"out/bl5b-wework/timed-script.json","quibi":"out/bl5c-quibi/timed-script.json","enron":"out/enron-mm/timed-script.json","ftx-agent":"out/ftx-hmw/timed-script.json"}
W={k:[w for s in json.load(open(v))['segments'] for w in s['words']] for k,v in TS.items()}
print('ours, words masked:')
detail=[]
for f in TS:
  ix=[];ls=[]
  for i,r in enumerate(our):
    if r['film']!=f or f"o{i}" not in ME: continue
    ws=" ".join(w.get('text',w.get('word','')) for w in W[f] if r['t']-1.5<=w['startS']<=r['t']+1.5)
    if len(ws.split())>=4: ix.append(i); ls.append(ws)
  v=rank(np.stack([ME[f"o{i}"] for i in ix]),T(ls))
  print('  %-12s mean fit %.3f  bottom quarter %.0f%%'%(f,v.mean(),100*(v<0.25).mean()))
  detail+=[{"film":f,"t":our[i]['t'],"line":l,"fit":round(float(x),2)} for i,l,x in zip(ix,ls,v)]
json.dump(detail,open(S+'/fit-detail.json','w'),indent=0)
