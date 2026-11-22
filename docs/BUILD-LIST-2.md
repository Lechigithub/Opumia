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
3. ☐ **Seamless voice** (D): narration in long passages with request continuity, joins only at breaths with
   crossfades and continuous room tone, never digital silence. Gate: zero detectable seams.
4. ☐ **Taste as the objective** (B, decision half): two or three versions of each scene, and the one the taste judge
   rates closest to the channel wins. Gates on every scene and on the whole film.
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
