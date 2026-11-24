# Hand film 1: FTX, made in the session with no Claude API call (2026-11-23)

Owner request: stop spending on the Claude API; prove in the session that a MagnatesMedia-style film can be made, then
teach the agents. `OPUMIA_NO_CLAUDE=1` makes any platform Claude call throw (`agents/llm.ts:client`). Spend: ElevenLabs
only (11 lines × 3 takes ≈ 3.4k characters).

Film: `out/hand-ftx/film_16x9.mp4` (80 s, 16:9, 29 shots, −12.5 LUFS). Scripts: `apps/cli/src/dev/hand/`
(script, narrate, fetch-wiki/commons/press, stock-look/get, shots-pages, cutouts, build, compare).

## How it was made (what the agents did not do)
- **Script** from the verified FTX fact sheet only, one claim per line, an explanation line ("his own coupons"),
  ends on the judge's words. 198 words, natural pace.
- **Voice**: 3 seeded takes per line, each heard back (local Whisper) and scored by the ears; best kept.
- **Pictures chosen by looking at them**: contact sheets of every candidate, in-points picked from press videos'
  thumbnail strips (one ≤ 6.5 s muted clip per video, cropped clear of broadcaster graphics), the real tweet, three
  real article screenshots (CoinDesk scoop, CNBC, CBS/Ray quote), Commons portraits cut out with BiRefNet.
- **Kit written for the film**: huge condensed caps landing word by word on the narration (gold key word, red danger,
  script aside), counting figures, a stamp, taped documents with a highlighter sweep, a donut, a gold flash cut.
- **Sound**: three beds changing at the turns with drop-outs; 11 hits placed so their peak lands on the visual moment.

## Measured against the reference (local instruments only)
| | picture taste (real 6.1, p10 4.4) | frames ≥ real p10 | voice (real 0.91) | mix (real 0.84) | luma | dark share | motion | cuts/min |
|---|---|---|---|---|---|---|---|---|
| MagnatesMedia, Ponzi 0–80 s | 7.4 | 38/40 | 0.85 | 0.85 | 0.34 | 0.13 | 0.05 | 37.5 |
| MagnatesMedia, Ponzi 420–500 s | 6.9 | 40/40 | 0.95 | 0.88 | 0.39 | 0.02 | 0.04 | 2.3 |
| hand film v1 | 4.8 | 23/40 | 0.28 | 0.19 | 0.25 | 0.30 | 0.01 | 14.3 |
| hand film v2 | 4.8 | 25/40 | 0.28 | 0.19 | 0.29 | 0.26 | 0.01 | 15.8 |
| agent Quibi | 4.8 | 27/40 | 0.41 | 0.25 | 0.29 | 0.14 | 0.01 | 15.8 |
| agent WeWork | 4.1 | 12/40 | 0.43 | 0.24 | 0.30 | 0.32 | 0.01 | 16.5 |
| agent FTX short | 4.1 | 3/14 | 0.42 | 0.26 | 0.40 | 0.07 | 0.01 | 10.1 |

**Not at the reference, even by hand.** The picture is now at our best agent film's level; the voice and mix are
the largest gap and did not move.

## Findings (each measured, each with its owner)
1. **Voice is the largest gap.** Every take of the channel voice scores 0.02–0.14 dry. The same take scores 0.44
   once mixed (chain + room tone + bed), so part of the score is the recording around the voice. Real narrators
   still score ~0.9. Owner decision needed: an ears-scored audition of voices (ElevenLabs characters only).
2. **Documents and figures on the near-black stage score lowest** (3.3–3.9). Real press footage and people with big
   type score 5.8–6.3. Moving the cards over defocused real footage lifted frames above the floor (23 → 25 of 40).
   Owner: scene designer: no document or figure on an empty stage.
3. **Library atmospheres with lifted blacks wash a dark shot grey** when screen-blended (the "dust" clip turned a dark
   phone shot beige). Owner: engine: crush an overlay's blacks before a screen blend.
4. **Too dark**: dimming footage under type at 0.45–0.65 gives dark share 0.26–0.30, against the reference's
   0.02–0.13. Owner: colourist and scene designer: dim ≤ 0.35 and lift the grade.
5. **Motion 0.01 against 0.04–0.05** even with 1.0 → 1.2 camera moves. The channel's movement comes from moving
   footage, fast cuts in the opening (37.5 a minute) and layers in motion, not from slow zooms. Owner: editor (cut
   the cold open at ~1.6 s a shot) and scene designer.
6. **Long holds read as a slideshow**: one document held 5.6 s unchanged. Owner: editor (split, punch in, or cut away).
7. **Gold type on a red chart is hard to read**. Owner: scene designer legibility check.

## Limits of this test
- The taste head may have seen the Ponzi film in training, so its 7.4 may be generous; the channel's held-out median
  is 6.1.
- No person has watched the hand film. The blind judge needs the API, so it was not run.
