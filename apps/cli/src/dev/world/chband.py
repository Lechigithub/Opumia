import json, numpy as np, sys, itertools
d='data/reference-index/'
rows=[json.loads(l) for l in open(d+'shots.jsonl')]
X=np.fromfile(d+'shots.f16',dtype=np.float16).reshape(len(rows),1152).astype(np.float32)
X/=np.linalg.norm(X,axis=1,keepdims=True)
films={}
for i,r in enumerate(rows): films.setdefault(r['film'],[]).append(i)
def nn(a,b):  # mean over shots of a: best match in b
  S=X[a]@X[b].T; return float(S.max(1).mean())
for pre in ['MM','MOON','MBA','HMW','LA']:
  ids=[f for f in films if f.startswith(pre+'-')]
  pv=[]
  for a,b in itertools.combinations(ids,2):
    pv.append((nn(films[a],films[b])+nn(films[b],films[a]))/2)
  pv=np.array(pv); print(pre,len(ids),'films  pair likeness p10/p50/p90/max',*np.round(np.percentile(pv,[10,50,90,100]),3))
