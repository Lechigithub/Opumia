# Build list 2: from template to film (owner go-ahead 2026-11-22)

Why: film 1 (`out/film1-kodak-3/`, `docs/FILM1-FINDINGS.md`) was produced end to end, but it looks like the earlier
Kodak films: the same cards, fonts and patterns. You can hear the voice joins, and scenes jump. The causes are
structural:
- a menu renderer, not design;
- agents chase averages, not taste;
- agents judge from still frames;
- narration is built sentence by sentence and glued with digital silence;
- the editor follows rules, not craft;
- type is set from CSS presets;
- every film starts from the same place;
- there is no visual memory;
- the gate repairs by degrading.

Order (each step depends on the ones before it). Status: ☐ open · ◐ in progress · ☑ done.

1. ☑ **Measuring tools.** All five are built, and film 1 is scored as the baseline (`dev/film-baseline.ts` →
   `out/film1-kodak-3/baseline.json`).
   - **Seams** (`senses/seams.ts`): dead air, hard onsets and cutoffs, room jumps. Film 1's narration: 43 seams
     (32 dead air), 29.5 a minute. The final mix hides dead air under the music, so the check runs on the narration
     track.
   - **Jumps** (`senses/jumps.ts`): a same-picture change with nothing bridging it, against a flash, blur or dissolve
     bridge. Band from 12 real MagnatesMedia films (`dev/detector-band.ts` → `data/detector-band/`):
     - the channel changes the same picture 4.4–11.2 times a minute, always bridged, mostly by flashes;
     - its unbridged jumps are median 1.2 a minute.
     Film 1: 0 bridged and 2 unbridged a minute. It caught 3 of the 4 editor splits; the miss had a heavy overlay.
   - **Legibility** (`senses/legibility.ts`): WCAG contrast of the letters against what is behind them, and cap height
     at phone size. Film 1: 3 of 19 text elements fail. Limit: text on a drawn label box is measured against the box's
     surroundings, so "HOLDING STILL" was missed.
   - **Video taste judge** (`agents/clip-judge.ts`): 8-frame strips judged blind beside two real stretches close in
     meaning, plus the trained taste heads. Calibration: a real stretch was called the imitation 4 of 9 times (fair is
     3 of 9; the judge leans to "imitation"). Film 1 was picked out in 7 of 11 stretches; realness 0.43, trained taste
     4.4.
   - **Uniqueness** (`agents/uniqueness.ts`): mean nearest-neighbour similarity of frame vectors. Real film pairs sit
     at 0.652–0.706 (p10–p90). Film 1 is 0.72 from the earlier Kodak film, too close; it sits at 0.64–0.67 from our
     films on other topics.
2. ☑ **Eyes and ears in the agents** (`apps/cli/src/inspect.ts:inspectStretch`). Every watched stretch carries the
   step-1 detectors' report: unbridged jumps and pops against the channel's band, unreadable text at phone size,
   voice seams, and trained taste.
   - **Who gets it:** every agent that watches. The editor, sound designer and showrunner through `watchPlan`; the
     scene designer and colourist through a new `watch_stretch` tool (they saw stills before); viewer QA on the
     finished file.
   - **Skills:** each says how to act on the report.
   - **Tested on film 1, 40–50 s:** it caught the unbridged jump at 43 s, 7 voice seams, and taste 5.1 against 6.1.
3. ☑ **Seamless voice** (`narration/directed.ts`).
   - **Passages:** sentences are spoken in passages, one take each and never cut inside (up to about 600
     characters, breaking at chapters and held beats).
   - **Pauses:** shortened only inside the TTS's own digital silence, to at most 0.22 s.
   - **No dead air:** every digital silence is filled with room noise at the passage's own quiet level, and passages
     meet on their own room with equal-power crossfades.
   - **Sound check:** each risky word is checked in a window around its own aligned time. Words the transcriber
     misses are confirmed or rejected by their sounds; a quotation was dropped by Whisper but spoken, consonants 0.91
     against 0.22 for wrong words.
   - **Gate:** preflight `voice_seams` is a blocker.
   - **Film 1's script, narrated again:** seams 43 → 0, word error 0 %, word-gap pauses 3.8 a minute (narrator
     1.6–6). Pitch travel 13.4 st (narrator ≥ 11.9). Melody 3.30–3.94 between runs (narrator ≥ 3.53).
   - **Limits:** melody still varies with how the director groups passages, and the narration runs about 7 % longer
     than with sentence takes.
4. ☑ **Taste as the objective.**
   - **Per scene:** every scene is scored by the trained taste heads on its rendered frame.
   - **Variants:** the scene designer's `try_variants` renders two or three different designs of one shot and keeps
     the one closest to the channel. Any scene below the channel's lowest tenth (4.4; median 6.1) must have had
     variants tried before the film can be submitted.
   - **Film gate:** preflight `film_taste` is a blocker; the median scene taste must reach the channel's lowest
     tenth (`OPUMIA_TASTE_GATE=warn` makes it advisory).
   - **Measured on film 1's plan** (`out/taste-test-kodak`, $0.69, not accepted in 30 turns): variants moved taste
     only within 3.2–4.1. The final median is 4.5, with 9 of 23 scenes below 4.4. Rearranging the same menu pieces
     does not reach the channel; the renderer is the ceiling, and step 5 is the lever. The gates are in place to
     measure it.
5. ☐ **Blank-slate design per film** (A) **and pixel memory** (F):
   - a visual concept, typefaces and palette for each film;
   - motion components written as code for each film;
   - no stock fallback cards;
   - the looks of produced films stored and enforced, including the same topic made twice.
6. ☐ **A real editor** (E): craft cuts measured from the reference, watching its own cuts at speed, jumps sent back to
   it.
7. ☐ **A reliable sandbox** (G):
   - failures go back to their owner, with a budget for retries;
   - an independent final-cut judge with a veto;
   - every defect becomes an automatic test;
   - regular test runs on a fixed set of topics.
8. ☐ **Frozen production runs:** the same topic twice must look different and share only the style.
