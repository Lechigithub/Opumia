import json, itertools, numpy as np, sys
S=sys.argv[1]; rows=[json.loads(l) for l in open('data/reference-index/shots.jsonl')]
it=[json.loads(l) for l in open(S+'/crops/crops.jsonl')]
E=np.fromfile(S+'/crops/emb.f16',dtype=np.float16).reshape(len(it),1152).astype(np.float32); ok=np.fromfile(S+'/crops/emb.ok',dtype=np.uint8)
F={}
for i,x in enumerate(it):
  if ok[i]: F.setdefault(x['film'] if x['film']!='ch' else rows[int(x['key'][1:])]['film'],[]).append(E[i])
N=20; rng=np.random.default_rng(0)
def samp(k): v=np.array(F[k]); return v[rng.choice(len(v),N,replace=False)]
def cen(k): v=np.array(F[k]); c=v.mean(0); return c/np.linalg.norm(c)
keys=[k for k in F if len(F[k])>=N]
ch=[k for k in keys if k.startswith('MM-')]; ours=[k for k in keys if not k.startswith('MM-')]
def nn(a,b,reps=20):
  out=[]
  for _ in range(reps):
    A=samp(a);B=samp(b);S_=A@B.T; out.append((S_.max(1).mean()+S_.max(0).mean())/2)
  return float(np.mean(out))
for name,f in [('nearest-crop (20 crops each)',nn),('centroid cosine',lambda a,b: float(cen(a)@cen(b)))]:
  v=sorted(f(a,b) for a,b in itertools.combinations(ch,2)); q=lambda p:v[int(p*(len(v)-1))]
  print(name,'channel p10 %.3f p50 %.3f p90 %.3f max %.3f'%(q(.1),q(.5),q(.9),v[-1]))
  r=sorted(((f(a,b),a,b) for a,b in itertools.combinations(ours,2)),reverse=True)
  for s,a,b in r[:8]: print('   %.3f %s %s %s'%(s,a,b,'OVER MAX' if s>v[-1] else 'over p90' if s>q(.9) else ''))
  print('   ours median %.3f'%np.median([x[0] for x in r]))
