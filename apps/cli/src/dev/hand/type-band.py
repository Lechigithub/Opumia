# The channel's typeface properties as a band (type-crops.py rows; lines at least 3 % of the frame tall), and a film of
# ours against it. Per film:
#   strokeMed / strokeHi / strokeLo   stroke thickness / line height: median, 75th and 25th percentile of its lines
#                                     (a film that mixes heavy caps with light type has a wide gap between Hi and Lo)
#   aspectMed                         letter width / height (condensed type is low)
#   inkMed                            share of a line's box covered by letters
#   heavyShare / lightShare           lines with stroke >= 0.12 / <= 0.07
#   python -I type-band.py <reference-crops-dir> <channel> [<our-crops-dir>]   → band json on stdout
import json, sys, os
import numpy as np

def per_film(path):
    by = {}
    for l in open(os.path.join(path, "crops.jsonl")):
        r = json.loads(l)
        if r["h"] >= 0.03: by.setdefault((r["channel"], r["film"]), []).append(r)
    out = {}
    for k, rs in by.items():
        if len(rs) < 5: continue
        st = np.array([r["stroke"] for r in rs]); asp = np.array([r["aspect"] for r in rs]); ink = np.array([r["ink"] for r in rs])
        out[k] = {"strokeMed": float(np.median(st)), "strokeHi": float(np.percentile(st, 75)), "strokeLo": float(np.percentile(st, 25)),
                  "aspectMed": float(np.median(asp)), "inkMed": float(np.median(ink)), "heavyShare": float((st >= 0.12).mean()), "lightShare": float((st <= 0.07).mean()), "lines": len(rs)}
    return out

ref = per_film(sys.argv[1]); ch = sys.argv[2]
films = [v for (c, _), v in ref.items() if c == ch]
others = [v for (c, _), v in ref.items() if c != ch]
K = [k for k in films[0] if k != "lines"]
band = {k: {"p10": float(np.percentile([f[k] for f in films], 10)), "median": float(np.median([f[k] for f in films])), "p90": float(np.percentile([f[k] for f in films], 90)), "othersMedian": float(np.median([f[k] for f in others]))} for k in K}
res = {"what": "type-band.py over type-crops.py lines (h >= 0.03)", "channel": ch, "films": len(films), "band": band}
if len(sys.argv) > 3:
    ours = per_film(sys.argv[3]); res["ours"] = {f"{c}:{n}": v for (c, n), v in ours.items()}
print(json.dumps(res, indent=1))
