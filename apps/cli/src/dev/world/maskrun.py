# OCR every frame on-device, blur the word boxes away, embed the masked frames with the reference's SigLIP.
import json, os, subprocess, sys
from PIL import Image, ImageFilter
S=sys.argv[1]; m=json.load(open(S+'/mask/items.json')); items=[x for x in m['items'] if os.path.exists(f"{S}/mask/{x['key']}.jpg")]
files=[f"{S}/mask/{x['key']}.jpg" for x in items]
boxes={}
for i in range(0,len(files),200):
  r=subprocess.run(['data/.cache/ocr/ocr',*files[i:i+200]],capture_output=True,text=True)
  for l in r.stdout.splitlines():
    try: j=json.loads(l); boxes[j['file']]=j['boxes']
    except Exception: pass
os.makedirs(S+'/masked',exist_ok=True); n=0
with open(S+'/masked/items.jsonl','w') as w:
  for x,f in zip(items,files):
    im=Image.open(f).convert('RGB'); W,H=im.size; bl=im.filter(ImageFilter.GaussianBlur(28))
    for b in boxes.get(f,[]):
      px=0.012; box=(int(max(0,b['x0']-px)*W),int(max(0,b['y0']-px)*H),int(min(1,b['x1']+px)*W),int(min(1,b['y1']+px)*H))
      if box[2]>box[0] and box[3]>box[1]: im.paste(bl.crop(box),box); n+=1
    o=f"{S}/masked/{x['key']}.jpg"; im.save(o,quality=90); w.write(json.dumps({"file":o,"t":None,"key":x['key']})+"\n")
print(len(items),'frames,',n,'word boxes blurred')
