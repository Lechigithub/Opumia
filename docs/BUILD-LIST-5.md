# Build list 5 — agents that know their craft at the reference's level (approved by the owner 2026-11-23; items 1–33 built 2026-11-23, see "What was built")

Source: `docs/NOKIA-GAP-ANALYSIS.md`. **Wait for the owner's "start fixing". Every item is built before the next test
film.**

**The owner's standard:** a film of any length (seconds, 10 minutes, 20 minutes), in any of the channels' styles, at
the reference's own quality, made fast and cheap, never stopping, never wasting money, at scale. Length is never the
excuse; a craft gap is.

**The rule for every item:**
- The agent that owns the craft learns it from the reference: it measures the channel's real films with the same
  function it uses on its own work, at whatever length it is making.
- It is given the tools to act on what it measured.
- The gate checks the same measure.
- A change is kept only if that agent's own score against the reference improves.

## A. Foundations: every agent works, at any length, in any style

1. ☑ **Prove the budget fix** (bl4.3): no stage's first pass is ever starved. Every agent logs what it was given and
   what it used; a stage that got less than its first-pass need is a test failure.
2. ☑ **Length-aware by construction:**
   - budgets, caps, scene counts, music cues, chart quotas and story structure scale with the film's length from one
     table;
   - no skill or check assumes 90 s.
   - Tested at 45 s, 3 min and 10 min.
3. ☑ **Style-aware by construction:** every band, skill example and retrieval reads the requested channel's profile;
   nothing names MagnatesMedia in code. (Owner, 2026-11-23: test MagnatesMedia only for now.)
4. ☑ **A craft score per agent against the reference, measured at the film's length.** Each agent gets a fixed set of
   real reference stretches of the same length to be judged against. Its score is how close its work comes on that
   agent's own measures, plus a blind pairwise judge for that craft alone (story, picture, edit, voice, sound).

## B. Story (writer, researcher)

5. ☑ **A scene-and-character measure, learned from the reference.** Every line is labelled for:
   - whether it puts us in a moment (a person, a place, a time, an action);
   - whether a named person wants, fears or decides something;
   - whether the chronology is kept or skipped.

   The same function runs on real narrations and on our drafts, and the writer's script must sit in the channel's
   band. The line-kind band stays, but it no longer decides on its own.
6. ☑ **No narrator filler:** phrases that only point at the story ("It sounds absurd", "This is the story of",
   "In other words") are refused, learned as the lines the reference never uses.
7. ☑ **Time is kept:** a jump of more than a set number of years between adjacent sentences needs a bridge or a scene.
   The writer is shown where it skipped.
8. ☑ **The researcher gathers material for scenes, not only facts:**
   - moments with a place and a date;
   - people with what they wanted;
   - quotes and the images inside them (the burning platform, the man jumping into icy water);
   - turning points.

   The story dossier becomes the writer's raw scenes.
9. ☑ **Openings and endings learned at the film's length:** the writer studies the real films' first and last 20 s
   (any length works from these) and must open on a moment and close on a consequence, not a restatement.

## C. Picture design (art director, scene designer)

10. ☑ **Worlds, not one stage.**
    - The kit's stage component is replaced by a vocabulary of treatments learned from the reference:
      - a treated real picture (black and white with a colour accent, duotone, a cut-out over a burst, collage);
      - a bold flat field that changes with the idea;
      - paper and print;
      - a terminal or UI.
    - Each designed shot is built from one of these and real pictures.
    - **Measured:** the variety of backdrops inside a film (SigLIP distance between designed frames) must sit in the
      channel's within-film band, and no backdrop carries more than its share of shots.
11. ☑ **A treatment on every picture.** The share of frames with grain, texture, a light leak, vignette, cut-out or
    grade is labelled on the reference and on our previews; ours must be in band. Stock shown raw counts as a defect.
12. ☑ **Type at the reference's scale and integration:**
    - measured on real frames: the share of the frame text covers, whether it sits in the picture or in a box, its
      angle and weight;
    - kit roles are built to that scale;
    - small boxed labels are limited to their measured share;
    - a phrase card never repeats across a split.
13. ☑ **Data shown the way the channel shows it:**
    - the kinds of data shot are learned from the reference: a single big number, a drawn line, an annotated picture,
      an icon share, and a bar chart rarely;
    - charts per minute capped at the channel's rate;
    - nothing held still longer than the channel holds a data shot;
    - the figure on screen must equal what the voice says at that moment, including totals.
14. ☑ **Repetition inside a film:** each portrait and each picture used once, unless a second use has a different crop
    and treatment and a reason. The same backdrop and card never repeat back to back.
15. ☑ **The designer sees what the judge sees:** the final-cut judge's tells are run on previews before render (cheap,
    four stretches), and every tell goes back to its owner before a frame is rendered.

## D. Pictures (director, picture researcher)

16. ☑ **Rated by meaning, not literal fit.** A picture is judged on whether it carries the idea of the line, not its
    nouns. Stock people doing nothing in particular (hands on a phone, someone typing, an empty office) are a measured
    category with the reference's share as a cap.
17. ☑ **Story-specific pictures first:**
    - press, archive and the subject's own material before stock;
    - the share of pictures specific to the story is measured against the reference.
18. ☑ **Watermark and logo detection on footage** (the "MTR" corner): rejected before placement.
19. ☑ **The director plans for pictures that exist and mean something,** shot by shot, with the scene and character
    material from B8.

## E. Edit (editor)

20. ☑ **Shot rhythm learned at any length:**
    - the median shot length and the spread of lengths come from the channel, by position in the film;
    - cuts sit off the word boundary the way the channel's do;
    - holds without movement are capped at the channel's.
21. ☑ **No stutter cuts:** a cut to the same picture needs a different framing and a transition (punch-in on action,
    whip, flash). The editor checks every one.
22. ☑ **Hits on cuts and on words:** the editor and sound designer share one timeline of cut points and stressed words.

## F. Voice (voice director): human, at the voice's natural pace

23. ☑ **Delivery problems are blocking and fixable, never by changing pace:**
    - statements that end rising;
    - stressed words that do not land;
    - pauses inside sentences where a speaker would run on;
    - one colour across a whole story.

    The voice director gets the budget and tools to fix them: per-line direction, retakes with stress and tone
    direction, and the line text adjusted for speech by the writer. It submits only when they are gone.
24. ☑ **Tone follows the story:** the voice director plans a colour per act (dry, grave, wry, urgent) and checks it by
    ear on the takes.
25. ☑ **Names solved before narration:** every proper name gets its pronunciation solved and checked against the
    lexicon (and, where it exists, a recording of the name being said) before the first take.

## G. Sound (sound designer)

26. ☑ **Music follows the story:**
    - the cue changes at each turn the writer marks;
    - drop-outs and a riser into the climax;
    - silence used as punctuation;
    - all learned from the reference's music-to-story relations at the film's length.
27. ☑ **Fresh effects:** nothing a recent film used (the `shared_sfx` failure); hits on cuts and on stressed words in
    the channel's proportion.

## H. Look (colourist)

28. ☑ **The colourist always runs and owns one grade for the film:** brightness and saturation in band, stock shots
    pulled into the film's grade, and the result checked on previews before render.

## I. Packaging

29. ☑ **Thumbnails with words where the channel uses words,** and a thumbnail idea that tells the story's twist, not
    its topic.
30. ☑ **Titles that promise a person or a turn,** tested blind against real titles.

## J. Speed, cost and scale

31. ☑ **Cost and time per minute of film are measured and capped** (a 90 s film ≤ $3 and ≤ 30 min; longer films scale
    by the same per-minute figures). A stage over its share is a test failure, not a note.
32. ☑ **Parallel work for long films:**
    - the scene designer, picture researcher and voice takes work on chapters in parallel;
    - previews and the render already run in chunks.

    The stage clock is made safe for parallel stages.
33. ☑ **Reuse across films:** a subject researched once is reused; reference retrieval and measured bands are cached.

## What was built (2026-11-23)

Every item 1–33 is built and in the offline regression suite (`dev/regressions.ts`: 20 of 20 pass). What each one is,
and where it is honestly short:

| Item | Built | Short of the item |
| --- | --- | --- |
| 1 | `llm.ts`: every agent run logs what it asked, was given and used (`allotments.json`); a first pass given less than it needs is STARVED, logged and a test failure | — |
| 2, 31 | `film-length.ts:lengthPlan`: one table for budgets, stage shares and caps, agent caps, shots, chapters, music cues, data shots, re-hooks, opening/ending windows, research depth; $2 and 20 min per minute of film (90 s: $3, 30 min); a stage over its share is marked in timing.json (`overShare`) | — |
| 3 | no channel named in code paths (film-score, the stretch inspector) | only MagnatesMedia exercised (owner) |
| 4 | `craft-score.ts`: real stretches of the film's own length (openings, middles, endings), each craft's band and floor, scores and blind pairwise judges (story, edit, sound; picture from the judge on previews); `craft.json`, `data/craft-scores/` | voice is held to fixed human-delivery thresholds, not a reference band (the reference audio has music under it); no pairwise judge for voice (the judge cannot listen) |
| 5–7, 9 | `story-scenes.ts`: moment, agency and dated-chronology labels on real windows of the film's length and on drafts; filler ban learned from 6,903 real lines; unbridged time jumps; openings and endings; the writer is refused until both bands pass; `read_openings_endings` | "in other words" is used by the channel (3 per 1,000 lines), so it is NOT banned — the reference decides |
| 8 | researcher tags claims `moment / want / turn / image` and is held to them; the dossier carries turns and the picture inside quotes; the writer must tell the dossier's moments | — |
| 10–14 | worlds (mono accent, duotone, burst, collage, flat field, paper, terminal) from real pictures; treatment, raw stock, text area (OCR), boxed labels, data kinds, rate and holds, repeats — learned on 276 real frames, in the scene designer and the gate | the kit was not regenerated with the new role contracts on a real film |
| 15 | four cheap preview stretches judged blind before render; each tell goes to its owner (`judge-previews.json`) | — |
| 16–18 | meaning rating, idle stock capped at the channel's share, story-specific share, watermark detection on every candidate | the meaning bar is 5 (the channel's own footage median), not 6; coverage may drop |
| 19 | the director plans from the dossier's moments, people, turns and quote pictures | — |
| 20–22 | rhythm at the film's length (median, spread, long shots, still holds, cuts against words) blocking in the editor and the gate; stutter cuts need a new framing AND a transition (`reframe`); one cut timeline shared by editor and sound designer | the stressed-word share for hits is a rule (≤ ~40 %), not learned |
| 23–25 | delivery problems blocking with retakes by stress/tone/ending and the writer's rewording for speech; tone per act heard on takes; names solved and checked before the first take | no check against a recording of the name being said |
| 26–27 | cues at the writer's turns, drop-out before the biggest turn, riser into the climax, by length; no recent or repeated effect | — |
| 28 | the colourist's model-free first grade (exposure and saturation per act, bright stock pulled down) always runs and is checked on previews | dark stock cannot be brightened per shot (only per act) |
| 29–30 | words on thumbnails where the channel uses them; the idea must tell the turn; titles must promise a person or a turn (92 % of the channel's do) | not re-run on a film |
| 32 | scene designer per chapter in parallel, more voice takes at once for long films, stage spend tagged per stage (`inFilmStage`) | the picture researcher is not split by chapter |
| 33 | research reuses facts verified for an earlier film on the subject (same topic included, 60 days) without re-reading; bands and retrieval cached | — |

## K. Proof (only after every item above)

34. ☐ **One frozen test film, MagnatesMedia style** (owner, 2026-11-23). It is accepted only if all of these hold:
    - it finishes with no human;
    - it is inside cost and time;
    - every agent's craft score is in the channel's band;
    - the final-cut judge cannot pick it out more often than a real stretch;
    - its taste is at or above the channel's lowest tenth.
35. ☐ Then the 10-film suite, only when the owner asks.

## What already exists, and why it did not show in the Nokia film

The owner asked whether these were already done. Many of the checks exist; few of the crafts do.

**Built, but starved on the Nokia film.** The budget fault (bl4.3) gave these agents $0, so they never acted:
- colourist (28);
- the `shared_sfx` check (27);
- the stutter-cut check `unbridged_split` (21);
- the at-most-two-uses check on portraits (14);
- the director probing whether footage exists (19).

**Built as measures that only report.** They are measured and listed for the showrunner as gaps, but nothing makes the
owner fix them:
- shot median, shot-length spread, cuts in pauses, hits on cuts (20, 22);
- designed and stock share, text share;
- the voice director's delivery notes: rising ends, stresses that don't land (23).

Items 20–23 make them blocking, with their owner given the means to fix them.

**Partly built:**

| Item | What exists | What is missing |
| --- | --- | --- |
| 8 | the research dossier (characters, scenes, quotes) | the writer was not held to using it |
| 13 | number parity, fact binding | which kind of data shot to use, and how many |
| 17 | press-first sourcing | a measured share of story-specific pictures |
| 25 | the pronunciation lexicon and IPA from the voice director | "Elop" still failed |
| 26 | music evolving by mood span (claimed) | the Nokia film had one bed: the director's plan, never revised |
| 29–30 | thumbnail and title tests | words on thumbnails, titles that promise a person or a turn |
| 31 | the bl4 caps | measured per minute of film |
| 33 | facts reused across films on a subject | — |
| 2–4 | per-agent scores and per-channel profiles | at the film's own length |

**Not built at all:**
- 1, the proof that no stage is starved;
- 5–7, the scene-and-character story measure, the filler ban learned from the reference, and keeping time;
- 9, openings and endings at the film's length;
- 10, worlds instead of one stage, with backdrop variety inside a film;
- 11, a treatment on every picture;
- 12, type at the reference's scale;
- 15, the judge's tells run on previews;
- 16, rating pictures by meaning;
- 18, watermark detection on footage;
- 24, tone per act;
- 32, parallel chapters.

These are the real craft gaps, and they explain most of the slop.
