# World measures (build list 6), local only: no API

Run with the SigLIP environment (`~/lechi_tts/venv/bin/python -I`), from the repo root. `<dir>` is a working folder.

| Script | Measures | Channel band (2026-11-25) |
| --- | --- | --- |
| `chband.py` | how alike two films of a channel are in pictures (mean nearest-shot SigLIP, both ways) | MagnatesMedia whole films 0.68–0.74 (max 0.78) |
| `ourband.py <dir>` | the same on the first 70 s, the channel against our films (`<dir>/ours.jsonl` + `ours.f16`, made with `tools/siglip/embed.py`) | 0.62–0.70 (max 0.79); our films on other stories are inside it, so the template is not in pictures |
| `maskprep.py`, `maskrun.py`, `fit2.py <dir>` | **line fit with on-screen words blurred out** (on-device OCR): the rank of a shot's own spoken line among its film's lines, by SigLIP picture and text towers | p10 0.614, median 0.659, p90 0.719; 13 % of shots in the bottom quarter. Unmasked fit rewards writing the line on screen (FTX v35 0.92), so the masked one is the measure |
| `wordlook.py`, `wl2.py <dir>` | **word look**: SigLIP on crops of the on-screen words, 20 crops a film, nearest-crop both ways | p10 0.595, median 0.638, p90 0.664, max 0.707. FTX v35 ↔ Wirecard v3 0.691: over p90, the template the owner saw |
| `tools/world/world_check.py` | the gate tool: one film (or the judge's preview stretches) against the bands and every earlier film | see above |
| `worldsheet.py <dir> <dates…>` | 30 shots spread over a reference film on one sheet, to take its world apart by eye | `data/world-profile/magnates-media/worlds.md` |

Calibration (A1): the masked line fit ranks Wirecard v2 (0.525), v3 (0.564) and WeWork (0.509) below every channel
film's p10, FTX v35 (0.638) inside the band, the same verdict as watching them. Versions of one film (FTX v34/v35,
Wirecard v2/v3) are over the channel max on pictures and words, as they should be.
