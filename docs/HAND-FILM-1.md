# Hand film 1: FTX, made in the session with no Claude API call (2026-11-23/24)

Owner request: stop spending on the Claude API; prove in the session that a MagnatesMedia-style film can be made,
close every gap, then teach the agents. `OPUMIA_NO_CLAUDE=1` makes any platform Claude call throw
(`agents/llm.ts:client`). Spend: ElevenLabs only (≈ 5k characters including a 12-voice audition).

Film: `out/hand-ftx/film_16x9.mp4` (80 s, 16:9, 32 shots). Scripts: `apps/cli/src/dev/hand/`.
The owner judged pass 2 better than every agent-made film.

## Four passes, measured (local instruments only, first 80 s)
| | taste (real 6.1) | voice (real 0.91) | mix (real 0.84) | luma | dark share | colourfulness | motion | still share | cuts/min |
|---|---|---|---|---|---|---|---|---|---|
| MagnatesMedia, Ponzi 0–80 s | 7.4 | 0.85 | 0.85 | 0.34 | 0.13 | 47.8 | 0.05 | 0.08 | 37.5 |
| MagnatesMedia, Ponzi 420–500 s | 6.9 | 0.95 | 0.88 | 0.39 | 0.02 | 44.4 | 0.04 | 0.00 | 2.3 |
| hand v1 | 4.8 | 0.28 | 0.19 | 0.25 | 0.30 | 40.6 | 0.01 | 0.19 | 14.3 |
| hand v2 | 4.8 | 0.28 | 0.19 | 0.29 | 0.26 | 46.8 | 0.01 | 0.12 | 15.8 |
| hand v3 (mix + camera fixes) | 4.6 | 0.62 | 0.55 | 0.32 | 0.19 | 51.0 | 0.02 | 0.01 | 20.3 |
| **hand v4** (variety, atmospheres) | 4.8 | 0.62 | 0.55 | **0.34** | **0.12** | 50.6 | 0.03 | **0.01** | **20.3** |
| agent Quibi | 4.8 | 0.41 | 0.25 | 0.29 | 0.14 | 40.3 | 0.01 | 0.46 | 15.8 |

The channel's cut pace across whole films is 13–21 a minute. v4 is inside the channel's range on brightness, dark
share, still share and cut pace. It is near the range on motion (0.03 vs 0.04–0.05) and slightly over on colour.
Voice (0.62 vs 0.91) and mix (0.55 vs 0.84) are still short.

## Every gap found, its cause, and status
### Fixed in the engine (they hit every agent film too)
1. **The voice was mixed dry and the bed sat ~22 dB under it with almost no duck.** Ears: voice 0.28, mix 0.19.
   Two early reflections in the narrator chain (`audio.ts:VOICE_ROOM`) and a real duck (−14 dB, ratio 11.7) lifted
   the same narration to voice 0.62 and mix 0.55. The beds also have to sit louder: the hand film uses −9 dB, and
   the director's default should move to match.
2. **The atmosphere resolver screened clips filmed on white** (`grain_loop_on_white`), turning whole shots white.
   Those clips are now excluded (`resolve.ts`). Screened overlays get their lifted blacks crushed (`Media.tsx`).
3. **No money atmosphere.** The library's real "banknotes falling on black" clip is now `atmos: money`.
### Fixed in the hand film; the agents still make these mistakes
4. **Footage never moved when the storyboard camera was static.** The scene camera only moves layers, at 30 %.
   Every footage shot needs a real ken-burns move with a pan (motion 0.01 → 0.03; still share 0.19 → 0.01).
5. **Too dark.** Dimming footage 0.45–0.65 under type gave dark share 0.30. The channel never dims much: cap dim at 0.3.
6. **Documents and figures on a near-black stage** were the weakest frames (taste 3.3–3.9). Put them over real
   footage, defocused.
7. **One stock picture reused for five moments** (the red crash screen). Give each moment its own picture: a bank-run
   queue for "$6 billion out", piles of bills for "$14.6 billion", real coins for "40 % FTT".
8. **Long holds** (a document 5.6 s unchanged). Split them: card → punch-in on the highlighted line.
9. **Slow cold open.** Split shots so the opening cuts every 1.3–1.8 s.
10. **Type that lands then freezes.** Kit type keeps a slow push and float after landing.
### Not closed
11. **Voice (0.62 vs 0.91): the voice itself.** In an audition on the same line and in the same mix, Christopher
    scored 0.77 mixed (0.23 dry). Professional (human-recorded) voices on the account scored higher: Patrick 0.88,
    Marcus K 0.87 (0.64 dry, the most human dry), Jefferson 0.86, Atlas 0.85. Owner decision: "Christopher stays".
12. **Picture taste stuck at 4.8.** The score is √(looks professional × looks like this channel):
    - our frames score as professional as the channel's or more (0.5–0.9 vs 0.42–0.65);
    - the whole gap is "looks like MagnatesMedia" (ours 0.17–0.49 vs 0.83–0.89);
    - raw source clips already score 2.8–5.3 before any design, so the head mostly judges which footage is shown;
    - the channel's own corner logo is worth 0.6–1.0 points, and we leave it out on purpose;
    - by nearest neighbours, the hand film reads 37 % MagnatesMedia and 29 % Moon; the agent Quibi film reads 48 %
      MagnatesMedia.

    The owner ranks the hand film above Quibi, so **this instrument does not rank films the way the owner does**.
    It is not a valid target as built.
13. **Motion 0.03 vs 0.04–0.05.** The channel's frames are always moving: moving footage, parallax and constant
    layer motion. Ours still has stills (cut-outs, cards) between moving shots.
14. **Things the instruments cannot see:** whether the story grips, whether a joke lands, whether a cut is on the
    beat. No person has watched the film besides the owner, and the blind judge needs the API.

## Why the gaps were not all closed in the session
- The voice is an owner decision (Christopher), and no processing gets a dry TTS voice to a human score (best: room +
  mic chain + louder bed, 0.54–0.68).
- The picture-taste head measures channel identity (its logo, its footage) as much as craft, so making better frames
  does not move it. Optimising against it would mean copying the channel's footage and logo.
- My eyes are still frames and contact sheets, and I cannot hear. Sound and timing are judged only through
  instruments, which this test showed are partly wrong.
- Each render-and-measure round takes 5–6 minutes. Four rounds were run; motion and colour can still be improved.

## How to make the agents do this on their own (the plan)
1. **Instruments first.** Retrain the picture head so it measures design, not footage or the logo:
   - mask the logo corner on every real frame;
   - train on pairs of the same footage raw and designed;
   - validate against the owner's ranking (hand film > Quibi > WeWork > FTX short) before any agent is scored on it.

   Re-check the ears the same way.
2. **Move the measures into the doing.** The scene designer and editor see, per shot, as they work: dim, dark share,
   camera motion, hold length, repeated pictures, cut pace in the opening, and legibility of type over its backdrop.
   Each has a refusal in code, so it is prevented rather than found at the gate.
3. **Pictures chosen by looking at sheets.** The picture researcher sees 12–16 candidates per need on one contact
   sheet and picks with the line in view, as in the session. Each moment gets its own picture, never one stock shot
   for five moments. Press in-points are picked from the video's own thumbnail strip.
4. **The channel's grammar in the kit contract, not a template.** Spoken words land as huge condensed caps on their
   own word times; figures count; documents are taped real screenshots with a highlighter sweep, then a punch-in;
   type keeps moving after it lands. Each film's art director still chooses its own typefaces, palette and
   transition.
5. **Mix defaults** (done in the engine): voice room, real duck, beds at about −9 dB.
6. **Voice:** an ears-scored audition among the professional voices, at the owner's word.
7. **Proof:** one film through the agents with these changes (needs the API), scored on the corrected instruments
   and by the owner against this hand film.

## Ratchet: every level frozen, never lower (2026-11-24)
`apps/cli/src/dev/hand/ratchet.ts` keeps every measure of the frozen film in `eval/ratchet/hand-ftx.json`. A new
version is frozen only if no measure is worse (within noise) and one is better. Each frozen version keeps its film
and inputs in `out/hand-ftx/frozen/<tag>/` and has a git tag `ratchet/hand-ftx/<tag>`.

| frozen | what changed | voice (ch. 0.72–0.91) | mix (ch. 0.74–0.84) | luma | dark | colour (≤48) | motion (≥0.04) | still | cuts/min | clean shots (19–75 %) |
|---|---|---|---|---|---|---|---|---|---|---|
| v4 | baseline | 0.62 | 0.48 | 0.34 | 0.12 | 50.6 | 0.036 | 0.6 % | 20 | 12.5 % |
| v5 | narrator Marcus K (ears-chosen) | 0.83 | 0.77 | 0.34 | 0.11 | 50.9 | 0.037 | 0.3 % | 21 | |
| v6 | stronger camera, saturation, larger room | 0.85 | 0.77 | 0.34 | 0.12 | 49.0 | 0.039 | 0 | 21 | |
| v7 | quote on moving footage, cards keep moving | 0.85 | 0.77 | 0.36 | 0.09 | 47.0 | 0.042 | 0 | 21 | |
| v8 | two reflection sets on the narrator | 0.83 | **0.843** | 0.36 | 0.09 | 47.0 | 0.042 | 0 | 21 | 12.5 % |
| v9 | four more clean-footage shots | 0.83 | 0.843 | 0.36 | 0.10 | 46.6 | 0.042 | 0 | 21 | 25 % |
| **v10** | music no longer drowns the voice (below) | **0.805** | retired | **0.36** | **0.10** | **46.6** | **0.042** | **0** | **21** | **25 %** |

Rejected (no improvement): an earlier v10 candidate with re-tuned delivery settings (voice 0.82, mix 0.85: within noise).

### v10: the music overpowered the voice (owner, by ear, 2026-11-24)
- **Measured:** in v9 the voice sat 2.6 dB over the music while speaking; the channel's 37 films sit at 14.4–24.3 dB
  (median 18.1), with the music ducked a median 8.2 dB under speech.
- **Causes:**
  1. The engine did not level the narration. Marcus K arrives 10.7 dB quieter than Christopher, against music at a
     fixed level.
  2. The room reflections (`aecho` with gains 0.8/0.6) also cut the dry voice by about 14 dB.
  3. The music level was tuned on the mix ears, which scored the drowned mix 0.84 and the corrected one 0.58: they
     reward the defect.
- **Fixed in the engine (every film):**
  - every narration is levelled to −16 LUFS before the mix (`audio.ts:NARRATION_LUFS`, `narrationGainDb`);
  - the room stage is unity-gain, so it adds reflections without lowering the voice.
- **Fixed in the hand film:** music cues at −12/−13/−12 dB. The voice now sits 19.1 dB over the music while speaking.
  The owner confirmed by ear: "Sounds right".
- **In the ratchet:**
  - `voiceOverBed` is gated against the channel's 14.4–24.3 dB band;
  - `mix` is still recorded but retired from the gate.
- **Rule taken from this:** a measure that disagrees with the owner's ear or eye is retired, not obeyed. This is the
  second one, after the picture-style heads.

**Status at v10:**
- Every content-free measure is inside the channel's band, now including voice over music.
- Voice is inside the band (0.805 against a 0.72 floor), below the 0.91 median.

**What no instrument can settle yet:**
- Picture "style": the trained heads read content (period, subject, logo), not craft. They rank the hand film
  below agent films the owner judged worse, so they cannot be targets until they agree with the owner's ranking.
- Story, humour, cutting on the beat.

The judge for these is the owner, or a blind test that has been validated against the owner.

## Picture style with the subject held equal (2026-11-24)
`side-by-side.ts` puts each of our 32 shots beside the 3 MagnatesMedia shots nearest to it in SigLIP image space
(`out/hand-ftx/side-by-side/sheet_*.jpg`, `pairs.json`). The match is good (crowd with crowd, burning money with
burning money, documents with documents), so what still differs is style.

**Method check.** Real films run through the same matching (`CONTROL=<film id>`) also come out brighter and more
saturated than their neighbours. The match leans dark, so per-shot grade differences from it are not evidence. Grade
is measured instead over whole films with one function on both (`grade-band.py`, `look-band.ts`).

**The look bands were wrong.** The ratchet's first bands came from two 80 s windows of one film (Ponzi). Over the
first 80 s of all 37 films (`data/quality-profile/magnates-media-look-band-80s.json`, p10–p90):

| | old band | real band | v10 | v11 |
|---|---|---|---|---|
| luma | 0.30–0.45 | 0.18–0.35 (median 0.25) | 0.36 | 0.305 |
| dark share | 0–0.13 | 0.03–0.36 | 0.10 | 0.11 |
| colourfulness | 31–48 | 25–75 | 46.6 | 42.5 |
| motion | 0.04–0.10 | 0.018–0.048 | 0.042 | 0.039 |
| still share | 0–0.08 | 0.013–0.15 | 0 | 0 |
| cuts/min | 13–38 | 8–49 (median 22.5) | 21 | 21 |

- Earlier fix 5 ("too dark: cap dim at 0.3") pushed the film the wrong way. The channel is low-key.
- The ratchet now reads these bands.
- **v11:** the act grade no longer lifts exposure (1.1 → 1.0), and every footage shot gets 0.22 more dim, with type at
  full brightness. Every other measure is held (taste-floor frames 27 = 27).

Over whole films (`grade-band.py`), v10 also had harder contrast (0.74 vs p90 0.71) and more blown highlights (4.9 %
vs p90 3.2 %).

**Seen by eye on the sheets, not yet measured:**
1. Names are never small lower-third boxes. The channel sets a name huge beside a cut-out (thick white sticker
   outline), or doesn't show it at all.
2. Big figures fill most of the frame width and often carry texture (footage inside the letters, metal, glow). Ours
   are centred, about a third of the width, plain yellow Anton.
3. The type changes with the moment: condensed caps, thin mixed case ("Dark Days", "BURNED"), red emphasis words.
   Ours is yellow and white Anton on every card, which reads as a template.
4. Press and stock footage are often pushed into one mood: duotone, red/green/purple wash, black and white (whole
   films 2.5–22.5 % of frames carried by one colour, median 12.5 %; ours 5 %).
5. Footage never holds still in ours; the channel holds about 4 % of the time.

### v12 candidate: the five eye-found differences built (2026-11-24)
1. Names are set huge beside the person (`Name`: condensed caps sized to the box, role in light type above). Cut-outs
   get a white sticker outline instead of a gold glow. No lower-third boxes.
2. Figures are spelled out across most of the frame ("$32 BILLION") in metallic gold or red with a glow; the label is
   in light condensed type above.
3. A second type voice (`Kinetic font: "thin"`, light Oswald, mixed case, wide tracking) for time and place cards
   ("Four days later", "Enron, 2001"); less yellow.
4. Four more one-colour shots: gold coins, a red bank-run queue, the walk-out in black and white, the court scrum in
   red. Whole-film one-colour frames went from 3 % to 10 % (channel median 12.5 %).
5. One still hold (the courthouse, no camera move): still share 0 → 2.5 % (channel 1.3–15 %).

Ratchet: no regression; it measures none of 1–3. Per the plan, the owner judges these by eye before v12 is frozen.
`out/hand-ftx/v11-vs-v12.jpg` has six before/after pairs.

### Text measures (2026-11-24, after v12 was frozen on the owner's eye)
`text-band.py` reads every frame's words with on-device OCR (macOS Vision), the same function on the channel's films
and ours, ignoring the channel's corner logo. The band is the first 80 s of all 37 films
(`data/quality-profile/magnates-media-text-band-80s.json`). The ratchet now guards all six measures.

| | channel p10–p90 (median) | v11 | v12 |
|---|---|---|---|
| frames with words | 0.47–0.74 (0.60) | 0.73 | 0.72 |
| tallest line, share of height | 0.087–0.219 (0.144) | 0.177 | 0.182 |
| widest line, share of width | 0.32–0.64 (0.52) | 0.35 | 0.53 |
| small boxed name tags | 0–0.14 | 0.07 | 0.07 |
| capitals | 0.21–0.95 (0.64) | 0.52 | 0.49 |
| spread of type sizes | 0.56–0.89 (0.74) | 0.80 | 0.80 |

- The widest line moved from near the channel's floor to its median. That is v12's change, now visible to an
  instrument.
- Over the first 10 min instead of 80 s, the channel carries fewer and smaller words (0.39–0.69, 0.086–0.172). The
  band must match the film's length; longer films will need their own window.
- Not measured: whether the type looks good, and font identity. Those stay with the owner's eye.

### Voice: more takes do not close it (2026-11-24, rejected candidate)
- Two more Marcus K takes per line (seeds 37, 53; ≈ 2.3k ElevenLabs characters), and the best take kept per line by
  word error, then the dry ear-score. Eight of 11 lines scored 0.02–0.08 higher dry.
- In the film the voice measured 0.79 against v12's 0.805, within noise. Taste rose 4.9 → 5.1, but that comes from the
  shifted timings changing which frames are sampled, not from any picture change. Not frozen; v12's narration is
  restored.
- Line 6 ("Then the head of Binance, Changpeng Zhao, said he would sell every FTT on his books") scores 0.14–0.26 dry
  on every take, so its wording is the problem, not the take.
- The voice sits inside the channel's band (p10 0.72) and below its median (0.91). Picking takes does not move it. What
  is left: rewording the lines that score low for speech, auditioning other voices on the whole script in the mix, or a
  human narrator. Each is the owner's call.

### Lettering measured as lettering (2026-11-24)
- **Crops** (`type-crops.py`): every line of words that on-device OCR finds is cut out and reduced to its letter shapes
  (white on black; no footage, no colour). It is run on all 154 reference films of the five channels
  (`data/type-crops/`, 11,321 lines) and on ours.
- **Properties** (`type-band.py` → `data/quality-profile/magnates-media-type-band.json`): stroke weight against line
  height, letter width, ink, and the shares of heavy and light lines. MagnatesMedia's lettering is heavier than the
  other four channels' (median stroke 0.143 vs 0.124; heavy lines 54–85 %), of middling width, and rarely light.
  Looking at the crops, it mixes narrow heavy caps (Anton-like) with wide rounded heavy caps (geometric sans).
- **Type-only scorer** (`type-style.ts`, `data/taste/magnates-media-type.json`): SigLIP on letter shapes, trained
  on the real channels only. On held-out films: line AUC 0.73, film AUC 0.91. Our films and the agent films all
  score 0.46–0.51, too close together to rank. It is informational, not gated.
- **Repeatability:** 30 sampled frames read one film's median stroke anywhere from 0.105 to 0.139, so the ratchet
  samples 120 frames (0.127–0.129).
- **v13 candidate:** the thin second type style is replaced by wide heavy caps (Montserrat ExtraBold), now also on
  "72 HOURS", "SELL EVERY FTT" and "STEALING $8 BILLION", and the labels are heavier. At 120 frames: stroke
  0.122 → 0.129 and heavy lines 51 → 55 %, both into the band; light lines 20 → 18 % (band ≤ 16 %); width
  0.342 → 0.347 (band ≥ 0.38). The steps are within noise, so the ratchet does not freeze it by itself.
- **What still holds us outside the band:** light and narrow lines come mostly from the five document and post
  shots (many lines of thin article text each), and from Anton on the remaining cards.

### v14: articles show a few big lines; more wide heavy caps (frozen on the measures)
- The CoinDesk card shows only its headline and the "$14.6 billion" line, and the CBS card only its headline (which
  carries the spoken quote), larger and with the highlight on the words being said (`Card crop`). The Binance quote
  and "A VERY BAD BET" use the wide heavy caps.
- At 120 frames, v13 → v14:
  - median stroke 0.129 → 0.141 (channel median 0.143);
  - heavy lines 53 → 59 %;
  - lightest quarter 0.076 → 0.082 (band ≥ 0.086);
  - small boxed text 7 → 2 %.
- Still outside the band: light lines (20 %) and letter width (0.35). Of the 60 light lines left, nearly all are text
  inside the footage, not the film's lettering: banknote printing, a stock phone screen in Russian behind the tweet,
  ticker numbers, the real article and tweet text. Closing them means choosing footage with less text in it, which is
  a picture choice. The measure cannot yet tell designed lettering from text in the footage.

### v15: the text in the footage (frozen on the measures)
- Each crop now carries its time (`type-crops.py` `t`), so light and narrow lines can be traced to their shot. One
  shot held most of them: S26 ("for stealing $8 billion", 38 of 60 light lines and 60 of 112 narrow ones). Its
  stock money bundles have paper bands with printed Cyrillic text. S09's banknote printing added a few more.
- Fix: shallow-focus blur behind the type on S26 (`dof 0.85`) and S09 (`0.6`), as the channel keeps money soft behind
  big figures.
- Every typeface measure is now inside the channel's band:

  | | v14 | v15 |
  |---|---|---|
  | median stroke | 0.141 | 0.168 |
  | lightest quarter | 0.082 | 0.112 |
  | width | 0.351 | 0.436 |
  | heavy lines | 59 % | 73 % |
  | light lines | 20 % | 6.5 % |

  No other measure moved beyond noise.
- The widest line is at the band's top edge (0.654 vs p90 0.641): watched, not acted on.

### v16 candidate: the script rewritten in the channel's way of telling (2026-11-24)
- **Measured gap.** The v1 script's 16 sentences were labelled with the channel's line kinds (labelled in the session
  as the API is off, so I also labelled six real 80 s passages as a control). v1 had quotes 37 % (channel 0–7 %),
  bare facts 25 % (9–19 %), explains 6 % (16–40 %), and no viewer address, question, tease or motive. The real
  passages address the viewer ("Meet Ross", "we'll get to that"), ask ("So what happened?"), tease and explain; in
  about 67 real lines there were 2 quotes.
- **v2 script** (`script.ts`; v1 in `script-v1.ts.txt`): same verified facts and beats.
  - It opens on a moment in the present tense, asks "So how does a company worth that much vanish in less than a
    week?", teases "It started with one document" and explains the coupons ("only worth something while people
    believe in them").
  - It turns to the viewer: "And you can guess what happened next."
  - It names a fear from the record: c22, he "started to worry that FTX would not be fine".
  - It quotes twice: the tweet and the judge.
  - Its 18 sentences: quotes 2, facts 3, explains 3, address, question, tease and motive 1 each. 87 s at 157 wpm,
    Marcus K.
- **Re-cut.** Every shot, word-timed type, hit and music cue is moved onto the new words (no warp). Five shots are
  added: the question over SBF on air, "LESS THAN A WEEK" over burning paper, "ONE DOCUMENT" over a data room, clean
  coins under the coupon line, and the tweet callback in black and white with "WOULD NOT BE FINE". The ending lands
  on "A VERY BAD BET" and "NEVER GET CAUGHT". The 40 % donut now comes in on the words "forty percent".
- **Two fixes made along the way:**
  - the take cache served an old script's takes for a reused voice tag; a take is now reused only if it was spoken
    from the same text;
  - the ratchet measured only the first 80 s, so a longer film's ending fell outside it; it now measures the whole
    film, up to 2 min.
- **Ratchet.** Every look, grade, text and typeface measure is in band. Taste-floor frames rise 24 → 27. Picture
  taste has a median of 4.7 against v15's 4.9, past its 0.15 noise, in two renders; that scorer reads content and
  which footage moments its samples hit. Voice is 0.778 against 0.805 (within noise). Not frozen by the measures;
  the owner judges.

### v17: every measure at its best level at once (frozen)
- **Bests per measure** (owner: "only freeze the better part"). The ratchet keeps, for each measure, the best level
  any version reached, and where it came from (`best` in `eval/ratchet/hand-ftx.json`).
  - `--lock-best <label>` records a candidate's better measures without freezing the film.
  - A regression is judged against those bests; an improvement against the frozen film.
  - v16's story gains, widest text and taste-floor count were locked this way. Taste and voice kept v15's levels.
- **Story in the ratchet:** each script sentence records its line kind (`script.ts` `kinds`); the build writes
  `story-kinds.json`. The ratchet scores the shares with `storyProfile` against the channel's 30-film band: quotes,
  facts, explanations, teases, motives, and lines that talk to the viewer. They are labelled in the session, so this is
  weaker than the other instruments until the blind comparison exists. Counted strictly per sentence, v2 is: quotes
  15.8 % (the tweet counts as two; band ≤ 6.7 %), facts 21 % (≤ 18.9 %), explains 15.8 % (≥ 15.6 %), tease, motive and
  viewer lines inside the band.
- **Taste noise:** the same film's taste median moves by up to 0.3 with the sample grid alone (`taste-noise.ts`). It
  is now the mean of four grids: v15 4.82, v17 4.85. The earlier "4.9 → 4.7" was the grid.
- **v17** = v16 plus:
  - washes the channel uses on its weakest shots: "ASSETS ARE FINE." set big in gold, the $8 billion and "would not
    be fine" shots in red, SBF on air in gold, a tint on Ray, a lighter Enron card;
  - line 6 says "a rival" instead of the name, which the name card already shows (dry voice score 0.19 → 0.24);
  - cuts anchored to the words (`timed-script-cutref-v2.json`), so a re-recorded line cannot misalign a cut.

  Frozen: no measure below its best, and it improves on v15 in story and taste-floor frames.
- **Still open in the story:** quotes and bare facts are above the band.

### v18 candidate: quotes and facts inside the band; the voice falls (not frozen)
- **Script.**
  - The tweet is spoken as one sentence ("FTX is fine, assets are fine.").
  - The judge's line is the narrator's own conclusion, drawn from the court's finding (c31): "In the end, he had made
    a very bad bet, that he would never get caught."
  - The sentencing is a moment: "On the twenty-eighth of March, 2024, Bankman-Fried stood before Judge Kaplan, who
    sentenced him…" (c11, c13).
  - Story shares: quotes 5.6 %, facts 16.7 %, explanations 22 %, tease, motive and viewer lines all inside the band.
    Scenes are 16.7 % (band ≤ 11 %).
- **Cuts** for the changed lines start on their own words (`atWord`); one music drop moved onto "In the end".
- **Taste** 4.92 (four-grid mean), taste-floor frames 33.
- **Voice measured properly** (`voice-noise.ts`, four window grids; the ratchet now uses the mean, noise 0.02): v15
  0.806, v17 0.754, v18 0.740 after three more takes on the five weakest lines.
  - v17's freeze let a voice drop through: one grid read 0.787. The voice best stays at v15's 0.806, so it must come
    back before any freeze.
  - Per line in the mix (`voice-lines.ts`): the tweet spoken as one sentence scores 0.49 (two sentences: 0.65), "Even
    by his standards…" 0.65 (v1's line 0.78), "the head of Binance, a rival…" 0.68.
  - The new lines read less naturally with this voice. It is not take luck.

### v19 candidate: silent tweet, lines reworded for the ear (not frozen)
- **The tweet is shown in silence:** no narration; typing and a ding as it lands, with "ASSETS ARE FINE." set in gold.
- **Line 6:** "Then the boss of rival exchange Binance said he would sell every FTT on his books. You can probably guess what
  happened next."
- **Line 9:** "Even he wrote that he had never seen such a complete failure." This is v1's wording, which read best; it
  matches the CBS headline and is the film's one quote.
- **Cuts anchored within lines:** every word-timed element refers to a word of its line (`G(line, k)`), and cut
  times carry over line by line (`warp`). Lines can change length, or be removed, without misaligning anything.
- **Speech-only voice:** the ratchet scores the voice only where the narration covers 75 % of a window
  (`narration-words.json`). v15 is unchanged at 0.806.
- **Result:**
  - story inside the band: quotes 5.9 %, facts 17.6 %, explanations 17.6 %;
  - taste 4.93; taste-floor frames 37;
  - voice 0.759 against the 0.806 best.
- **Voice per line in the mix:** most lines read 0.84–0.88, better than their v15 counterparts. Line 9 reads 0.70,
  line 6 0.73, line 11 0.76, line 3 0.79. The film-level gap now comes from those four lines and from windows that
  straddle the pauses between lines.

### v19 frozen; v20: the channel's staples (frozen)
- **v19:** the voice score is retired from the gate. The owner judged the voice fine; the score depends on the words,
  so it cannot compare films with different scripts. Voice work stays at sound quality and mix, at the voice's natural
  pace. v19 froze on the story gains.
- **Staples:** techniques in at least 20 % of the channel's stretches (`data/technique-inventory/magnates-media/band.json`).
  v19 lacked the filmstrip or contact-sheet layout (25 %) and text on a label shape (24 %).
- **v20 adds:**
  - "Soon after that tweet" as a filmstrip sliding from the tweet to SBF on air to the court scrum;
  - "A WEEK EARLIER" and "SOON AFTER THAT TWEET" on tilted gold labels;
  - two more high-contrast monochrome shots, SBF on air and the sentencing with only the gold "25" in colour.
- **Ratchet:** `staplesCovered` is the share of the checkable staples the film's plan uses (scenes, storyboard,
  manifest). v19 0.857 → v20 1.0. Three staples cannot be read from the plan: hard cuts with a palette reset, literal
  narration-matched visuals, stretches with a music bed and no effects. They wait for the blind comparison.

### v21: sound at the channel's density (frozen)
- **Band** (first 90 s of the 37 films, from the reference index's per-shot hits, drops and cue changes;
  `data/quality-profile/magnates-media-sound-band.json`):
  - hits 0.6–5.3 a minute (median 2.6);
  - music drop-outs 0–2.5 a minute;
  - cue changes 0.6–1.8 a minute;
  - hits are mostly thuds and booms, with a few typing clicks and pops.
- **v20** had 7.4 hit moments a minute and 2.7 drop-outs a minute. Too dense: the channel lets most stretches play on
  the music alone, which is one of its staples (35 %).
- **v21 keeps hits on the biggest reveals only:** the ding as the tweet lands, FOUR DAYS LATER, BANKRUPT, SELL,
  $6 BILLION, 25 years, BAD BET. It removes the whoosh, the coins, the riser, the Enron hit and the typing, and the
  first drop-out. Result: 4.0 hits and 2.0 drops a minute.
- **The ratchet now guards** hits, drops and cue changes per minute against that band.

### v22: thumbnail and title (frozen)
- **Thumbnail** (`thumb.ts`, the platform's `ThumbnailScene`), built from the film's own real pictures: the burning
  $100 bill (Pexels) as the background, the Commons cut-out of SBF with a red rim of light, the FTX logo card, fire
  screened under it, "$32B" in gold and "GONE" on a red box. This follows the channel's measured thumbnail habits: a
  cut-out person as hero (~40 %), a real photo behind, glow 51 %, money/fire ~30 %, one or two heavy words, label box
  35 %. No generated imagery.
- **Finishing as in the platform** (`publish.ts`): rendered at 2560×1440, brought down with Lanczos, unsharp mask and
  film grain. The first render was soft (sharpest detail 1,579 vs the channel's floor of 2,288; grain 2.5 vs median
  17.5). Finished: sharpest 4,159, typical 704, contrast 204, grain 15.9, all inside the channel's band.
- **Title:** "FTX: The $32 Billion Empire That Vanished In 4 Days". The channel's pattern; every word supported by the
  narration.
- **Ratchet:** thumbnail sharpness, detail, contrast and grain are guarded. A new measure inside its band counts as a
  gain. The thumbnail taste head reads 3/10 ("like our past work"); it reads content, so it is recorded, not gated,
  like the picture heads.

### v23: moments at the film's length, cut timing, footage quality, two more staples measured (frozen)
- **Moment lines:** judged against 90 s windows of the channel's films (median 17.6 %, p90 41 %), not whole films
  (3–11 %). Ours is 17.6 %, at the median: the same length mismatch as the first look bands.
- **Cut timing** (`cut-band.json`, reference-index definitions: distance from a cut to the nearest word boundary,
  share in pauses ≥ 0.15 s). The channel: 0.06–0.21 s (median 0.10), 5–28 % in pauses. Cutting exactly on words gave
  0.04 s, too mechanical. Rule: a cut that opens a line stays in the pause before it; a cut inside a line lands half
  way into its word. Now 0.08 s, 25 % in pauses.
- **Footage quality at the moment each shot uses** (`footage-quality.ts`; quality-gap measured each clip at 1 s of
  the source, which is not what the film shows). The old phone clip was soft and flat wherever it was used (4 shots),
  and the fire shot was flat at 3 s. They are replaced by two sharp, contrasty phone clips (Pexels 6414098, 6279142)
  and the fire at 10 s. 6 of 34 shots under the channel's floor → 1 (the server room, 1 contrast point short). Up to
  10 % is the channel's own rate.
- **Two staples made measurable on the film:** a hard cut with a palette reset (mean colour before and after a cut)
  and a stretch carried by music alone (10 s with no effect). 16 of the 17 staples above 20 % are now checked; literal
  narration-matched pictures are checked by eye (next).

### v24 candidate: pictures checked against their lines, thumbnail variants, voice chain, picture taste
- **#7, every shot against the words spoken over it** (contact sheets with each shot's words). Two misfits, both the
  same joggers clip: "Customers ran" (a pun, not a bank run) and "Whatever it had found was beyond saving" (no link).
  They are replaced by a crowd running across a square in sepia (Pexels 5695519) and crumpled papers in a bin (Pexels
  7668957), both above the channel's frame floor. The rest fit their line literally.
- **#4, thumbnail:** six variants of the same subject, compared on the thumbnail scorer, which is fair when the
  content is held equal, and all inside the channel's quality band.
  - The court cut-out scored best (4.3) but its background removal left a rectangle: rejected by eye.
  - "$32B → $0" (3.9) breaks the platform's rule (a figure the narration never says): rejected.
  - Kept: variant f, the clean cut-out large like the channel's heroes, "$32B" and "BANKRUPT" (3.7, against 3.6).
  - The scorer still reads it as "our past work": partly closed.
- **#5, voice sound quality and mix only** (`voice-chain.ts`: the same narration through chain variants over the
  film's own bed, speech-only windows, four grids):
  - current 0.764, dry 0.756, lighter room 0.763, more presence 0.772, gentler compression 0.750, warmer 0.760;
  - all within the measure's noise (±0.02);
  - the chain is at its best within what can be measured; no change made; no ElevenLabs characters spent.
- **#3, picture taste** on its own calibration: real channel shots median 6.1, p10 4.4; ours 4.9, inside the range,
  lower part. The head was trained partly to tell our earlier films from the channel's, so raising its number further
  means optimising against a detector of our own past work. The blind comparison is the valid test.
- **Ratchet:** no regression. The changes are judged by eye or on unguarded scores, so v24 is not frozen on the
  measures.

### v25: designed scenes in one visual world (frozen)
- **The owner's verdict:** "the film you created is clearly not at the style reference quality". Judged by eye with
  16-frame strips of 20 s from Uber, Silk Road and Ponzi beside ours.
  - Each real film holds one look for a whole stretch: Uber black-and-white with blue type, Silk Road acid green and
    magenta, Ponzi sepia and gold.
  - They build scenes (a lightbulb on black, a hooded figure in particles, a network of light) and compose the type
    into them.
  - Ours flipped between looks every few seconds and was mostly stock with captions.
  - None of the ratchet's instruments saw it: they measure averages, not whether neighbouring shots share a world or
    whether a frame is built.
- **Measured:** designed pictures take 16–83 % of the channel's opening screen time (median 64 %, reference-index
  picture label; `designed-band.json`); ours had 6.5 %. A per-frame colour-concentration measure (`coherence.py`) did
  not separate us: the warm grade unified the hues. That instrument is not used.
- **v25, fourteen shots rebuilt as designed scenes** from the engine's worlds with real pictures in them:
  - the date over the typing phone in black and white with a gold bar;
  - the tweet and the articles taped on paper;
  - "ASSETS ARE FINE." over a gold duotone of the phone;
  - a light burst for "FOUR DAYS LATER";
  - the hourglass for "LESS THAN A WEEK" (library, CC BY-SA);
  - the 40 % donut over a duotone of coins with a coin pile;
  - SBF with FTX coupons falling;
  - a terminal for "72 HOURS";
  - Enron on paper;
  - the money-pile duotone for "$8 BILLION";
  - a title sequence: "FTX — the $32 billion empire that vanished" over the city at night.
- **One world:** every footage shot is pulled into the same warm black-and-white (`WORLD_WASH`, a pale tone at
  strength 0.6), worlds use the dark ground and the gold accent, red stays only in the danger words, and the cut-outs
  are warm monochrome copies.
  - A saturated sepia was tried first: 43 % one-colour frames.
  - Ponzi itself, a sepia-gold film, has 12 %. Its world is mostly dark and neutral, with gold as the accent.
- **Result:**
  - designed share 0.065 → 0.398 (in band);
  - picture taste 5.0 → 5.13, its first real gain;
  - no regression.
  - The staple check now recognises any monochrome tone.
- **Still different by eye:** the type is still mostly laid on top, not composed into the scene; the paper worlds
  are plain; several stock clips still read as stock.

### v27 candidate: atmospheres made visible, warm palette, type in the scene (not frozen)
- **Watched one frame a second and "listened"** (Whisper transcript and loudness every 0.5 s, `listen.ts`) beside
  the first 90 s of Ponzi.
  - Ponzi builds each frame from 3–6 moving layers: real photos inside objects, money raining over cut-outs, fire,
    actors in period costume, a 3D room, glowing script names, 3D letters behind people, chapter emblems.
  - v25 was one picture and a caption, in grey-gold.
- **Engine fix (every film, the agents' too):** atmospheres (smoke, embers, dust, light leaks, falling money) were
  placed at depth 1, under the scene at depth 2, so they never showed. They now sit at depth 3
  (`manifest.ts`).
- **Sound, measured properly:** the channel masters at −12 to −13 LUFS, like ours, and its opening loudness range runs
  1.8–14.9 LU (median ≈ 3.5); ours is 2.6. The "ours is loud throughout" judgement from the loudness trace was
  overstated: sound is inside the channel's range.
- **v27:**
  - a warm gold tint instead of grey-gold;
  - an atmosphere on 34 scenes;
  - the title in 3D gold letters;
  - "A VERY BAD BET" behind the court cut-out; the name partly behind SBF's cut-out.
- **Ratchet:**
  - one-colour frames 0.333 (band ≤ 0.225): the tint at 0.3 over-saturates the crowd and coins;
  - the monochrome staple is lost.
  - Not frozen.
- **By eye:** warmer and more alive, still far off Ponzi.
  - Most scenes are still one picture with a light atmosphere, where Ponzi composes several pictures and effects
    into one staged image.
  - The cut-outs of CZ still look pasted on.
  - The type is still mostly the same caps.
