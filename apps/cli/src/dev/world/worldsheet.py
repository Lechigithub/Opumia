# One sheet per reference film: 30 shots spread over the whole film (shot midpoints), to read the film's world by eye.
import json, glob, os, subprocess, sys
from PIL import Image
S=sys.argv[1]; dates=sys.argv[2:]
rows=[json.loads(l) for l in open('data/reference-index/shots.jsonl')]
for dt in dates:
  fid='MM-'+dt; sh=[r for r in rows if r['film']==fid]
  d=glob.glob(f'Reference/MagnatesMedia/{dt} - */')[0]; mp=glob.glob(d+'*.mp4')[0]
  pick=[sh[int(i*(len(sh)-1)/29)] for i in range(30)]
  tiles=[]
  for k,r in enumerate(pick):
    f=f"{S}/ws_{dt}_{k}.jpg"
    if not os.path.exists(f): subprocess.run(["ffmpeg","-v","error","-y","-ss",f"{(r['t0']+r['t1'])/2:.2f}","-i",mp,"-frames:v","1","-vf","scale=320:180","-pix_fmt","yuvj420p",f])
    tiles.append(f)
  sheet=Image.new('RGB',(320*6,180*5))
  for k,f in enumerate(tiles):
    if os.path.exists(f): sheet.paste(Image.open(f),((k%6)*320,(k//6)*180))
  sheet.save(f"{S}/world_{dt}.jpg",quality=85)
  print(dt, os.path.basename(d.rstrip('/')), len(sh),'shots')
