import json, numpy as np, itertools, sys
S=sys.argv[1]; d='data/reference-index/'
rows=[json.loads(l) for l in open(d+'shots.jsonl')]
X=np.fromfile(d+'shots.f16',dtype=np.float16).reshape(len(rows),1152).astype(np.float32); X/=np.linalg.norm(X,axis=1,keepdims=True)
mm={}
for i,r in enumerate(rows):
  if r['film'].startswith('MM-') and r['t0']<70: mm.setdefault(r['film'],[]).append(i)
our=[json.loads(l) for l in open(S+'/ours.jsonl')]
Y=np.fromfile(S+'/ours.f16',dtype=np.float16).reshape(len(our),1152).astype(np.float32); ok=np.fromfile(S+'/ours.ok',dtype=np.uint8)
Y/=np.maximum(np.linalg.norm(Y,axis=1,keepdims=True),1e-6)
of={}
for i,r in enumerate(our):
  if ok[i]: of.setdefault(r['film'],[]).append(i)
def nn(A,a,B,b): return float((A[a]@B[b].T).max(1).mean())
def pair(A,a,B,b): return (nn(A,a,B,b)+nn(B,b,A,a))/2
pv=[pair(X,mm[a],X,mm[b]) for a,b in itertools.combinations(mm,2)]
print('MagnatesMedia, first 70 s, film vs film: p10 %.3f p50 %.3f p90 %.3f max %.3f'%tuple(np.percentile(pv,[10,50,90,100])))
p90=np.percentile(pv,90); mx=max(pv)
names=list(of)
print('\nours, each pair (over the channel max = template):')
res=[]
for a,b in itertools.combinations(names,2): res.append((pair(Y,of[a],Y,of[b]),a,b))
for v,a,b in sorted(res,reverse=True)[:14]: print('  %.3f %s %s  %s'%(v,a,b,'OVER MAX' if v>mx else 'over p90' if v>p90 else ''))
print('  ours median %.3f, share of our pairs over the channel max: %d%%'%(np.median([r[0] for r in res]),100*np.mean([r[0]>mx for r in res])))
