# Frames for the text-masked line-fit measure: ours (every 2 s) and a sample of the channel's shots that carry words.
import json, os, subprocess, glob, sys
from concurrent.futures import ThreadPoolExecutor
S=sys.argv[1]; out=S+'/mask'; os.makedirs(out,exist_ok=True)
items=[]
for i,l in enumerate(open(S+'/ours.jsonl')):
  r=json.loads(l); items.append({"key":f"o{i}","file":r["file"],"t":r["t"]})
rows=[json.loads(l) for l in open('data/reference-index/shots.jsonl')]
dirs={os.path.basename(d.rstrip("/"))[:8]:d for d in glob.glob('Reference/MagnatesMedia/*/')}
films=sorted({r['film'] for r in rows if r['film'].startswith('MM-')})[::3]  # every third film: 13 films
for i,r in enumerate(rows):
  if r['film'] in films and (r.get('textArea') or 0)>0.001 and r.get('line') and len(r['line'].split())>=4:
    d=dirs.get(r['film'][3:]); mp=glob.glob(d+'*.mp4') if d else []
    if mp: items.append({"key":f"c{i}","file":mp[0],"t":(r['t0']+r['t1'])/2})
def grab(it):
  f=f"{out}/{it['key']}.jpg"
  if not os.path.exists(f): subprocess.run(["ffmpeg","-v","error","-y","-ss",f"{it['t']:.2f}","-i",it["file"],"-frames:v","1","-vf","scale=768:-2","-pix_fmt","yuvj420p",f],check=False)
  return f
with ThreadPoolExecutor(8) as ex: fs=list(ex.map(grab,items))
json.dump({"films":films,"items":items},open(S+'/mask/items.json','w'))
print(len(items),'frames,',sum(1 for x in items if x['key'][0]=='c'),'channel text shots from',len(films),'films')
