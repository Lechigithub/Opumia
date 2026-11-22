# Legacy inventory (build list 3, item 1): for owner approval before anything is deleted

Each row: what it is, the switch that turns it on, what still calls it, the finding it caused, and the proposed action:
- **DELETE:** removed outright; the code survives only in git history.
- **REPLACE:** its job moves to the new path first, then the old code is deleted.
- **KEEP:** it is not legacy, or the new path needs it.

## A. Design: the menu art direction and the shared look

| # | What | Switch | Still called by | Finding it caused | Action |
|---|---|---|---|---|---|
| L1 | **Menu art direction (stage A1b)**, `agents/art-director.ts:artDirect`: picks from fixed menus (4 display fonts, 3 body fonts, 5 label styles, 6 photo frames, 7 "worlds", 5 particle kinds, washes, transitions) and a palette | none (always on) | `produce.ts` stage A1b; writes `design.json` | Film 2 got film 1's palette (#d4141c/#ffc20e on #360e13 against #e8231a/#ffc10e on #39100d): look distance 0.02, colour similarity 0.96. Both films used the same menu look. | **REPLACE.** `design.json` (the tokens the renderer, colourist, compositor, packaging and thumbnail still read) is written from the film's kit: the art director's palette from the film's pictures, its fonts and its concept. Then `artDirect`, its menus, `recentTreatments`/`recordTreatment`, `data/treatments.json` and the habit guard (`habitsOf` hues and treatments) are deleted. |
| L2 | **Treatment presets in the renderer**: `TREATMENT` (headline styles solid_stroke/boxed/neon_glow/paper_cut…, label styles, photo frames, glow), `World` backgrounds (nebula, blueprint, paper, halftone, smoke, stripes, spotlight), particles (dust, embers, snow, bokeh), and the menu font tables `DISPLAY`/`BODY` | follows L1 | `Composed.tsx`, `types.ts` (`applyDesign`), `Documentary.tsx` | The same cards, fonts and patterns across films (film 1 against the earlier Kodak film; the user's "template") | **DELETE** the presets and menus. Backgrounds without footage come from the kit (a `Stage` component the kit must supply); fonts come only from the kit. |
| L3 | **Generic scene elements**: `text`, `phrase`, `text3d`, and the menu-styled `photo` frames and `shape` decorations | none | scene designer, scene agent, compositor, sound events, film score | Film 2: kit used in 1 of 27 scenes; 9 text and 4 phrase elements | **REPLACE.** When a film has a kit (always, after this list), the scene designer's element types are `component`, `photo`/`cutout` (real pictures), `counter`/`steps`/`icongrid`/`newspaper`/`screen` (restyled by the kit's fonts and palette) and `texture`. Every word goes through a kit component. `text`, `phrase` and `text3d` are deleted from the scene schema, renderer and guards. Kinetic narration sync (each word landing on its frame) moves to a kit `Phrase` contract: the kit must provide it, and the engine passes the word frames. |
| L4 | **Preset designed shots** from the director: `big_word`, `quote_card`, `name_label`, `money_figure`, `hero_face`, `cutout_collage`, `chapter_card`, `screen` mock, `timeline`, `versus` (Kinetic.tsx, Signature.tsx, Versus.tsx), and the `atmosphere` / kinetic-stamp fill-ins in the manifest | none | director (designed kinds), manifest builder, Documentary | Template cards; a stamp on a stock atmosphere when a shot had no footage | **DELETE.** The director plans footage, data graphics or a `scene`; a scene is built from the kit. A shot with no footage goes back to sourcing or the scene designer (a ladder in part B), never to a stamp. |
| L5 | **Data graphics**: `chart`, `map`, `document` (Chart.tsx, MapRoute.tsx, Document.tsx) | none | director, fact binding, number parity QA | none directly. They are fact-bound and verified. | **KEEP, restyled:** they read the kit's fonts and palette, not the menu. |
| L6 | **Old voice timbre helpers in the art director's prompt** (habit lists of hues, treatments and transitions of recent films) | none | art director prompt | fed the menu | **DELETE** with L1. Uniqueness is measured on pixels (step 1) and in the kit memory (`data/film-kits.json`). |

## B. Scene design and repairs

| # | What | Switch | Still called by | Finding | Action |
|---|---|---|---|---|---|
| L7 | **Single-prompt scene designer** (`designScenes` model call, stage B3 without the agent) and the **separate critic pass** (stage B4: `critiqueScenes` then one redesign) | `OPUMIA_SCENES=legacy`, or a channel without a visual band | `produce.ts` 381, 417–420 | The old template path | **DELETE** the model-call path and stage B4. The sanitiser and guards inside `designScenes` stay (the agent uses them); `designScenes` becomes a pure "check and apply" function. |
| L8 | **Degrading repairs**: `safe_scene` (reduce a scene to its backdrop plus one phrase), `vary_stage` (move stages to paper or surface), `soften_wash`, `prune_shapes` as reductions, and `drop_picture` without a replacement | none | preflight round loop (`produce.ts` 690–770), `preflight.ts` | Film 1: four frozen halves left by dropped pictures; reduced "clean core" scenes look like stock cards | **DELETE** these repairs. Each failing check names its owner and goes through its ladder (part B): the scene designer or picture researcher replaces, never reduces. The checks themselves stay. |
| L9 | **Pre-render frame gate** (`motion-engine/gate.ts` + `agents/judge.ts:gateReview`): about 10 stills judged by Haiku before render, re-picking B-roll | none | `produce.ts` render stage | Film 1: $0.34 against a $0.05 budget; it duplicates the picture researcher, period check, preflight and taste | **DELETE.** The same problems are now caught earlier and measured (prevention, part C). |
| L10 | **Old render judge** (`agents/judge.ts:judgeRender`, the Sonnet stills judge inside QA) | none | `motion-engine/qa.ts` | Superseded by the viewer QA (whole film at speed) and the final-cut judge (blind against the channel) | **DELETE** the judge check; QA keeps its measured checks. |

## C. Voice and writing

| # | What | Switch | Still called by | Finding | Action |
|---|---|---|---|---|---|
| L11 | **Single-pass narration** (`narration/index.ts:narrate`, `tempoFit`, `beats.ts`, old `applyPronunciations`) | removed switch; still exported | nothing in production (dev scripts only) | — | **DELETE.** |
| L12 | **Sentence-take voice measurement** (`narration/measure.ts:ensureVoiceMeasured` reads its passage one take per sentence) and the script cut to that pace | none | script stage (natural pace) | Film 2: narration 99.7 s and then 81.4 s, outside the window; rewritten and narrated twice ($2.27) | **REPLACE** with a passage-mode measurement (same reading, one passage take), stored under a new key. Then delete the sentence-mode measure and its cached values. |
| L13 | **Five-pass writer** (`script.ts` draft → editor → critic → revision → numbers; hook/ending archetype menus) | used when a channel has no story band | `writeScript` fallback | Damaged prose; never accepted when measured | **DELETE.** Every channel now has its story band; a channel without one gets it built first (`dev/channel-bands.ts` as a stage), never the old writer. |

## D. Packaging, sound, sourcing, direction

| # | What | Switch | Still called by | Finding | Action |
|---|---|---|---|---|---|
| L14 | **Single-prompt thumbnail package** (`publish.ts:legacyPackage`, `agents/thumbnail.ts:designThumbnail`) | used when the thumbnail band cannot be labelled | `publish.ts` 101 | The old template thumbnail | **DELETE.** No band → the band is built first. |
| L15 | **Rule-based sound timeline as a separate path** | `OPUMIA_SOUND=legacy` | `produce.ts` 514 | — | **DELETE** the switch. `designSoundTimeline` stays as the sound designer's starting draft (the agent uses it). |
| L16 | **Director's old sound plan** (`agents/sound-design.ts` beyond `chapterMoods`, `moodOfTitle` and `sfxCap`) | none | the timeline replaces the director's plan | — | **DELETE** the unused parts; keep the three helpers the timeline uses. |
| L17 | **Skipping the picture researcher** | `OPUMIA_SOURCING=legacy` | `produce.ts` 293 | — | **DELETE** the switch. |
| L18 | **Single-prompt director** (`directStoryboard` model call without `raw`) | removed switch | the director agent uses its conversion (`raw`) | — | **DELETE** the model-call path; keep the conversion and its guards. |
| L19 | **Old benchmark** (`agents/benchmark.ts`), unused memory helpers (`memory.ts:saveMemory`/`recordOutcome`/`memoryRows`), `motion.ts:aspectPreset`/`reframe916`, `director.ts:validBigWord`, `web.ts:fetchPageText` | none | nothing in production | — | **DELETE** after a final check that nothing imports them. |

## E. Switches (beyond those above)

| Switch | What it does | Action |
|---|---|---|
| `OPUMIA_FILM_KIT=off` | keeps the menu look | **DELETE** (the kit is the only design path) |
| `OPUMIA_EDITOR`, `OPUMIA_COMPOSITOR`, `OPUMIA_COLOURIST`, `OPUMIA_SHOWRUNNER`, `OPUMIA_SHOWRUNNER_REWRITE`, `OPUMIA_VOICE_AGENT`, `OPUMIA_QA_AGENT`, `OPUMIA_FINAL_JUDGE`, `OPUMIA_PACKAGE_BESIDE` `=off` | skip an agent | **DELETE**: every agent always runs (a skipped agent is a weaker film) |
| `OPUMIA_PREFLIGHT=warn`, `OPUMIA_TASTE_GATE=warn`, `OPUMIA_STORY=warn` | render or narrate a plan that failed a gate | **DELETE**: a failed gate goes to its ladder, never past it |
| `OPUMIA_ROOM_TONE=off` | removes the room tone bed | **DELETE** |
| `OPUMIA_DESIGN_MODEL`, `OPUMIA_CRAFT_MODEL`, `OPUMIA_TTS_MODEL`, `OPUMIA_ASR`, `OPUMIA_MAX_USD`, `OPUMIA_TTS_USD_PER_1K` | model, provider and budget settings, not legacy paths | **KEEP** |

## F. Data and documents pointing at removed paths
`data/treatments.json`, the `treatment` and `sceneGrammar` menus inside `design.json`, the menu-based fingerprint respects
(treatment, layout of menu elements), and the CLAUDE.md sections describing A1b, B3/B4, the presets, the repairs and every
switch above are deleted or rewritten.

## G. Kept (named here so nothing is removed by mistake)
- The contracts and their Zod validation.
- Every step-1 measuring tool.
- Every agent and its tools.
- The kit engine (`@film`).
- Data graphics (L5) and the infographic elements (restyled by the kit).
- Real-picture elements (`photo`, `cutout`).
- Captions and SRT.
- The mastering chain.
- QA's measured checks.
- The resolver's search, rating and period checks.
- The library indexer and the reference index.

## Consequence to accept
Old jobs in `out/` (films made with the menu renderer, and test plans) will no longer render or re-plan. They remain
only as history.
