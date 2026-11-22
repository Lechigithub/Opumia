# Film 1 — frozen end-to-end run (2026-11-22)

Platform: tag `platform-frozen-film1` (24 fps). Topic: "How Kodak invented the digital camera and still went
bankrupt", MagnatesMedia, 16:9, 90 s, spend limit $5. Job: `out/film1-kodak/`, log `out/film1-kodak.log`.
No code was changed during the run.

## Outcome

**No film was rendered.** Every stage ran on its own up to the preflight gate (B6), which refused the render after two
repair rounds: `dead_frames`, `scene_defects`, `shared_sfx`, `voice_unresolved`, `voice_wer`.

- Time to the gate: about 26 min. Spend: $3.51 (Claude and ElevenLabs together).
- Whole-film score of the plan: 83 (structure 89; trained taste 4.5 against the channel's 6.1).
- The showrunner approved after sending work back to the sound designer, editor and scene designer. What it said was
  still below the channel: generic stand-in pictures in the cold open, too much real footage, too little text in the
  middle.

## What the run discovered (fix after the run, then freeze again)

1. **The listen-back marks correct narration as wrong.** Whisper writes "twenty three" as "23" and "sixteen billion
   dollars" as "$16 billion". The word comparison does not treat spoken numbers and currency as equal to digits, so
   correct lines failed: word error 1.2 %, 2 "unresolved" lines. It also paid for 4 rounds of useless retakes.
   → `senses` diffSpeech: normalise number words, digits and currency on both sides.
2. **The editor and the preflight gate contradict each other.** The editor splits shots into punch-ins of the same
   clip (`_2` shots). Preflight then treats the second half as a repeated picture, or as a second clip from the same
   press video, and drops its picture. That left 4 empty shots (`dead_frames`), which no repair can fix.
   → A split shot is one shot: the repeat, one-clip-per-source and fair-use checks must ignore an editor split's own
   halves.
3. **Test plans count as earlier films.** The cooldown and sameness checks treat `preview-kodak` and
   `preview-theranos` (test plans from development, never published) as recent films:
   - 43 % of the sound effects were "already used";
   - pictures from the same Kodak topic were dropped as "used by a recent film";
   - the look-distance check compared this film against a test plan.
   → Only produced films go in `data/asset-usage.json` and `data/looks/`; dev and test jobs must not record usage.
4. **One scene defect stayed:** sh022 has unreadable text, still failing after the gate reduced it to its clean core.
5. **The stage budgets are out of date.** Six stages are over budget:
   - narration now includes ElevenLabs ($0.84);
   - the showrunner, preflight and sound designer have no budget sized for agents.
   The film limit held ($3.51 of $5); at the old $3 limit the run would have stopped early.
6. **Voice expressiveness is advisory only:** pace variety 22.5 (target ≥ 23.4), melody 3.22 (≥ 3.53), pauses
   6.5 a minute (≤ 4.7). The listening voice director ran but did not bring these into the narrator's band.
7. **Commons refused about 200 searches** (rate limit). Sourcing coverage is understated, and the cold open fell back
   to stand-ins.

Items 1–3 are platform bugs that would block any film. Items 4–7 are quality limits to measure on the next run.

## Fixed after the run (platform tag `platform-frozen-film1b`)

1. **Listen-back numbers:** `senses/asr.ts:canonicalWords` turns spoken number words into digits on both sides
   ("twenty three" → 23, "one hundred and five" → 105). It also puts currency and percent in speech order ("$16
   billion" → 16 billion dollars). Film 1's own narration re-checked: word error 1.2 % → 0.00 %. The lines were never
   wrong.
2. **Editor splits:** preflight treats a split's halves (`sh008_2`) as one shot. A repeat counts only across
   different shots, one-clip-per-source counts each shot once, and a split press clip's length is its halves added.
   The scene designer's repeat count does the same.
3. **Produced films only:** a job becomes a film when its final file renders (`data/produced.json`,
   `agents/produced.ts`). The cooldown, fingerprints, treatments, looks, blueprints, thumbnail concepts and shared film
   memory all read produced films only. Test plans' records stay on disk and are ignored.
4. **Stage budgets** were resized to the measured costs, and lettered stages (B2s, B4e, B4c, B5s, C4v) now have
   their own budgets — a parsing bug had charged them against B2, B4 and B5. The film limit is unchanged ($5 for
   this run).

Not changed (to measure on the rerun): the scene with unreadable text, voice expressiveness, and the Commons rate
limit.

## Rerun on `platform-frozen-film1b` (`out/film1-kodak-2/`)

**Still no film.** Every stage ran on its own. The showrunner approved the plan (film score 84, structure 91) after
sending the editor and the sound designer back once each. Preflight then refused the render on 2 blockers (down
from 5). Time to the gate about 28 min, spend $3.38.

New platform bugs found:

1. **The pronunciation check looks in the wrong place when a line has figures.** The line was "In December 1975, a
   Kodak engineer…". The checker guesses where "Kodak" sits in the line from character counts. "1975" is 4 written
   characters but "nineteen seventy-five" spoken, so it compared "Kodak" against the sounds of the year and failed a
   correctly spoken word (consonants 0.33).
   → Place each risky word by its own aligned time in the take, not by character counts.
2. **The editor can split a still picture into an empty second half.** sh003 was a still (a Pexels image of a
   cassette deck). The editor split it as a punch-in with the elements on the first half only, so the second half
   is a bare still. That is a dead frame, and the gate's repair cannot add content to it.
   → The editor may split a still only with elements on both halves (or not at all). Preflight's repair for a
   dead editor half is to merge it back into its first half.

Quality, not blocking: Commons refused about 140 searches and Europeana and Coverr returned nothing. Research could
not read NYT, Reuters, SEC or The Atlantic (403/401). Pauses were 5.5 a minute (narrator ≤ 4.7). The scene designer
was slightly over budget ($0.49 of $0.45).

### Fixed after the rerun (platform tag `platform-frozen-film1c`)

1. **Sound check placement:** each risky word is found by its own aligned time in the take; character counts are only
   a fallback. On the failing line, "Kodak" now scores consonants 1.0 (it scored 0.33 by characters).
2. **Editor and stills:** `split_shot` refuses to split a still picture unless its elements stay on both halves, and
   refuses a bare still outright.
3. **Gate repair `merge_split`:** an editor half the gate finds frozen (`dead_frames`) is merged back into the shot
   before it, undoing that cut. The sound is laid again afterwards.
