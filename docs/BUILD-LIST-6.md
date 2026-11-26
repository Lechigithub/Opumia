# Build list 6: every film its own world, proven in the session before any API spend (2026-11-25)

Owner, 2026-11-25:
- Every film's world, meaning and design are built from nothing for that story. Only the reference's production and
  editing style is shared. A thousand films must never look alike, and neither may the same script produced twice.
- No Claude API spend until the session has proved, by building and measuring here, that the spend will not be wasted.
- "Include everything needed for the platform, agents, film and style goal, including what I don't know about."

## Why the films looked like a template (diagnosis, 2026-11-25)

1. **Finished looks moved into shared code.** Every hand-film lesson became a ready-made device in `@craft` with its look
   baked in: BuildWords (gradient-filled glowing words), FlashCut (white flash), LightWash, GradedPlate, money in
   DepthRain. A new film that uses them changes only the colour.
2. **The skills prescribe those devices.** `skills/scenes.md` names them 18 times, `film-designer.md` 4 times.
3. **Wirecard was built on the FTX v35 skeleton.** The same six imports and the same layer stack (plate, light, rain,
   words, flash, whip).
4. **Pictures searched by mood, not story.** "Night city, screens, money" is the same world for every finance story.
   Wirecard v3 by eye: 7 of 18 shots show what is said, 5 are loose stand-ins, 6 are unrelated.
5. **The checks look in the wrong place.**
   - `template_share` only counts the same device at the same moment.
   - The fingerprint has no devices, motifs or objects.
   - The ratchet aimed at one real film (Ponzi's first minute) instead of the channel's spread.

**Measured 2026-11-25 (SigLIP 2, local).**
- MagnatesMedia films are 0.62–0.70 alike in their first 70 s (p10–p90, the closest pair 0.79).
- Our films on different stories sit inside that band (median 0.655).
- So the template is NOT in the pictures. It is in the design layer: devices, word treatment, motion signature. That
  layer needs its own measure.

## The split that fixes it

| Shared by every film (the channel's production style, measured as ranges) | Never shared (the film's own world) |
| --- | --- |
| pace, cut rate, moves vs cuts, frame motion, word holds, text share, clean-footage share | objects, places, documents, people the story owns |
| the voice and its delivery band, the mix levels, hit density, drop-outs, cue changes | motifs, devices, transitions, word treatment, type |
| grade RANGES (each film its own palette inside them) | palette, textures, light, the way money/data/power is shown |
| story grammar (line kinds, turns, re-hooks) | the story's structure and opening, its music and sound world |
| plain building blocks (camera, depth, masks, physics, 3D, blur, time) | every finished look built from those blocks |

## The list

Status: ☐ open · ◐ started · ☑ done and measured. Nothing is ☑ until it is measured in the session.

### A. Proof method (before anything else, no API)
- ☐ A1 **Every check is calibrated on the reference.** It passes ≥ 90 % of real MagnatesMedia films/stretches and
  catches `eval/known-bad.json` and our template films (FTX v34↔v35, Wirecard v2↔v3, Wirecard↔FTX design layer).
  A check that fails real films is wrong, not the reference.
- ☐ A2 **Ratchet on the channel's ranges**, never on one film's numbers (remove the Ponzi-only targets).
- ☐ A3 **Exams on real stretches, sat in the session.** For each craft, the facts behind a real 20–60 s stretch are
  given; I build it using only the platform's skills, tools and memory; local measures score it against the real
  stretch and the band. A failed exam names the missing skill, tool or lesson; fixed and sat again.
- ☐ A4 **Spend gate.** An API run is proposed only with: every exam passed, every check calibrated, a cost estimate
  from measured token use, and the owner's yes.

### B. Measures the platform is missing (local, no model)
- ☑ B1 **Gated 2026-11-25:** `flow-checks.ts:worldChecks` in preflight (judge preview stretches, a draft, never
  stored) and `filmWorld` in QA (the finished film joins the memory); ladders FIT and TEMPLATE; test
  `dev/world-gate-test.ts`. (gate tool: `tools/world/world_check.py`, one frame a second, steady to ±0.005; our 11 films in its memory)
   **Picture-to-line fit** (measured 2026-11-25, `apps/cli/src/dev/world/`: words blurred out first, because the
  unmasked fit rewards writing the line on screen; channel p10 0.614 / median 0.659; Wirecard v3 0.564 and WeWork 0.509
  below it, FTX v35 0.638 inside; still to wire into the gates) (SigLIP 2 picture + text towers): the rank of a shot's own line among its film's lines;
  channel band from 16k real shots; our films scored the same way. Gate `line_fit`; replaces the first-pass Haiku
  rating where calibrated (cheaper).
- ◑ B2 **Design-layer sameness** (word look measured 2026-11-25: channel p90 0.664, FTX v35 ↔ Wirecard v3 0.691 over
  it; pictures alone do not show the template; devices and transitions still to measure): devices, motifs and word treatment read from the plan and kit (which devices, their
  parameters, their share of shots), plus the rendered text and graphic layer (crops of word regions, overlay masks)
  embedded and compared. Measured across whole films, not at the same moment. The band is the channel's own
  between-film spread.
- ◐ B2a **Measured 2026-11-25:** two of the channel's films share 23–44 % of their technique FAMILIES (median 33 %,
  `technique-inventory/rows.json`). 13 families are house style (in ≥ 60 % of films): word-by-word build, key-word
  colour, monochrome grade, filmstrip grid, centred caps title, slow push, drop-out, cue change, b-roll reenactment,
  long holds… So the check has two levels:
  1. families may be shared at the channel's rate;
  2. the IMPLEMENTATION AND LOOK of each family is never shared. Word looks are measured on SigLIP crops of the
     on-screen words (OCR boxes), with the band taken from the channel's own films.
- ☑ B3a **Paper and cards at the channel's rate** (gate `flow-checks.ts:paperChecks` in preflight: clean footage ≥ the
  channel's p10, paper/cards ≤ 1.3× its non-footage share, text ≤ its p90; test `dev/paper-test.ts`) (owner, 2026-11-25: "why … paper, documents, cards a lot … instead of
  showing the story?").
  - **The channel** (visual profile, 276 labelled shots): plain footage 42 % (per film 19–75 %), words over footage
    26 %, documents and screens 4 %, title cards 5 %, quote cards 0.4 %.
  - **Wirecard v4** put receipts, pink sheets or labels on ~14 of 22 beats and left ~3 clean.
  - **Causes:** each line's fact turned into an object, the world's device repeated, drama clips (the channel's
    performed scenes) replaced by paper, and an unmasked measure that rewarded words on screen.
  - **Gate:** document/card share ≤ 2× the channel's, clean footage ≥ its p10 (19 %), words over footage near 26 %.
- ☐ B3 **Device rates per film** from `technique-inventory` (falling money ≈ 0.38/min, floating particles ≈ 15 % of
  stretches, …). Over 2.5× the channel's rate is a gate failure to the owner of the device.
- ☐ B4 **Sameness on every axis**, one report against every earlier film:
  - pictures;
  - design layer;
  - word treatment;
  - transitions;
  - palette;
  - music beds and sound effects;
  - story structure and opening lines;
  - title and thumbnail concept.

  The limit on each axis is the channel's own pair band.
- ☐ B5 **Same script twice** must land inside the channel's between-film band on B2/B4 (the hardest case).
- ☐ B6 **Real-subject share:** the share of shots showing the story's own people, companies, places and documents.
  The channel's band comes from the 276 labelled shots plus the index's `picture` labels.

### C. Remove the template from what exists
- ☐ C1 `@craft` becomes plain blocks.
  - **Blocks:** camera paths, parallax planes, depth of field, masks, particles (no default sprite), physics, 3D cards
    and extrusion, blur, time remap, light. No default colours, glows, fills or timings.
  - **Finished looks move out:** BuildWords' fill and glow, FlashCut's white, LightWash and money rain go back into
    the films that made them (FTX and Wirecard kits) as examples of one film's world.
- ◐ C2 **Skills** (scenes, art director, director and editor rewritten 2026-11-25: world first, grammar not looks; the
  example kit no longer hard-codes a flash):
  - remove every named device;
  - keep the channel's grammar and the why;
  - add "build the world from the story's inventory" with real deconstructions as examples.
- ☑ C3 **Memory and lessons** (audited 2026-11-25: the agents' lessons are about their own films and push new
  metaphors; none prescribes the FTX/Wirecard look, nothing to remove): audit `data/agents/*/magnates-media.md` and the lessons files; drop lessons that
  prescribe a look ("key words huge", "flashes instead of cuts" as a rule, "money rain").
- ◐ C4 **CAPABILITIES** (craft line now says techniques only, looks per film, devices on cooldown): list blocks, not looks.
- ☐ C5 **The regression suite** keeps passing; `hand-transfer` repointed to block-level facts.

### D. The film's world (art director, from the story)
- ☑ D1 **Reference world deconstructions** (37 of 37 written in `packages/agents/skills/worlds/magnates-media.md`: Ponzi,
  1MDB, Eiffel Tower — three scam stories, three different worlds): every analysed MagnatesMedia film (37), taken apart by eye in the session
  from its sheets and frames. Each records:
  - its world: the objects, places, documents, people and materials it shows;
  - its motifs, word treatment, transitions, recurring devices and palette;
  - how far it is from the channel's other films.

  Written to `data/world-profile/magnates-media/`. These are the skill's examples, not templates.
- ☐ D2 **Story inventory from research:** the researcher tags every fact with what can be SEEN. That means its people
  (portraits), company (logo, HQ), places, documents (filings, letters, articles), objects (terminals, ledgers) and
  numbers. This is the world's raw material.
- ☑ D3 **World bible per film** (enforced 2026-11-25: the art director's `write_world`; `write_kit` refused until it
  exists; the brief lists earlier films' concepts to stay unlike) (`design/film/WORLD.md`): what this story is made of, its motifs, how its money, power
  and failure are shown, its word treatment, its transitions. Checked against every earlier film (B2/B4) before any
  scene is designed.
- ☑ D4 **Devices written per film** (enforced 2026-11-25: `write_kit` refuses an earlier film's transition and a kit
  borrowing > 44 % of its effects from one earlier film; plain blocks free; `film-kits.json` records each kit's effects;
  test `dev/device-test.ts`) from the blocks. Every device is new to the film. A device another film used is on
  cooldown like pictures and sounds.

### E. Pictures that show what is said
- ☐ E0 **Reenactment without drama clips.** The channel leans on movie and TV drama clips as performed reenactment
  (Ponzi, 1MDB, Eiffel Tower). Our rule forbids them, so staged stock reenactment with anonymous actors, real period
  footage and composed scenes must cover that role. Measure the channel's drama-clip share and how much of it we can
  reach.
- ☐ E1 **Order:** the story's real subjects first (Wikipedia/Commons portraits and logos, article screenshots of cited
  sources, filings, ≤ 6.5 s press clips). Then archive, then staged stock, then a designed scene around a real picture.
- ☐ E2 **Every pick is scored** with `line_fit` (B1) and the period check; stand-in faces never pass.
- ☐ E3 **Idle stock cap** (mood shots with no subject), at the channel's rate.
- ☐ E4 **The hand builds follow the same order** (Wirecard v4).

### F. Motion, scenes, words (still short of the channel)
- ◑ F1 **Motion** (2026-11-25). Correction: the "17" target was Ponzi, the channel's MOST-moving film of 37.
  - **The channel's band:** frame motion p10 2.9, median 6.3, p90 10.8; moving 60–93 % of the time.
  - **How it moves:** real stills are 1 % of its shots, held 0.4 s; actors performing the line are 32 % and b-roll
    19 %.
  - **Built:** `@craft` `CameraPath` and `Parallax` (real stills as depth planes, using the cut-out tool's new `box`).
  - **Wirecard v4.2:** motion 4.8, moving 74 %, changes by moving 0.82, cuts 7.0/min, all inside the band. The
    reenactment came from staged stock (card tap, trader, audience, typist, a man on the phone).
  - **Was: ours 10.3 against the channel's 17. Find what makes the channel's frames move: camera on
  composites, parallax planes, push-throughs, subject motion. Measure it per technique on the reference; build the
  missing blocks (2.5D parallax from cut-outs, camera paths through layered scenes).
- ☐ F2 **Changes made by moving:** ours 0.83 against the channel's 0.92. Footage shots need moving entries and exits
  (blocks, not one film's whip).
- ☐ F3 **Words:** each film's own treatment; held ≈ 2.5 s; text on ≈ 26–86 % of shots, never every shot; key-word
  colour as a film choice, not a default.
- ☐ F4 **Clean footage** at the channel's share (≈ 42 %, 19–75 % per film).

### G. Sound
- ◑ G1 **Each film's music and sound world** (measured 2026-11-25: the channel's hits are thud 57 % / boom 27 % / click and
  pluck 10 % / object sounds ≈ 3 %, so a film's sound world is its own beds and cue shape, not object noises; beds
  already on cooldown; written into the sound skill) from its story (beds on cooldown; effects chosen for the story's objects
  where the channel does that — measure first, `HIT_CLASS` rule re-checked on the reference).
- ☑ G2 **Mix level** (settled 2026-11-25 with demucs, installed with the owner's OK into the SigLIP environment,
  torch untouched; reproduces the channel's stored stems at r = 0.999).
  - **Our mixes, separated the same way:** Wirecard v4.4 8.8 dB voice over bed, too loud, under the channel's p10
    8.9; median 15.8.
  - **Platform:** `BED_GAP` 10.5/15 (Ponzi) → 15.8/19.1 (37-film medians), `bed_gap` gate on the band; v4.5 reads
    14.5 dB.
  - **The ears mix head** scored louder beds higher (0.79 → 0.64 at −8 dB). It most likely rewards masking our
    synthetic narrator, since the channel's own stretches score 0.84 with quieter beds.
  - **Open:** retrain the mix head with voice-matched pairs (G3).
- ☐ G3 **Retrain the ears mix head** so it judges the mix, not how well the bed hides our voice: pairs with the same
  narrator, beds at measured levels.
- ☐ G3 **Bed choice measured:** a bed that lowers the mix score is refused (Wirecard: "emergent" 0.70 vs "discovery"
  0.79).

### H. Colour
- ☐ H1 **Each film's palette** from its world, inside the channel's ranges (colourfulness 31–46, dark frames, one
  colour ≤ typical). Never one film's numbers.

### I. Story and voice
- ☐ I1 **Opening and structure sameness** against our earlier films (both hand scripts open "In <date>, <company>
  did …").
- ☐ I2 **Voice:** delivery band kept; the same narrator is house style (allowed).

### J. Packaging
- ☐ J1 **Thumbnails at the channel's level** (measured 2.5–4.5/10 against real ones): concept, fusion, finishing.
- ☐ J2 **Thumbnail and title world** from the film's own world; checked in B4.

### K. Platform
- ☐ K1 **Cost model from measured token use per agent** (`allotments.json`, timing.json), so A4 can estimate before
  spending.
- ☐ K2 **Local measures replace paid calls** where calibrated: line fit, taste, design sameness. Cheaper films.
- ☐ K3 **Reliability suite, cloud run and long-form:** after the proof (long-form last, owner).

### L. The proof film
- ◐ L1 **Wirecard v4, world-first** (built 2026-11-25, `build-wirecard-v4.ts`, kit `kit-hand-wirecard-v4.tsx.txt`).
  - **Result:** no earlier film of ours is too close (FTX's word look is gone), the real subjects are in (Braun,
    McCrum, the Marsalek wanted poster, Wirecard's HQ, BPI Manila, the Frankfurt Bull and Bear, a real terminal and
    receipt printer), and the cuts are at Ponzi's 5.3 a minute.
  - **v4.4 (2026-11-25, taste, mix, paper):**
    - **Taste:** split per shot by its two heads (`taste-heads.ts`). The FT's pink was a one-colour wash (pro head) →
      now a sheet beside the picture. Daylight buildings were far from the channel's low-key look → dusk. The title
      was on an empty stage → over the HQ. 31 of 33 frames above the real floor, median 4.7.
    - **Mix 0.79,** inside the channel's band (p10 0.737). A louder or quieter bed and more thuds all scored lower.
    - **Paper cut to the channel's rate:** receipts for 3 moments, the pink once, the terminal once, names; the rest
      clean. Line fit 0.614 (passes), dark frames 11 %, moving 0.82, changes by moving 0.77, cuts 8.8/min: the channel's
      medians. Too close to no earlier film.
  - **v4.3 (2026-11-25):**
    - **Line fit 0.623:** passes the channel's p10 0.614. The weak beats were rebuilt around what the line names: the
      real Frankfurt trading floor, the Reichstag for "Germany", the BaFin building for the regulator, Wirecard's HQ
      for "never there".
    - **Colourfulness 31.0:** in band.
    - **Too close:** to no earlier film.
    - **Motion:** in band.
    - **Mix 0.79:** v3's best. An early thud in the cold open (+0.04); the world's paper and register sounds changed
      nothing; the gap to 0.844 is G2.
    - **Taste 4.6:** above the channel's p10 4.4, below its median 6.1.
  - **v4.2 (2026-11-25, F1):** too close to nothing (one generic paperwork shot had pushed it to WeWork's 0.702 >
    0.698; replaced by the real receipt printer). Line fit 0.601 (p10 0.614), motion in band, colourfulness 30.7,
    taste 4.6, mix 0.75: the gaps left are line fit, taste, colour and mix.
  - **v4.1, not there yet:** line fit 0.565 (channel ≥ 0.614), colourfulness 30 (31–46), motion 4.1 (v3 10.3, channel 17),
    dark frames 2 % (13 %), taste 4.7 (6.1). Real subjects are mostly stills; v3's motion came from stock video and
    number rain, the template itself. Next: F1, the building blocks that make real stills move (cut-out parallax
    planes, camera paths through layers).
  - **Brief:** world bible from its own inventory, real subjects, devices written new, every
  shot line-fit scored, device rates in band.
- ☐ L2 **A second, independent build of the same script** (v4b), designed without looking at v4.
- ☐ L3 **Both pass everything at once:**
  - line fit in band;
  - design sameness against each other and against FTX inside the channel's pair band;
  - device rates;
  - every production-style band;
  - no regression on motion, moves, mix, taste.
- ☐ L4 **Then A4:** a cost estimate and the owner's decision on one agent film.
