# Build list 5 — integration notes (all wired into produce.ts, preflight and the regressions on 2026-11-23)

## Packaging (I29–30) — done by its helper
- nothing new in produce; `recentWordless` wired in publish.ts.
- TODO: craft-score wire `packagingCraftMeasures` / `packagingReferenceMeasures`; add `package-bl5-test.ts --offline` to regressions.

## Sound (G26–27, E22) — done by its helper
- produce.ts soundAgent call: `emphasis: await emphasisOf(jobDir)`; `timeline: buildCutTimeline({ storyboard: board, script: timed, emphasis })` (editor reads it too).
- regressions: `soundStoryTest()` from apps/cli/src/dev/sound-story-test.ts.
- craft: `scoreAgainst("sound", await CRAFT_MEASURES.sound!(ourSoundStretch({...})), await craftBand({ craft: "sound", ... }))`.
- limits: stressed-word share is a rule (≤ ~40 % of strong hits), not learned.

## Story (B5–9) — mine
- story-scenes.ts: labelSceneLines(lines, datedFacts), ensureFillerBan, ensureSceneBand(lengthS), sceneIssues, endingKind, timeJumps.
- "in other words" is used by the channel (3 per 1,000 lines) → not banned (learned); "it sounds absurd", "this is the story of" banned.

## Pictures (D16–18) — done by its helper
- preflight: `ensurePictureBand({data, channelId})`, `measureFilmPictures({jobDir, subjects, designedFrames})` (pass final scene previews), `pictureIssues(rows, band)` → idle_stock / generic_pictures / weak_meaning → picture ladder.
- optional: `idleCap: band.idleCap` to resolveAssets.
- band (276 real shots): idle stock 4–5 % (cap 11 %); story-specific 34–39 % (floor 25 %); meaning of real footage median 5, floor 3.
- RISK: resolver meaning bar 6 vs channel's own median 5 — calibrate bar to the band (weak_fit too).
- find_picture idle cap does not count first-pass idle picks.

## Colourist (H28) — mine
- contracts: act `brightness` (optional); Documentary.tsx applies it (done by design helper).

## Design (C10–14) — done by its helper
- produce: `designScenesAgent({..., designBand: { band: await ensureDesignBand({ root, data, channelId }), root, data } })`.
- preflight: `designProblems({ scenes, shots, durationS, band, labels, textArea, variety, refOf })` (label data shots too) → one_world, template_stage, backdrop_back_to_back, world_variety, untreated, raw_stock, small_text, boxed_labels, repeat_card, data_rate, chart_slides, data_hold, repeat_picture → scene designer (`DESIGN_FIX`).
- `figureParity(figureInputs(shots with shown strings, words))` (motion-engine parity.ts) — totals; fails Nokia €3.8B+€1.6B vs €5.44B.
- preflight.ts:229 (bare_backdrop_run) treats every world scene as one backdrop → compare world.kind.
- band: grounds plain dark 26 %, collage 18 %, flat 10 %, paper 9 %, duotone 5 %, terminal 4 %; one ground ≤ 33–56 %; variety 0.376–0.451; treated ≥ 74 %; raw stock median 10 %; text area median 9 % (2–30 %); boxed ≤ 50 %; data 3.1/min, bars 8 %; data hold ≤ 6 s.
- not done: kit not regenerated with Sonnet; too_many_colour_frames may fire on duotone/flat; collage text legibility.

## Voice (F23–25) — done by its helper
- narrateDirected: pass `libraryDir: o.library`; `reword: async ({ text, why, context }) => string | null` (writer, same facts).
- persist `res.draft` to script.draft.json when it differs.
- gate on `report.names.unsolved` and `report.deliveryUnresolved` (delivery report in `report.delivery`).
- regressions: voice-delivery-test.
- `voiceCraftMeasures(lines, measures)` + `VOICE_DELIVERY_BAND` (fixed human-delivery thresholds; no reference voice band — music under reference audio).
- RISK: name lookup NONE was cached for good → do not cache NONE (fix in names.ts).
