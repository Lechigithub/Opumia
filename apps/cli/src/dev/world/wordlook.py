# Word look per film (build list 6, B2): crops of the on-screen words (on-device OCR boxes) embedded with the
# reference's SigLIP; a film's word look = the mean of its crops. Channel band = how alike two real films' word looks
# are; ours compared on the same scale. Step 1 (this script): OCR and crop. Step 2: embed.py on crops.jsonl. Step 3: --score.
import json, os, subprocess, sys, itertools, numpy as np
S=sys.argv[1]; m=json.load(open(S+'/mask/items.json')); out=S+'/crops'; os.makedirs(out,exist_ok=True)
if '--score' not in sys.argv:
  from PIL import Image
  items=[x for x in m['items'] if os.path.exists(f"{S}/mask/{x['key']}.jpg")]
  files=[f"{S}/mask/{x['key']}.jpg" for x in items]; boxes={}
  for i in range(0,len(files),200):
    r=subprocess.run(['data/.cache/ocr/ocr',*files[i:i+200]],capture_output=True,text=True)
    for l in r.stdout.splitlines():
      try: j=json.loads(l); boxes[j['file']]=j['boxes']
      except Exception: pass
  json.dump(boxes,open(S+'/ocr-boxes.json','w'))
  our=[json.loads(l) for l in open(S+'/ours.jsonl')]
  rows=None
  with open(out+'/crops.jsonl','w') as w:
    for x,f in zip(items,files):
      bs=[b for b in boxes.get(f,[]) if (b['x1']-b['x0'])*(b['y1']-b['y0'])>0.002 and len(b['text'])>=3]
      if not bs: continue
      im=Image.open(f).convert('RGB'); W,H=im.size
      x0=min(b['x0'] for b in bs); y0=min(b['y0'] for b in bs); x1=max(b['x1'] for b in bs); y1=max(b['y1'] for b in bs)
      p=0.03; c=im.crop((int(max(0,x0-p)*W),int(max(0,y0-p)*H),int(min(1,x1+p)*W),int(min(1,y1+p)*H)))
      o=f"{out}/{x['key']}.jpg"; c.save(o,quality=92)
      film=our[int(x['key'][1:])]['film'] if x['key'][0]=='o' else 'ch'
      w.write(json.dumps({"file":o,"t":None,"key":x['key'],"film":film})+"\n")
  print('crops written')
else:
  rows=[json.loads(l) for l in open('data/reference-index/shots.jsonl')]
  it=[json.loads(l) for l in open(out+'/crops.jsonl')]
  E=np.fromfile(out+'/emb.f16',dtype=np.float16).reshape(len(it),1152).astype(np.float32); ok=np.fromfile(out+'/emb.ok',dtype=np.uint8)
  F={}
  for i,x in enumerate(it):
    if not ok[i]: continue
    f=x['film'] if x['film']!='ch' else rows[int(x['key'][1:])]['film']
    F.setdefault(f,[]).append(E[i])
  F={k:np.array(v) for k,v in F.items() if len(v)>=6}
  def sim(a,b):  # mean nearest-crop similarity both ways (a film's words vs another's)
    S_=F[a]@F[b].T; return (S_.max(1).mean()+S_.max(0).mean())/2
  ch=[k for k in F if k.startswith('MM-')]; ours=[k for k in F if not k.startswith('MM-')]
  v=sorted(sim(a,b) for a,b in itertools.combinations(ch,2)); q=lambda p:v[int(p*(len(v)-1))]
  print('channel word looks, film vs film (%d films): p10 %.3f p50 %.3f p90 %.3f max %.3f'%(len(ch),q(.1),q(.5),q(.9),v[-1]))
  for a,b in sorted(itertools.combinations(ours,2),key=lambda p:-sim(*p)):
    s=sim(a,b); print('  %.3f %-12s %-12s %s'%(s,a,b,'OVER CHANNEL MAX' if s>v[-1] else 'over p90' if s>q(.9) else ''))
