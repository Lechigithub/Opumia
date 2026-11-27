# Opumia — Autonomous Documentary Production Platform

## Goal

Opumia produces finished documentaries end to end, from topic to rendered and QA-checked film, in two formats:

- **Long-form `16:9`** (1920×1080, 8–30 min) explainer and business documentaries.
- **Short-form `9:16`** (1080×1920, 30–90 s) cut-downs and standalone shorts.

### The hard rule: ZERO AI-generated video

No frame of picture may come from a generative video or image model. Every visual is one of:

1. **A local asset** from `Library/`, a licensed and provenance-tracked catalog (see below).
2. **Licensed stock or archival media** fetched through an API: Pexels, Pixabay, Coverr, Vecteezy, Vimeo, Europeana, NARA and Wikimedia Commons.
3. **Designed motion graphics** rendered deterministically by Remotion from **the film's own kit** (written for that film by its art director): charts, maps and documents from verified data, and **composed scenes** (layered layouts written per shot by the scene designer), built from data and licensed or press stills.
4. **Fair-use press material** (`origin: "press"`, decided 2026-11-20): real news/interview/keynote footage from YouTube and Wikipedia portraits and logos of the people and companies the narration names. Used defensibly: excerpts ≤ 6.5 s, source audio never used, reframed/graded/composited under commentary, one clip per source video per film, never lifted from documentary channels (reference channels included), every use logged with source, channel, in-point and seconds in `ResolvedMedia.fairUse` and listed in `LICENSES.md`. QA `fair_use` (major): clips ≤ 7.5 s, ≤ 45 % of runtime, one clip per source, all logged.

**No exception — thumbnails included** (owner decision 2026-11-22): nothing in a thumbnail comes from a generative model. It is composed by the film's scene engine from real photos, logos, footage frames, real textures and overlays, and human-made licensed illustrations/vectors, with deterministic filters (painterly, posterise, ink, halftone) and photo-manipulation compositing allowed (owner confirmed). Never painting new pixels with a generative model. (Owner, 2026-11-23: the rule against altering a real face was removed — the only image rule is no AI generation; faces may be retouched with deterministic tools: smoothing, sharpening, relighting, warping, compositing real textures.) The Higgsfield path and its keys were removed from the code.

The rule is enforced in code. `StoryboardShot.source.kind` and `RenderManifest` layers have no AI-video variant, and the QA stage fails any manifest whose layer is not traced to an `AssetRecord` with a licence, or to a designed (Remotion) component.

Music beds in `Library/music` may carry generation prompts (`*.json` sidecars). Audio is allowed, but the indexer flags it as `provenance.generated = true` so credits stay honest.

## Tech stack

| Concern | Tool |
| --- | --- |
| Research, scripting, direction, QA judging, asset tagging | Claude API: **Sonnet** for reasoning-heavy stages (research, script, storyboard, QA verdicts) and **Haiku** for high-volume work (asset tagging, query expansion, caption checks) |
| Narration and word timestamps | ElevenLabs (TTS with character/word alignment), producing a `TimedScript` |
| Motion, camera moves (Ken Burns, pan, parallax), compositing, captions | Remotion |
| Probing, transcoding, trims, loudness (EBU R128), muxing | FFmpeg / ffprobe |
| Thumbnails | Packaging agent: real pictures composed by Remotion (`ThumbnailScene`), no generation |
| Contracts | TypeScript (strict) + Zod at every stage boundary |

### Environment variables and secrets

`.env.example` lists every variable by **name only**. Names with an empty value are API keys
(the Claude key is `OPUMIA_ANTHROPIC_KEY`, deliberately not `ANTHROPIC_API_KEY`). Path variables:

```
OPUMIA_LIBRARY_DIR     (default ./Library)
OPUMIA_REFERENCE_DIR   (default ./Reference)
OPUMIA_DATA_DIR        (default ./data)
```

## Secrets (non-negotiable, applies to every agent session)

- **Where keys live:** macOS Keychain, generic password, service `opumia`, account = the variable name
  (e.g. `opumia / ELEVENLABS_API_KEY`). Production uses Cloudflare Workers secrets; CI uses GitHub Actions secrets.
- **How code gets them:** `pnpm opumia …` loads them into its own process at startup (`apps/cli/src/keys.ts`):
  environment first, then Keychain, then the legacy file `~/.opumia_keys` while it still exists.
  Just run the commands. Agents never need to see a key.
- **Check availability:** `pnpm opumia keys` prints names and sources only, never values.
- **Agents must never:** read, print, log, copy or echo a key value; open `~/.opumia_keys` or any `.env`;
  run `security` (Keychain) commands; dump the environment (`env`, `printenv`, `set`); write a key into
  any file, URL, commit, artifact or chat message; ask the user to paste a key into the chat.
  User-level deny rules in `~/.claude/settings.json` enforce most of this.
- **Adding or changing a key:** add the name to `.env.example` (and to code that reads it), then tell the
  user to run this in macOS Terminal, outside the Claude app, and paste the key at the hidden prompt:
  `security add-generic-password -U -s opumia -a NAME -w`
- **If a key may have leaked** (printed, committed, pasted), tell the user immediately to rotate it at the provider.

## Pipeline

Each arrow is a Zod-validated contract from `@opumia/contracts`. A stage reads its input, validates it, writes its output, and validates again before writing.

```
topic
  → Research (Sonnet)           → ResearchBrief (Sprint 2)
  → Script (Sonnet + StyleProfile) → draft script
  → Narration (ElevenLabs)      → TimedScript   (word-level timestamps)
  → Direction (Sonnet)          → StoryboardShot[]  (shot per beat, camera, overlays, sfx)
  → Asset match (Haiku + index) → StoryboardShot[] with resolved assetIds
       (data/library-index.json first, then stock/archival APIs)
  → Assembly                    → RenderManifest (16:9 and/or 9:16)
  → Render (Remotion + FFmpeg)  → mp4
  → QA (FFmpeg measures + Sonnet judge) → QAReport  (pass | review | fail)
  → Packaging agent (title + thumbnail from real pictures) + description/tags
```

`StyleProfile`, derived from the six reference channels, conditions the script (WPM, structure), the direction (cuts/min, shot length, designed-vs-stock mix), the audio mix (LUFS, ducking, hit density) and QA thresholds.

## Repository layout

```
CLAUDE.md
package.json / pnpm-workspace.yaml / tsconfig.base.json
packages/
  contracts/      Zod schemas + inferred types + storage/DB adapter interfaces
  ingest/         Library indexer, Reference style analyzer, ffprobe + fs helpers
  agents/         Claude agents: research/fact-check, script, director, scene designer, packaging, QA judge; style pack; licence gate
  narration/      ElevenLabs /with-timestamps adapter, IPA pronunciation rules, word alignment, tempo-fit
  resolver/       Library-first asset resolver (BM25 + Claude rerank), 8 stock/archival adapters, QA repair
  motion-engine/  Remotion compositions (src/remotion), manifest builder, FFmpeg mastering, captions/SRT, thumbnail scene, QA
apps/
  cli/            `opumia` CLI: index-library, analyze-styles, inspect-reference, produce (src/dev/smoke.ts = offline render test)
  container/      Renderer container HTTP server (one stage per request, R2 sync) for Cloudflare Containers
packages/cloudflare/  R2BlobStore, D1CatalogDb, Worker, ProductionWorkflow, RendererContainer, wrangler.toml, D1 migrations
containers/renderer/  Dockerfile (Node 22 + FFmpeg + Chromium deps)
out/<job>/        Per-film working dir (git-ignored): every stage's validated JSON, media, final mp4, srt, thumbnail, QA
data/             GENERATED outputs only. Safe to delete and rebuild.
  library-index.json
  style-profiles/<channel-id>.json
  reference-status.json
  .cache/probe-cache.json   (ffprobe memo keyed by relPath|size|mtimeMs)
Library/          SOURCE ASSETS: READ-ONLY
Reference/        REFERENCE CORPUS: READ-ONLY
```

## Data safety rules (non-negotiable)

- **`Library/` and `Reference/` are read-only to all code.** Never write, move, rename, delete or "clean up" anything inside them. That includes `.DS_Store` files, logs, `.lock` files and caches.
- Another tool still uses the files in `Library/bank/` (`items.json`, `limits.json`, `cooldown.json`, `*.lock`, `cloud_render_spend.jsonl`). Read them without taking locks. If `items.json` is mid-write and fails to parse, retry, then skip. Never block on them.
- Read existing caches and never overwrite them: `Library/bugspot_cache.json` (watermark corners keyed `file|size|mtime`) and `Library/wiki_ipa_cache.json` (IPA lexicon). Our own memo goes in `data/.cache/`.
- Writes are atomic: write a temp file, then rename. Re-running any command with unchanged inputs produces byte-identical output, apart from the `generatedAt` timestamp.
- ffprobe is called read-only, with `-v error`, and only on files whose `size|mtime` changed since the last run.

## Library map (what the indexer understands)

| Folder | Contents | Metadata source merged into `AssetRecord` |
| --- | --- | --- |
| `music/` | mp3 beds | `licenses.csv`, `<name>.json` (generation prompt, seconds) |
| `sfx/` | mp3 one-shots | `licenses.csv`, `catalogue.json` (class, intended use) |
| `objects/` | png cutouts (+ `_src` jpg originals) | `licenses.csv` (tags, sound, kind, country) |
| `overlays/` | light leaks, dust, burns, smoke, paper, textures | `licenses.csv` (blend notes) |
| `cinematic/` | period/modern mood clips | `index.csv` (era, emotions, actions, quality) |
| `era/` | decade clips 1890s–2020s, `restored/` | `index.csv`, `restored/provenance.csv` |
| `footage/` | PD feature films + 20k-shot SigLIP index | `licenses.csv`, `meta/*.json`, `index/shots.jsonl` → `segments` |
| `moments/` | reference technique clips per channel | `<channel>/index.json` (technique, source film, t) |
| `icons/` | tinted png + lucide svg (`_src/lucide`) | filename (`name_id_hex_scale`) |
| `maps/` | geojson + relief raster | — |
| `thumb_cache/` | upscaled thumbnail stills | — |
| `bank/` | **remote** catalog (126k items) + thumbs | summarized only (counts by source/kind); not expanded |

Embeddings (`*.npy`), keyframes (`footage/keys/**`), the SigLIP model dir, the lucide JS sources, logs and shell scripts are **sidecars**, not assets. The index records them by reference without expanding them.

## Copying the reference channel (owner decision 2026-11-24)

Copy everything about how the channel makes its films, as exactly as possible, if it closes a gap:
- how it writes: script style, story structure, beat order, sentence shapes, rhetoric;
- how it looks and moves: typefaces (licensed where commercial), layouts, type treatments, colour, grades,
  transitions, cutting and pacing;
- how it sounds and packages: music and sound style, thumbnail and title formulas.

Any topic is open, including ones the channel has covered: nobody owns a subject.

What is never reused:
- the channel's name;
- its actual material word for word or file for file: its sentences, video frames, graphics, music files and
  thumbnails (copyright, and YouTube Content ID / reused-content strikes);
- its brand marks: logo, corner bug, intro/outro;
- a clone of its narrator's voice. Matching his delivery is fine.

## Reference corpus

Six channels serve as the style corpus: `MagnatesMedia`, `Logically Answered`, `Big Company`, `Modern MBA`, `How Money Works`, `Moon`.

- **Five channels share one layout:** `<channel>/<YYYYMMDD - title>/` holds `<ytid>.info.json`, `<ytid>.mp4`, `pretrain.json` (whisper words, scenedetect shots and per-shot look features), `sound.json` (demucs voice/bed analysis) and `sheet.jpg`. Logically Answered also has `screen.json`.
- **Big Company:** `Videos/NN - title/` holds `.info.json`, `.mp4` and `.en.srt`, plus `video_index.csv` and `Analysis Data/editing_stats.csv`. It is the baseline the others are compared against (`vs_big_company`).
- **`.analysis/`:** per-film `meta/<PFX>-<date>.json` (cuts_min, shot_med, look, stock/real/designed mix), `story/`, `motion/`, `text/` and `words/`. The prefixes are `MM`, `LA`, `MBA`, `HMW` and `MOON`.
- **Done files** list `youtube <id>` lines of fully downloaded and analyzed videos:

  | File | Channel |
  | --- | --- |
  | `done.txt` | MagnatesMedia (also contains 4 Logically Answered ids) |
  | `done_HowMoneyWorks.txt` | How Money Works |
  | `done_LogicallyAnswered.txt` | Logically Answered |
  | `done_ModernMBA.txt` | Modern MBA |
  | `done_moon-real.txt` | Moon |

  Big Company has no done file. Its completeness comes from `video_index.csv`.

## Contracts (`packages/contracts`)

| Schema | Role |
| --- | --- |
| `StyleProfile` | Measurable channel style: pacing, look, mix, audio, narration WPM, techniques, format |
| `AssetRecord` | One indexed media file with probe data, licence/provenance, tags, segments |
| `TimedScript` | Narration segments with word timestamps (ElevenLabs alignment) |
| `StoryboardShot` | One shot: time range, source (library/stock/designed; **no AI**), camera move, overlays, sfx |
| `RenderManifest` | Frame-exact layered timeline for one aspect ratio, with credits |
| `QAReport` | Checks, measurements, verdict |

Rules:
- Every schema has a `schemaVersion` literal. A breaking change bumps it.
- IDs are stable. An `AssetRecord.id` is a sha1 of `category:relPath`, so re-indexing never changes it.
- Times are seconds (float) in scripts and storyboards and integer frames in `RenderManifest`.
- Run `parse` at every I/O boundary. Pure functions do not use `any` or re-validate.

## Cloudflare deployment (`packages/cloudflare`, `apps/container`, `containers/renderer`)

Code talks to persistence only through the adapter interfaces in `@opumia/contracts/adapters`:
- **`BlobStore` (StorageAdapter):** `LocalBlobStore` (ingest) / `R2BlobStore` (R2; keys `library/…`, `reference/…`, `data/…`, `jobs/<id>/…`).
- **`CatalogDb` (DatabaseAdapter):** `D1CatalogDb` (one `catalog` table, Zod-validated on write and read, SQL-side `where(json_path)`), plus the `JobsTable` ledger. The schema lives in `migrations/0001_init.sql`.

Runtime topology (`wrangler.toml`):
```
POST /jobs ──▶ Worker (job API, D1 ledger) ──▶ Workflow ProductionWorkflow (1 durable step per stage, retries)
                    ▲  /internal/r2* proxy                │ getContainer(RENDERER, jobId)
                    └──────────────────────────────── RendererContainer (Node 22 + FFmpeg + Chromium)
                                                       runs `produce --until <stage>` (same code as the CLI)
```
- The container has no bindings. It reads and writes R2 through the Worker's authenticated `/internal/r2/*` proxy, and may write only `jobs/…` and `data/…`.
- In cloud mode (`OPUMIA_REMOTE_URL` set), `ensureLocal` hydrates only the Library files a job uses. Style packs come from `data/style-packs/` (written by every local build), so the 60 GB Reference tree is never needed in the cloud.
- Stages are idempotent (cached job folder), so Workflow retries are safe.

Deploy:
```bash
cd packages/cloudflare
npx wrangler r2 bucket create opumia-media
npx wrangler d1 create opumia            # put the id in wrangler.toml
pnpm db:migrate                          # applies migrations/0001–0003 remotely
# Upload data/ (and the Library subset you want available) to R2, e.g. rclone sync data r2:opumia-media/data
for s in API_TOKEN INTERNAL_TOKEN ANTHROPIC_API_KEY ELEVENLABS_API_KEY PEXELS_API_KEY PIXABAY_API_KEY COVERR_API_KEY VECTEEZY_API_KEY VECTEEZY_ACCOUNT_ID VIMEO_ACCESS_TOKEN EUROPEANA_API_KEY NARA_API_KEY WIKIMEDIA_ACCESS_TOKEN; do npx wrangler secret put $s; done
pnpm deploy                              # builds containers/renderer/Dockerfile (needs Docker)
curl -X POST $URL/jobs -H "authorization: Bearer $API_TOKEN" -d '{"topic":"…","channel":"moon","aspect":"16:9","durationS":600}'
```
Local verification without an account: `pnpm cf:dry-run` (add `--containers-rollout=none` without Docker), `npx wrangler d1 migrations apply opumia --local`, `npx tsx packages/cloudflare/scripts/adapter-test.ts`.

## Senses, exemplars and the release gate (rebuild stage 1–3, 2026-11-20)

The test films of 2026-11-20 were judged slop by the owner (templated, slideshow, generic stock, AI-sounding voice). Rule since then: **no agent works blind**, and **no film is produced until the release gate can pass on previews**.

- **`@opumia/senses`** (ffmpeg + plain TS, no model): `measureLook` (brightness, colourfulness, palette, hue spread, movement, near-still share, cuts), `contactSheet`, `grabFrames`; `measureProsody` (pitch travel, phrase melody, dynamics, pauses), `measurePace`, `measureSound` (sound-effect family from spectrum/envelope), `measureMusic` (tempo, beat grid, energy arc). The same function measures our output and the reference.
- **`renderShotPreviews`** (`motion-engine/preview.ts`): any shot at three moments, half resolution, plus a sheet — the designer agents' eyes before a film render.
- **Exemplar library** `pnpm opumia build-exemplars --channel ID` → `data/exemplars/<channel>/` (git-ignored): two frames of every labelled reference shot, every thumbnail with title/views/look, per-film looks and the channel band, the narrator's voice profile, technique clips. Measured MagnatesMedia facts: colourfulness 31–46, movement 3.4–5.3, every film its own palette; narrator ≈ 209 wpm, sentence pace spread ≈ 33 wpm, ≈ 4 short pauses/min.
- **Release gate** (`opumia eval`): a film passes only if (1) the blind judge (motion sheets + measured look, judge blind-v3) catches it in ≤ 65 % of comparisons, (2) every objective check in `apps/cli/src/slop.ts` is met (look, movement, designed-treatment share ≥ 70 %, slow-zoom share ≤ 20 %, no repeated or cross-film shared pictures/sound effects/music, voice pace/pauses/melody in the narrator band), and (3) the sameness test rates it no closer to another of our films than real channel films are to each other (+1). `eval/known-bad.json` lists films the owner rejected; calibration must catch them.
- 3D uses **Three.js** via `@remotion/three` inside the Remotion render (owner decision) — never headless Blender.

## Motion system and sourcing rules (rebuild stage 4–5)

- **The film's kit owns its look (build list 3, 2026-11-22).** The director turns every non-data shot into a `scene`; the scene designer agent builds each from the film's own kit (`design/film/`, written by the art director for that film only) and real pictures, or leaves moving footage clean. `remotion/scenes/Composed.tsx` draws only real pictures (photo, cut-out, 3D picture card) and places kit components; every word on screen, every card, the stage behind shots without footage, chapter cards and the chart, map and document drawings come from the kit (`FILM.roles`: headline, phrase, label, number, quote, chapter, stage, chart, map, document — `agents/kit-design.ts:ROLE_CONTRACT`). There are no shared text styles, colour worlds, particles, preset cards or decorations. A code layout guard (`fitLayout`) keeps elements in the safe area and apart.
- **Every picked picture is reviewed by eye** (`resolver/press.ts:reviewPictures`, Haiku): fit to the line (≥ 4/10), no burned-in graphics, right period, and **no stand-in face under a line naming a person**. Rejected picks get a wider search and alternates; failing that the shot has no footage and is designed on the kit's stage around a real picture (never a borrowed clip).
- **Name guard** (scene designer, in code): on-screen text naming a real person may sit over footage only when that footage is verified press of that person; otherwise the scene moves to the kit's stage. Press checks are told how the sources refer to the person (he/she). **Scripted dramas, film clips and trailers are never press** (title/channel filter + vision rule).
- **Press material:** stills (portraits, logos) are picture slots, never full-frame backdrops; clips with broadcaster graphics are cropped; real **article screenshots** of cited sources (`screenshotPage`, Remotion's Chromium; overlays hidden, nothing accepted) become picture slot 6 for up to 4 scenes.
- **Cooldown:** `data/asset-usage.json` — pictures used by the last 12 films are off limits (Wikipedia portraits/logos exempt). Story era comes from the fact sheet, not from years spoken in the narration.

## Sourcing: planned, pooled, judged by eye (2026-11-21)

Sourcing is planned per film, not searched blind (`resolver/widen.ts`, `resolver/resolve.ts`, `resolver/press.ts`):

- **Sourcing plan** (`planSourcing`, Haiku, one call per 40 shots): per shot — what must be seen, the kind of picture (`real` named subject / `period` / `staged` / `object` / `none` = designed, no picture), two short stock searches, one archive search, one YouTube search (real subjects only) — plus the film's **kit** (the real things it must have pictures of).
- **Every source for every shot, pooled:** library (BM25), Pexels, Pixabay, Coverr, Vecteezy, Commons (anonymous), NARA, Europeana, Openverse and the Internet Archive (both keyless), archive hits that name the entity, and YouTube by description. Vimeo is not asked (its API never exposes CC downloads). Storyblocks is not connected (owner decision).
- **Judged by eye before download:** each candidate's preview picture (`thumbOf`, `StockCandidate.thumbUrl`) is rated against the line, one shot's candidates side by side (`reviewPictures`). A pick needs fit ≥ 6, no later-period giveaway, no burned-in captions/graphics, and no face under a line naming a person unless the footage's own title names that person. The best-rated picture wins whatever its source; rated runners-up stand by. Nothing unrated is ever placed.
- **YouTube by description** (`youtubeFootage`): a video is considered only if its title names one of the film's subjects and it is not an essay/documentary/drama (`NO_LIFT*`, `DRAMA*`). The moment is found by looking at the video's own thumbnail strip (`ytMoments`) and its captions; only a preview frame is fetched, and the ≤ 6.5 s muted clip is downloaded once chosen. **One clip per source video per film** (owner decision, reaffirmed). A person's press must also name another subject of the film (namesake guard).
- **Web pictures** (`webPictures`): real photographs from the cited source pages and from pages found with the model's built-in web search (Haiku; no search-engine key). Pictures credited to photo agencies (Getty, AP, Reuters, Alamy…) are never taken. Each is checked by eye and becomes picture slot 7 of one scene, logged as fair use.
- **Coverage report** `out/<job>/sourcing.json`: per shot — need, searches, every candidate looked at with its rating, what was placed, what is missing. Read it before design or render.
- **Each picture is judged against its own line's year** (`ShotBrief.when`), not the film's overall period; pictures that look generated (`synthetic`) or carry legible text about another subject are rejected.
- **Re-plan around what was found** (`replanShots`, one Sonnet call): every shot the first search could not fill goes back to the director with what the sources actually returned. It gets a spare approved picture, a different findable picture that tells the same line (timeless close-ups rather than period group scenes), or becomes a designed scene (at most a third). Then one more pooled search for those shots. `sourcing.json` records `replanned` (asked, action, why).
- **Search memo** `data/.cache/stock-search.json` (20 h): re-runs and films on one subject do not spend API quota twice. Refused searches (HTTP 429) and sources that returned nothing are logged and written to `sourcing.json` (`refusedByRateLimit`, `sources`) — never silently counted as "nothing found".
- Measured on the Kodak plan (2026-11-21): footage for 19–23 of 25–27 shots that need a picture (was 8 of 29, with unrelated pictures among them); first pass 8–18, the re-plan adds 7–10. Run-to-run spread comes from the rater and from rate limits. Pexels supplies most usable stock; YouTube the real footage.
- **Known limits:** Pexels allows ~200 searches/hour by default and a film asks ~130 — ask Pexels to lift it before running films back to back. The stored Europeana key is rejected (HTTP 401). Openverse times out intermittently. The Internet Archive is asked for period footage: the moment in each whole film is found from its own thumbnails (`press.ts:archiveMoment`); a film with no matching moment is not offered. Spare pictures can make a film repeat a motif (three CRT screens). No cross-film cache of researched subjects yet.

## Speed and cost (rebuild stage 10, 2026-11-21)

- **Stage clock** (`produce.ts`): every `[XX] name` log header opens a stage; seconds and Claude spend per stage go to `out/<job>/timing.json` and are printed at the end of every run ("Where the time and money went"). Each stage has a budget (`STAGE_BUDGET_USD`, for a 90 s film, scaled for longer ones); a stage over it is marked `OVER BUDGET`.
- **Film spend limit** (`agents/llm.ts:setBudget`, build list 4): the WHOLE film counts (earlier runs of the job included — a resume does not start again from $0): $5 up to 90 s, $9 up to 4 min, else $20, or `OPUMIA_MAX_USD`. Target: $3 for 90 s. A reserve ($1.20 for 90 s) is kept for render, QA and packaging; optional work (agent turns, ladder rungs, revisions) may only spend down to it, and each stage's budget is a cap on its optional work (`setStageCap`). Reaching the limit ends repairs, never the film.
- **Sourcing stage** has per-phase times in `sourcing.json.seconds`. One Wikipedia lookup and one YouTube press search per subject per film (they were repeated per shot); the plan and the web picture research run alongside the press and search phases. Measured on the Kodak plan: 352 s → 129 s, $0.08.
- **Scene critic is calibrated on the real channel** (`apps/cli/src/dev/critic-test.ts <job>`): real reference shots are shown to it as if they were ours and it must pass nearly all (measured 0 of 24 flagged; at the earlier, looser bar it rejected 8 of 24 real shots and 27–29 of 29 of ours). Only visible defects send a scene back (`HARD_DEFECT` with severity ≥ 7, or severity ≥ 9), worst first, at most 40 % of the film. It judges defects, not taste — taste is the release gate's job. Measured: 6 of 27 scenes revised; preview → critique → revise 45 s, $0.04.
- **Previews** render four stills at a time on one shared browser (27 scenes × 3 moments in 30 s).
- **Art direction runs alongside the script** (both need only the facts). Not yet exercised on a fresh film.
- Measured on the Kodak plan, sourcing to manifest (no render, before the scene designer agent and the kit): B2 129 s $0.08, scenes 43 s $0.17, critic 45 s $0.04.
- **Not done:** the publishing package now runs beside the render (H33) but that concurrency is untested on a real render; the story blind test was not moved before narration (the blind judge is weak on story, so it would add cost without a trustworthy signal); render time has not been re-measured since the rebuild (no film has been rendered).

## Voice: directed narration and listen-back (rebuild stage 6)

`narration/directed.ts:narrateDirected` is the only path (the single-pass switch was removed).

1. **Voice director** (`agents/voice-director.ts`, one Sonnet call): per line — pace, the pause after it, the word to lean on — and every risky word (names, places, brands, foreign words, acronyms, abbreviations, figures, rare terms) with IPA, a respelling and, where needed, a written-out spoken form. Solved words persist in `data/pronunciation-lexicon.json`.
2. **Line takes:** one ElevenLabs take per sentence with neighbours as context, cached in `out/<job>/takes/`.
3. **Pauses set in code from the audio:** lead-in/tail trimmed, silences inside a line capped (0.19 s → 0.11 s), gaps between lines from the director (0.03 / 0.10 / 0.36 s; a held beat at most one line in six). Reference narrator: ≈ 2.8 pauses ≥ 0.25 s per minute.
4. **Listen-back** (`@opumia/senses`): `transcribe` (Whisper, no name hints) + `diffSpeech` against the script; the **sound check** recognises the phonemes of each whole line once (`spokenPhonemes`: wav2vec2-espeak ONNX on onnxruntime-node, model in `data/models/phoneme/`) and looks for each risky word's target around its place in the line (`phonemeMatch`). A word passes on its **consonant skeleton** (≥ 0.8); the recogniser cannot judge vowel or stress errors — that limit is real.
5. **Retakes:** only failing lines; first a fresh take, then a respelled one; the best take per line is always kept. Unresolved lines are written to `narration.report.json` and fail the release gate (`voice_unresolved`, `voice_wer`).
6. **Voice settings live in code** (`narration/voice.ts`): MagnatesMedia Christopher stability 0.28 / style 0.55 / **speed 1.0**.
7. **Natural pace (owner decision 2026-11-22, overrides every older pace note in this file):** a voice speaks at its own natural pace — speed 1.0 on every line, never pushed toward the reference narrator's words a minute and never time-stretched (`atempo` is gone from the directed path and `tempoFit` is no longer called). The reference teaches expressiveness (pitch travel, melody, pauses, variety), not speed. `CHANNEL_VOICES[channel].naturalWpm` is the voice's measured pace (Christopher 190 wpm, measured on a 262-word script: pace variety 29, pitch travel 11.4 st, melody 2.8, 0 % word error): scripts are cut to it, length is fitted by re-writing words (takes are cached per line), and both gates check the narration against the voice's own band (±12 %). The voice director's pace note shapes the pauses around a line, not the speed. No re-audition: Christopher stays.

Speech recognition backends (`senses/asr.ts`, `OPUMIA_ASR=local|cloudflare`): **local** whisper.cpp (`brew install whisper-cpp`, model `data/models/ggml-large-v3-turbo-q5_0.bin`) and **Cloudflare Workers AI** `@cf/openai/whisper-large-v3-turbo` over REST (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`; the renderer container gets both and uses this backend). The Cloudflare backend is written but has not been run against a real account yet. `espeak-ng` (target sounds for respellings) is in the renderer image.

Test without rendering a film: `npx tsx apps/cli/src/dev/narrate-test.ts out/<job-with-script>`.

8. **Narration model: Eleven v4** (`narration/voice.ts:DEFAULT_TTS_MODEL`, owner decision 2026-11-22; `OPUMIA_TTS_MODEL` overrides). Measured on the same Kodak script and voice against Multilingual v2: phrase melody 3.55 vs 2.79 (reference ≥ 3.53), pitch travel 14.2 vs 11.4 st, dynamics 6.2 vs 5.8 dB, natural pace 171 vs 190 wpm (`naturalWpm` is kept per model), word error 0.4 % after retakes. It pauses more inside lines (9 word-gap pauses a minute against the reference's 2–4) — left as spoken.
9. **Write for the ear** (`agents/numeric-facts.ts:earPunctuation`, applied to every script segment): dashes used as pauses become commas, bracketed asides become comma clauses, semicolons end the sentence; hyphens inside words stay. The writer is told the rule and the code enforces it. Sentence length is NOT shortened — the channel's median sentence is 19 words and choppy prose is rejected.
10. **Room tone** (`motion-engine/audio.ts`): measured on five MagnatesMedia films, the quietest 1 % of the sound sits 21–33 dB below the speech level; ours fell 34–53 dB below (a dry voice on digital silence when the music drops out). A filtered-noise bed made by FFmpeg sits 27 dB under the voice's level across the film: quietest 1 % now 26.6 dB below speech, loudness unchanged (−12.5 LUFS).

11. **First-use voice measurement, automatic** (`narration/measure.ts:ensureVoiceMeasured`): the first time a voice is used on a model, the script stage has it read a short standard passage (six sentences, ≈ 465 characters, one take per sentence as in production) before any script is written. Its natural pace and expressiveness are stored in `data/voice-calibration.json` under `_natural` (`voiceId|modelId`) and never measured again; the script is cut to that pace and both gates check narration against it (±12 %). A voice clearly flatter than the channel's narrator is flagged in the log. There is no onboarding command to run. Measured: Christopher on v4 reads the passage at 171.1 wpm against 171 on a real narration (9 s, 463 characters); Brian, never used before, measured 172.5 wpm, melody 2.8.

## Agents: skill, tools, memory, own score (owner direction 2026-11-22)

Craft roles are being rebuilt one at a time as real agents instead of single prompts in a fixed pipeline. Each has: a **skill file** (the craft, versioned apart from code), **tools it calls itself**, a **loop** (work → measure → revise), a **memory of its own**, and **its own score** on a fixed set, so it can be improved independently and a change is kept only if the score improves. `agents/llm.ts:agentLoop` is the shared tool-using loop (validated tool inputs, all results of a turn in one message, thinking passed back unchanged, conversation cached turn to turn, the film's spend limit applies).

### The writer (first agent rebuilt)

- **Why:** the five-pass writer (draft → editor → structure critic → story revision → number rewrite) failed its own story test and damaged the prose ("By the end of that decade's follow-up, the late eighties"): each pass fixed one measure and broke another. It also used facts the research had not verified.
- **Story measurement** (`agents/story-measure.ts`): every line of a narration is labelled for what it does (scene, story, fact, explain, motive, quote, question, address, tease, maxim) by the same function for our scripts and the channel's real films. The blind A/B story judge could not tell a bland rewrite from the real channel (missed 4 of 4); this can. Measured on 30 MagnatesMedia films (`data/story-profile/magnates-media.json`): explains what things mean in 16–40 % of lines, talks to the viewer or as the narrator in 2–24 %, quotes ≤ 7 %, bare facts ≤ 19 %. Bland rewrites: viewer address 0 %; our old scripts: explains 6–17 %, quotes 8–24 %, facts up to 39 %.
- **Skill:** `packages/agents/skills/writer.md`.
- **Tools** (`agents/writer-agent.ts`): `list_reference_films`, `read_reference_film` (whole real narrations, `data/story-profile/<channel>-films.json`), `search_reference`, `measure_draft` (story band, length at the voice's pace, structure, figures, every figure and quotation checked against the verified fact sheet, speakable punctuation), `submit_script`, `note_lesson`.
- **One author:** code only verifies and formats (figures, ear punctuation); it never rewrites a sentence. The writer reproduces the channel's own story structures (studied from real films) as exactly as it can, filled with this film's facts; the old hook/ending names survive only as labels for the uniqueness check.
- **Memory:** `data/agents/writer/<channel>.md` (its own lessons and a log of every script) and `data/agents/writer/owner-notes.md` (the owner's feedback — add a line there and the writer reads it before its next script).
- **Score:** `npx tsx apps/cli/src/dev/writer-score.ts out/<job> …` → `data/agents/writer/score-history.json`. First score (2026-11-22): 3 of 3 accepted (Kodak 97 s $0.36, Theranos 129 s $0.37, Enron 78 s $0.23); the five-pass writer on Kodak: not accepted, 200 s, $0.61.
- **Gate:** a script that is not accepted is not narrated (`script.story.json`). The five-pass writer was removed (build list 3): a channel without a story band gets its band built first.
- **Limits:** acceptance means "inside the channel's measured range and factually clean", not "as good as the channel" — nobody has judged these scripts by ear or eye yet. Only 90-second scripts have been run; long-form is untested. Research leaves many claims unverified (Kodak: 20 of 36 "unreachable"), which starves the writer of facts — a research-agent problem. The other roles (director, scene designer, packaging) are still single prompts.

### The researcher (second agent rebuilt)

- **Why:** research was one pass — search once, fetch each source once with a basic request, drop every claim whose page could not be read. On Kodak 20 of 36 claims were lost that way (Washington Post, CNN Money, PetaPixel, Medium, even justice.gov refused or were gone), and the writer was left without the story's best facts.
- **Skill:** `packages/agents/skills/research.md`.
- **Tools** (`agents/research-agent.ts`): `web_search` (run by the API), `read_page` (live page, else the Internet Archive's copy — `agents/web.ts:readPage`; with `find` it returns the passages around a phrase), `plan_story` (the angle and the must-have facts it is held to), `record_claim` (one fact + its exact evidence sentence; the page is read, the sentence must be on it word for word, a strict Haiku check must agree; a failed claim is retried on another source), `sheet_status`, `finish` (refused until the sheet has depth and every must-have is covered or declared in `FactSheet.gaps`).
- **Depth:** the sheet aims at twice the bare minimum (≥ 20 facts for a short): ≥ 3 word-for-word quotations, ≥ 5 figures, ≥ 8 dated events, ≥ 5 independent sources, no source carrying more than 45 %; near-duplicates and paraphrases labelled as quotations are refused.
- **Memory:** `data/agents/research/hosts.json` (which sites could be read, from the archive, or not — learned every run, shown before the next) and `notes.md` (a log of every sheet).
- **Score:** `npx tsx apps/cli/src/dev/research-score.ts "Topic" …` → `data/agents/research/score-history.json`. Kodak: 24 verified (20 fully), 4 quotations, 10 figures, 7 sources, 3 pages recovered from the archive, 102 s, $0.33 — the single pass had 16 usable of 36. Theranos: 49 verified, 168 s, $0.62 (it over-collected; it is now told to stop once the sheet is full — not re-run).
- **Chain check:** the writer on the new Kodak sheet was accepted in 59 s for $0.28 with a visibly better script (viewer address 14 %, ends on Sasson keeping the camera "because it was too cool to throw away").
- **Limits:** page reading still fails on some sites even with the archive (Theranos: 9 of 16 pages unreadable, e.g. bbc.com, fda.gov) — a headless-browser reader is the next step. Source quality is not yet scored (a blog counts the same as a court filing). (The old single pass was removed.)

### The scene designer (third agent rebuilt)

- **Visual measurement** (`agents/visual-measure.ts`): a frame is labelled for the kind of shot it is (plain_footage, words_over_footage, caption_on_footage, title_card, picture_composition, logo, number_stat, chart, document_or_screen, map, comparison, infographic, quote_card), how many words it shows and how many pictures it composes — the same labeller for the channel's real shots and for our previews. Band: `data/visual-profile/<channel>.json`.
- **Measured on 276 real MagnatesMedia shots (9 films): 42 % are clean footage with nothing on them** (19–75 % per film), 26 % words over footage, the rest spread over ten kinds; text on 26–86 % of shots. Ours had text on 93–100 % of shots and clean footage on 0–4 %. **This overrides the older rule "every shot is designed / designed share ≥ 70 %"**: a scene may now be clean (`SceneSpec.elements` empty), only on moving video; a clean still is a `dead_frames` blocker in preflight.
- **Skill:** `packages/agents/skills/scenes.md`.
- **Tools** (`agents/scene-agent.ts`): `view_reference_shots` (real frames by kind), `design_scenes` (checked by the same guards as before), `render_previews` (its own shots at three moments — its eyes), `measure_film` (the visual band, unused pictures, one-word cards on a plain stage, four of a kind in a row), `submit_scenes` (refused until it has looked at every shot it designed or changed and has studied the reference), `note_lesson`. Tools can return images.
- **More tools (2026-11-22, owner: "the agents should have all the tools that make them better"):** `find_picture` (a different or additional picture for a shot — every stock and archive source, rated by eye against the line and the line's own year, as footage or as a slot), `search_library_objects` / `add_library_object` (the library's licensed cut-out objects and line icons), `cut_out_subject` (BiRefNet background removal on a photo slot), `play_shot` (seven moments of a shot as a strip). They live in `resolver/scene-tools.ts` and are handed to the agent as functions; pictures it fetches are written to `resolution.json` with their licences. A footage-less shot must now be built around a picture unless two different requests found nothing (`stage_without_picture`). Kodak plan: 11 pictures requested, 2 library objects added, one picture-less shot left of seven; 149 s, $0.29.
- **Researcher:** `read_page` now falls back to a real browser (`resolver/press.ts:pageTextViaBrowser`) after the plain request and the archive.
- **Memory / score:** `data/agents/scenes/<channel>.md`, `owner-notes.md`; `npx tsx apps/cli/src/dev/scene-score.ts out/<job>` → `data/agents/scenes/score-history.json`. Kodak plan: accepted in 109 s for $0.19 — 7 kinds of shot, clean footage 52 %, text on 52 % (the single prompt + critic: 88 s, $0.21, text on 93 %).
- **In production** the agent is the only scene designer (the single prompt and its critic stage were removed, build list 3); the preflight gate still gives every final scene a second look.
- **One-colour measure corrected:** a frame now counts as "carried by a colour" only when at least half of all its pixels are saturated pixels of one colour family (a wash or a colour stage); natural footage is carried by none. On the reference the typical film has 5–11 % of shots carried by one colour, the most extreme 38 %; the Kodak plan after repairs has 30 % (it passes, but sits above what is typical for the channel).
- **Limits:** shots with no footage are still the weak ones — a name or a word on the film's colour stage; the engine has no icon infographics, counters built from pictures, step flows, screen recordings or newspaper layouts, which the channel uses. The whole-film colour wash still reads warm. The **director has not been rebuilt**: it still decides the shot list and what each shot needs in one prompt, before any footage is known.

### The director (fourth agent rebuilt)

- **Why:** the director wrote the shot list in one prompt before anyone knew what footage existed, so it asked for pictures no source holds ("sceptical 1970s executives in a boardroom") and sourcing had to re-plan up to 19 of 27 shots.
- **Skill:** `packages/agents/skills/director.md`.
- **Tools** (`agents/director-agent.ts`): `see_how_channel_shows` (the channel's 276 labelled real shots joined with the lines spoken over them), `probe_footage` (does a picture like this exist? — `resolver/scene-tools.ts:makeFootageProbe` searches stock and archives and rates previews by eye against the line and its year; nothing is downloaded), `measure_plan` (pace against the channel's 13–21 cuts a minute, shot lengths, data graphics bound to verified facts, named people marked as entities, footage checked and found, no picture asked for twice), `submit_plan`, `note_lesson`.
- **Hand-over (agents connected):** the candidates the probes found are written to `out/<job>/probes.json` and sourcing starts from them (`ResolveOptions.probes`) instead of searching blind. The accepted plan is turned into a storyboard by the same conversion and guards as before (`directStoryboard({ raw })`).
- **Memory / score:** `data/agents/director/<channel>.md`, `owner-notes.md`; `npx tsx apps/cli/src/dev/director-score.ts out/<job>` → `data/agents/director/score-history.json`.
- **Measured on Kodak (2026-11-22), production path from director to preflight, no render:** director 120 s $0.32 (25 shots, 17 cuts a minute, 25 pictures probed); sourcing 142 s $0.09 — **17 of 23 shots placed on the first pass (was 8–18 of 25–28), 6 sent to re-plan (was 14–19), coverage 21 of 23**; scene designer 137 s $0.29 — 46 % clean footage, text on 50 %, no picture-less stage shot left, real picture compositions; **preflight passed on its first round with no repairs**. Whole planning chain ≈ 6.7 min, $0.70.
- **Limits seen in the frames:** some footage is still modern under 1975 lines (colleagues high-fiving in a modern office, a tablet) — the eye check does not reliably catch period; a pink wash on several fetched shots; one lone-word card. Packaging is now an agent (see **The packaging agent**).

### Tools added to the rebuilt agents (2026-11-22, second pass)

- **Period check (shared)** — `resolver/press.ts:periodCheck` + `yearOf`: a dedicated dating of a picture (what in it dates it, the earliest year it could have been filmed) by Sonnet vision. The general picture review asked about period as one of five things and passed a headset office and a tablet under 1975 lines; this dated them 2015 and 2010+. Used in sourcing (the three best candidates of every shot whose line is set before 2009 are dated before a pick; only dated candidates may be picked), in `find_picture` and `probe_footage`, and in the preflight gate (`period_footage`, checked on the footage itself; repaired by dropping it and fetching period-correct footage). Real press footage of the subject is exempt. Kodak: 8 of 19 leading candidates were taken out in sourcing.
- **Writer → researcher** — `ask_researcher` (up to 3 facts per call, 2 calls per script): the researcher runs in quick mode (`researchAgent({ questions })`), verifies each fact on a readable source and the claims are added to the fact sheet (`facts.json` is rewritten). Stand-alone test (`dev/ask-researcher.ts`): the $1 billion Instagram sale and Kodak's filing date verified in 26 s for $0.11, with the disputed staff count declared. In the one script run since, the writer did not need it.
- **Researcher** — `read_page` also reads PDFs (`agents/web.ts:pdfText`, pdf.js, up to 60 pages) and YouTube videos' spoken words (`resolver/press.ts:youtubeTranscript`), plus `note_lesson`.
- **Director eyes** — `see_how_channel_shows` returns up to four of the real frames; `probe_footage` returns the best picture found for up to six items.
- **Scene designer** — `measure_film` now also reports text that is hard to read (labelled on the rendered frame), footage tinted into one colour (`senses:colourCover`), too many one-colour frames (over 30 % of shots) and the same picture placed in more than two shots.
- **Preflight** — a portrait or logo may appear in at most two scenes; a shot that loses its footage or sits on a bare stage is refilled through `find_picture` (`refill`).
- **Measured on Kodak after these changes (fresh scene pass + gate):** scenes accepted in 162 s for $0.30; the gate passed after one repair (a repeated picture). In the frames: no modern offices under 1975 lines, a period photo of the young Sasson with the prototype, a library icon in use; still two or three red-tinted footage shots, one weak stand-in for the prototype (a rusty electrical box) and one lone-word card.

## Escalation ladders (build list 3, part B, 2026-11-22)

A failed check never stops a film and never makes it weaker: it becomes a **problem** (check, shots, measured value,
band, evidence frames) that climbs its own **ladder** — the owner's cheapest fix first, a stronger one each round it
still fails. Engine: `agents/ladder.ts` (`Ladders`: one rung per round per problem, a fixed shot stops climbing, a rung
the film's remaining budget cannot cover is skipped and logged). Every attempt, skip, outcome and unresolved problem is
appended to `out/<job>/ladders.jsonl` (cause, rung, owner, shots, cost, seconds).

| Where | Problems | Rungs (cheapest first) |
| --- | --- | --- |
| A3 narration | length outside the window | pauses re-timed inside the silence (`narration/refit.ts:refitPauses`, no model, no take) → the writer trims or extends sentences → the writer again with the exact word count |
| A3 narration | lines unresolved after retakes and respellings | the writer rewords them → again, more plainly |
| B6 preflight (`apps/cli/src/ladders.ts:PREFLIGHT_LADDERS`) | pictures: repeats, cooldown, fair use, period, softness, stand-in faces, weak fit (< 6/10, `weak_fit`), no picture | replace the picture → a timeless close-up → the director re-plans the shot (`replanShots`) → a designed shot from the kit (weak fit: → the writer rewords the line) |
| | scenes: visible defects, dead frames, taste | the scene designer with the defect named → variants (`try_variants`) → a different kind of shot → the art director adds the component the film was missing (`film-designer-agent.ts` change mode) |
| | look too close to an earlier film | the kit redesigned against what made it close → a new visual concept (every scene redesigned) |
| | colour (luma, colourfulness, hue spread, one colour) | the colourist with what was measured → the art director retunes the palette, then the colourist |
| | edit: unbridged split (`unbridged_split`), cut pace (`cut_pace`), slow zoom | bridge with the film's transition → undo the split; the editor → the editor re-cutting the stretch |
| | sound: shared effects or music, one family | the sound designer → a fresh selection |
| C5 finished film (`FINISHED_LADDERS`) | QA picture faults, the viewer's issues by owner, the final-cut judge's tells | the same owners' ladders; then **only the shots whose layers changed are rendered again** (`motion-engine/render.ts:renderStretches`, ±12 frames, spliced frame-exact into the film) unless the kit, grade or edit changed; remaster, mux, review again (3 rounds) |
| C3 packaging | thumbnail not accepted | another concept → another hero picture; the best attempt is kept. Package text: rewording → sentences carrying unsupported claims removed |

- The writer is reachable once per film (it re-plans the film from the script, `pass: 2`).
- What every ladder leaves unresolved is logged (`unresolved` in ladders.jsonl, `preflight.json`) and the film renders anyway (build list 4): QA adds `preflight_unresolved`, which keeps the verdict at "review". A rung that ran on this film and fixed nothing is not bought again, nor any whole-film rung of an agent that failed to get a whole-film change accepted; a resumed film continues its ladders at their levels, with each rung's measured cost as its estimate.
- Tests: `npx tsx apps/cli/src/dev/ladder-test.ts` (engine), `npx tsx apps/cli/src/dev/stretch-test.ts` (after the smoke render), both in `dev/regressions.ts`.

## Build list 4: cheap, fast, always finishes (2026-11-22, `docs/BUILD-LIST-4.md`)

Film 3 (`docs/FILM3-FINDINGS.md`) cost $18.73 over two runs and never rendered. Since then:

- **Models: Sonnet and Haiku only, no Opus** (owner decision). One table, `agents/llm.ts:ROLE_MODEL`: Sonnet for the
  creative work (writer, research plan, director, art director, scene designer, showrunner, packaging, thumbnail craft,
  voice director) and the calls where a mistake ships (period check, final-cut judge); Haiku for claim checks, query
  plans, first-pass picture rating, labels, retrieval, checks and the measure-driven agents (picture researcher,
  editor, colourist, sound designer, viewer QA), which go back to Sonnet only if their own score drops. The scene
  critic stays on Haiku (it was calibrated there).
- **Money:** whole-film limit with a reserve, stage caps, agent caps checked before each turn (see **Speed and cost**).
- **Never a stop:** an art director kit that is not accepted gets one more short go; a kit change that fails is rolled
  back to the accepted kit; preflight problems left after the ladders are rendered and logged.
- **Checks that misfired:** `unique_look` measures only designed scenes (clean footage is shared real pictures), only
  against films on another subject (`film-score.ts:filmSubject`), and escalates only on a clear miss (15 % under the
  channel's tenth). `film_taste` sends back the worst three scenes a round. The showrunner gets one scene send-back of
  at most five shots, three send-backs in all. The film score counts strong hits only (the sound designer's measure).
  The picture refill widens (close-up, the line's words, a still).
- **Frame defects:** one chart, one unit (money, counts and shares never share a chart: "$1,100" patents);
  headlines and phrases must be a phrase (`scene-designer.ts:loneText` refuses one common word or a fragment ending on a
  function word); the critic flags placeholders (pictogram cards) and footage drowned in one colour; washes on footage
  0.16; the colourist's one-colour limit tightened; every placed shot is dated (a line with no year takes the story's
  latest year when it is before 2009).
- Test: `npx tsx apps/cli/src/dev/film3-test.ts` (in `dev/regressions.ts`).
- **Not measured yet:** whether a film now lands near $3 and 30 minutes, and whether the Haiku agents hold their scores;
  that is the next frozen film.

## Build list 5: craft at the reference's level, at any length (2026-11-23, `docs/BUILD-LIST-5.md`)

From the Nokia proof film (`docs/NOKIA-GAP-ANALYSIS.md`). Length is never the excuse; a craft gap is (owner).
- **One length table** (`agents/film-length.ts:lengthPlan`): every budget, stage share and cap, agent cap, shot count,
  chapter count, music cue count, data-shot quota, re-hook gap, opening/ending window and research depth. Per minute of
  film: $2 and 20 min (90 s: $3, 30 min; shorter films keep the 90 s floor). Nothing else may assume 90 s.
- **No starved agent** (`llm.ts`): every agent run logs asked/given/used (`allotments.json`); a first pass given less
  than it needs is STARVED and a test failure. A stage over its share is `overShare` in timing.json.
- **Craft score per agent at the film's length** (`agents/craft-score.ts`, `apps/cli/src/craft-report.ts` → stage
  C6, `craft.json`): real stretches of the same length (openings, middles, endings), each craft's band and floor, blind
  pairwise judges. A change to an agent is kept only if its craft score improves (`data/craft-scores/`).
- **Story** (`agents/story-scenes.ts`): moments, wants and kept time labelled on real windows of the film's length and
  on drafts; narrator filler learned as what the reference never says; open on a moment, close on a consequence. The
  researcher tags `moment / want / turn / image`; the writer is refused until both the line-kind and scene bands pass.
- **Picture design:** worlds instead of one stage (`remotion/scenes/Worlds.tsx`), treatment on every picture, type at
  the reference's scale (OCR), data kinds/rate/holds, repeats (`agents/design-measure.ts`, band
  `data/design-profile/`). **Pictures:** rated by meaning (bar 5 = the channel's own footage median), idle stock capped,
  story-specific share, watermarks rejected (`agents/picture-measure.ts`, `senses/watermark.ts`).
- **Edit:** rhythm at the film's length and stutter cuts blocking (`editor-agent.ts:stutterCuts`, `reframe`); one cut
  timeline with stressed words and turns shared by editor and sound designer (`agents/cut-timeline.ts`).
- **Voice:** delivery problems blocking and fixed by retakes and rewording for speech, never pace; tone per act; names
  solved before the first take (`narration/names.ts`). **Sound:** cues at the turns, drop-outs, riser, fresh effects.
  **Colourist:** a model-free first grade always runs. **Packaging:** words where the channel uses them, titles that
  promise a person or a turn.
- **The gate checks the same measures** (`apps/cli/src/bl5-checks.ts`; ladders in `ladders.ts`), including the
  final-cut judge's tells on four cheap preview stretches before the render (`judge-previews.json`).
- **Proof:** `npx tsx apps/cli/src/dev/proof-film.ts out/<job>` checks item 34 (no human, cost, time, no stage over
  share, no starved agent, every craft in band, judge no better than on real stretches, taste ≥ channel p10).
  Offline tests: `dev/bl5-test.ts`, `dev/bl5-gate-test.ts out/<job>`, `dev/craft-score.ts out/<job>`.

## Craft inventory: the platform discovers what the channel does (2026-11-23)

Owner: gaps must not wait for the owner to notice them. `agents/technique-inventory.ts`, `npx tsx apps/cli/src/dev/techniques.ts [out/<job> …]`:
- **Discover:** Sonnet watches real stretches (16 frames over 10 s + words, cuts, measured hits, music events) and names
  every technique; merged into one taxonomy (MagnatesMedia: 90 techniques) → `data/technique-inventory/<channel>/`.
- **Rate:** the same labeller (Haiku) on 80 real stretches → per-minute rate and share of stretches (`band.json`).
- **Map:** each technique against `CAPABILITIES` (what the platform can make, by owner) → available / partial /
  missing (`tools.json`). A new tool adds its line to `CAPABILITIES`.
- **Cover:** every film is labelled the same way after render (`techniques.json`) and joins `open.json` (missing tools
  and unused techniques, ranked by the channel's rate). Before render, the channel's staples (≥ 25 % of stretches) that
  none of the judge's preview stretches shows, and techniques used ≥ 2.5× the channel's rate, are gate checks to their
  owners (`staple_picture`, `staple_edit`, `staple_sound`). Each agent's brief lists its craft's techniques with rates
  and tools (`techniqueBrief`).
- **Built from it:** 3D type in films (`text3d`), real filmed atmospheres from Library/overlays (`atmos`: smoke, embers,
  dust, scratches, burn, sprocket, leak), glitch with RGB split, shallow depth of field, rack focus (`fx`), filmstrip
  world, silhouette / outline / glow cut-outs, high-contrast B&W, split-tone, negative and low-key grades, double
  exposure, flash and zoom-punch transitions, kit headline variants (banner, caps, marker, glow, ghost, lead) and label
  variants (intro card, hand-drawn arrow, handwritten). Missing tools went from 8 to 4 (one is the channel's own logo
  bug, never copied).

## Hand film lessons in the platform (2026-11-25, `docs/HAND-FILM-1.md`)

The FTX film was built by hand (v24–v33) until its opening read like the channel; what it taught is now the agents'.
- **Zero template share** (owner): every film is designed from nothing, even a second production of the same script. `agents/flow-measure.ts:templateShare` compares a plan with every produced film (devices at the same moment, cut timing, pictures — excess over chance); preflight `template_share` (blocker).
- **Moves, not cuts:** the channel makes ~76 % of its picture changes by moving (cuts 8.7/min) and its frame moves 82 % of the time. The scene designer can design a scene as a **journey** (`backdrop: "journey"`, 2–6 panels: slide / push through / whip / rise, a cut-out in front of the words, duotone, double exposure, depth of field; `scene-designer.ts:journeyStops` lays it out and holds each panel until its words were read).
- **Words held until read:** the channel's typical word stays up 2.5 s (`measureTextHold`, on-device OCR).
- **Scenes built by hand:** `write_composite` lets the scene designer write one layered component per scene (`design/film/composites/`, bundled as `@composites`), from the shared **craft tools** (`motion-engine/src/remotion/craft.tsx`, `@craft`: carved 3D type, two-sided objects, objects raining in depth, the big rim-lit hero cut-out, words wrapping round the subject, double exposure, whip, flare, phone, glass slab, cracks and shatter, shake — techniques only; colours and type are the film's) and the film's kit. `compare_with_reference` shows a stretch above a real one at the same place in a film, both measured.
- **Gates:** preflight `cuts_not_moves`, `too_still`, `words_rushed` on the judge's preview stretches, ladders `FLOW` / `TEMPLATE` (scene designer → a composite → the art director); QA `flow` on the finished film. Bands: `data/quality-profile/<channel>-motion-band.json`, `-text-hold-band.json` (built from the reference when missing).
- **v34, the minute rebuilt after watching Ponzi at 12 fps** (`dev/hand/watch.ts`: dense frame sheets, spectrogram, words, onsets, cuts, loudness): one performed shot per sentence, key words huge and building word by word, flashes instead of cuts, a title card, a continuous bed. Taught: craft `BuildWords` / `GradedPlate` / `FlashCut` / `LightWash` / `LightLayer`; `MusicCue.duckDb`; `narration/refit.ts:shapeColdOpen` (pauses ≤ 0.6 s, a 2 s title breath after the hook for long films → `TimedScript.titleCard`, drawn by the kit's chapter role); `agents/bed-level.ts:levelBeds` (from each bed's measured loudness; build list 6 corrected the targets to the channel's 37-film medians: cold open ≈ 15.8 dB under the voice, body ≈ 19.1 dB — the first ones came from Ponzi alone); preflight `bed_gap`, `dead_air` on the plan's stems.
- **Not yet proven on an agent film** (needs the API).

## Footage first, words in the picture (Wirecard v5 → v7, 2026-11-26)

The owner rejected v5 (a picture per sentence, generic push-ins) and v6 (every shot a designed card: "still looks like a
template, the use of cards is too much, and repetition"). v7, built by hand as its own Remotion project
(`out/hand-wirecard-v7/src`, rendered with `packages/motion-engine/src/hand/render-film.ts <job>`), was the first that
read like the channel: 26 shots in 68 s, almost all moving footage (real Reuters/Bloomberg news of the real subjects,
one clip per source video, and 1080p performed stock), graded into one world (steel-blue night glass, red when the
money is gone), words set into the picture above the grade, four designed scenes lit like real places.
- **Type gate** (`tools/world/type_check.py`, on-device OCR, no model; `flow-checks.ts:runTypeCheck/typeItems/typeChecks`):
  `boxed_words` (words on small flat boxes ≤ channel p90 0.14), `one_type_size` (size spread ≥ p10 0.56), `type_case`
  (capitals ≥ p10 0.20), `words_everywhere` (words on ≤ p90 0.74 of frames). Runs in the scene designer's
  `measure_film` on its own previews, in preflight on the judge's preview stretches and in QA on the finished film
  (ladders → the scene designer). v6 fails the first three on film and stills, v7 passes them (`dev/type-check-test.ts`,
  in regressions); v7 still fails `words_everywhere` (0.83).
- **Measured and not kept as a check:** whole-frame self-sameness (`tools/world/self_sameness.py`, SigLIP, channel band
  from 37 films) does not separate v6 from v7 (0.601 vs 0.596, both inside) — the template was in the type, not the
  pictures.
- **Craft tools from v7:** `PlaceLine`, `LedBoard`, `PinnedPrint`, `LightSweep` (`remotion/craft.tsx`).
- **Skills:** director (footage first, a few lit designed scenes), scenes (words in the picture; the four type checks),
  film designer (the world is a look over footage), sourcing (news strips, one clip per video, check every clip by eye).
- `dev/hand/stock-look.ts` keeps a blank tile for a failed preview and writes each sheet's order (a skipped tile had
  shifted every later one: five v7 clips arrived under the wrong need).
- **Not proven on an agent film** (needs the API).

## The channel's menu and originality (Wirecard v7.1–v7.2, 2026-11-26)

v7.1–v7.2 added what the channel lays over its footage; the owner asked that nothing taught makes films look alike
("a new film of its kind … sharing only the style, skill, craft"). Taught as a menu, guarded in code:
- **Craft tools** (`remotion/craft.tsx`): `GlitchIn`, `PressHeadline` (real article screenshot, marker, source),
  `SignatureObject`, `TravellingFigure`, `ScreenWall`; skills say when the channel uses each (scenes.md "The channel's
  menu"), and that an idea is one scene of 5–8 s that grows (director.md).
- **Signature object** (`film-designer-agent.ts`): `write_world` asks for one real thing from THIS story that returns
  2–3 times; refused when an earlier film used the same object (`sameObject`) or it is a generic money symbol
  (`GENERIC_OBJECTS`); recorded in `data/film-kits.json` (`signatureObject`).
- **Craft counted as devices** (`flow-measure.ts:craftOfComposites/loadCraft`): template share now sees the @craft tools
  each composite draws with, so the same technique at the same moment as an earlier film is caught.
- **Opening check** (`openingShare`, preflight `opening_too_close`, blocker → the scene designer): the first 15 s's
  distinctive devices (craft tools, non-footage worlds) against every earlier film's opening (≥ 2 shared and overlap
  ≥ 0.5 fails).
- **Words on frames** from OCR (`words_everywhere`) is advisory: it also reads real signage in footage; the words we put
  on screen stay gated by `text_share` on the plan.
- Test: `dev/originality-test.ts` (in regressions, 27/27). Not proven on agent films: the two-film proof will show it.

## Proof film 1 by the agents (2026-11-26) — what failed and what was fixed

Wirecard, 60 s, Christopher on Eleven v4, produced untouched; stopped by the owner before render at ≈ $5.20.
Narration was clean (169 wpm, 0 % WER); the art director's world was original (signature object: the bank
confirmation letter). Not the channel's style: stock strangers under lines naming Braun and Marsalek, real material on
1 of 9 named shots (then traded for stock), seven designed cards back to back, generic repeated stock; judge realness 0.56.
Fixed, tested offline on that film's own data (`dev/proof1-test.ts`, `dev/proof1-picture-test.ts`, regressions 30/30):
- art director: stage share 0.2 (its first pass needs $0.60); a complete submitted kit cut off before its final look
  is accepted, never a stop; the kit's transition read from FILM (`kitTransition`), not a component's CSS;
- press (`resolver/press.ts`): `pressTitleOk` (role + company names a person; broadcasters first, `NEWS`; outside them
  only primary footage, `PRIMARY`; never `PARODY`), moments found on the subject's own thumbnail strip (the subject may
  speak; anchors, reporters, others may not), 3–4 videos; the rater's `face` counts anyone a viewer could take for the
  named person;
- gate: `stand_in_face` reads the picture's description too (`looksLikeAPerson`) and split shots' parent pictures;
  `cards_in_a_row` (≤ 2), `real_subjects` (≥ half of named shots real); the director's plan measure warns on card runs;
- picture researcher: never replaces or drops real press/archive material.
- Not yet fixed: speed (stages run one after another; previews re-bundle Remotion each time) — see the owner's
  parallel-production request; the $5 limit for ≤ 90 s (narration alone was $1.21).

## Matching the channel's own practice (owner decision 2026-11-26 — overrides older stricter rules in this file)

"Do everything exactly the way the reference does": the rules that were stricter than MagnatesMedia were changed;
kept: no AI pixels, Library/ and Reference/ read-only, secrets never visible, never the channel's own material or a
clone of its narrator, originality between our films.
- **People** (`preflight.ts` `stand_in_face`, `scene-designer.ts` name guard): real material when it exists; when the
  real person was found anywhere in the film's search or placement, a stranger may not stand in; when nothing real was
  found, a performed reenactment (and the name over it) is allowed, as the channel does (Ponzi, the young Lustig).
  `real_subjects` still pushes the search for the real person.
- **Fair use at the channel's measured practice** (reference index, 37 films: real footage clips median 2.1 s, p90
  8.5 s; 4 % of runtime typically, 17 % p90, 27 % max): `PRESS_MAX_CLIP_S = 8.5`, `PRESS_MAX_SHARE = 0.27` (preflight
  `fair_use_clip_length`, `fair_use_share`, QA `fair_use`); several clips per source allowed (`fair_use_one_clip`
  removed); every use logged.
- **Film and TV scenes** as performed footage (`youtubeFootage({ film: true })`, offered for staged and period shots;
  never press of a real person); **older footage** allowed (`tooOld` off; later-than-story still caught);
  **falling money** allowed when the story calls for it.
- Older notes in this file that say "one clip per source video", "≤ 6.5 s / 7.5 s", "≤ 45 %", "footage more than 15
  years older is out", "scripted dramas … never" or "no face under a line naming a person" are superseded by this.

## The film agent (2026-11-26, owner: "make the agents work like you"; "build the parallel version first")

Agents with a workspace make the whole film the way the hand films were made, instead of a fixed pipeline of narrow
agents: `pnpm opumia film-agent --topic "…" [--duration 70] [--max-usd 9] [--parallel 4] [--solo] [--dry-run]`
(`apps/cli/src/film-agent/`).
- **Before them:** the platform's own research, writer and voice agents (`produce --until narration`), cached.
- **Parallel (default, `run.ts`):**
  1. **Planner** (one Sonnet session, ≤ 20 % of the budget): watches the reference, checks the pictures exist, writes
     `WORLD.md`, `src/world.tsx` (the film's look as code every scene imports) and `plan.json` (a scene per idea
     against the word times, the signature object). Code validates the plan (`plan.ts:validatePlan`) and compiles
     the world; errors go back to the planner.
  2. **Scaffold** (code): a stub and its own entry per scene (`src/entries/<id>.tsx`, so a broken scene never breaks
     another's render) and the generated `src/Film.tsx` (each scene mounted `lead` s before its words, entering over
     the one before).
  3. **Scene builders** (one session per scene, `--parallel` at once, 4 by default, 50 % of the budget shared): each finds its
     pictures and builds `src/scenes/<id>.tsx` until `film-tools scene-check <id>` passes (built, compiles, own
     media only, every file credited, not blank). Scene mode (`FILM_SCENE`): its own downloads, names, credits and
     fair-use ledgers (`credits/<id>.json`), so builders never write the same file; the guard lets it write only its
     own files.
  4. **Render** (code), then the **finisher** (the planner's session resumed): watches the film whole beside the
     reference, sends scenes back (`REBUILD.json` → those builders again, in parallel), fixes seams, mixes, gates;
     up to three rounds.
- **Added after review (2026-11-26):**
  - **Background fetching** (`prefetch.ts`): the moment the plan is valid, every scene's searches (`pictures[].how`:
    `press:`, `film scene:`, `stock:`, `commons:`, `films:`) run at once in code in the scene's own mode; each builder
    opens with `downloads/<id>/PREFETCH.md` and candidates on disk. Builders still choose (the old pipeline placed
    pictures nobody chose — that made its films generic).
  - **No-repeats register** (the scene ledgers): `clip` refuses a video moment, `stock-get` a stock clip, `commons` a
    photo another scene already uses; the checks flag any left.
  - **Draft sound plan** (`sound-draft.ts`): code writes the first `mix.json` from the plan's `mark`s (turn,
    biggest), the cuts and the builders' `notes/<id>.hits.json`: beds from the ranked list (not used by recent films)
    past their quiet intros, hits at the channel's 3.06 a minute ≥ 2.4 s apart (booms ≤ 30 %), a riser into the first
    turn, a drop-out before the biggest line. The finisher adjusts it; levels stay in `mix.ts`.
  - **Checks before the finisher** (`checks.ts` → `FINDINGS.md`): `captions.srt`, `LICENSES.md`; figures on screen
    (on-device OCR, 2 frames a second) against the narration and the fact sheet; footage under a pre-2009 line dated
    (`periodCheck`); a face under a named person whose real material exists in the film (`reviewPictures`); one
    source, moment or scene file in two scenes; the world check (line fit, sameness to our earlier films).
  - **Fresh eyes after** (`after.ts`, at the same time): the viewer QA agent, the final-cut judge and the packaging
    agent on the finished file (adapters turn the plan and ledgers into a storyboard, a resolution report and design
    tokens from the plan's `palette`/`fonts`); if the viewer or the judge finds something, the finisher gets one more
    turn. 15 % of the budget is held back for them.
  - The plan carries `entities`, `year`, `mark` per scene and the world's `palette` and `fonts`.
- **Pre-run review (2026-11-26, before any paid run):** sessions share one config folder (the finisher resumes the
  planner's transcript); a resumed session's reported cost includes its earlier turns, so only the difference is
  counted; a session that ends in an error (the SDK throws) is logged and the film goes on; the agents' shell gets an
  allowlisted environment with no stock or voice keys (`film-tools` loads its own keys) and the guard runs as a
  PreToolUse hook on every tool call (it also refuses code that reads the environment, home-path and after-`cd`
  deletes); the mix uses the narration file the word times belong to and pads the sound to the picture; renders link
  `public/` and remove their bundle; the scene check and renders no longer block the parallel sessions; the gate fails
  when the type check did not run or the mix is older than the picture (the orchestrator re-mixes), and counts only
  clips the film draws; ledger entries carry their scene; builders' money is what is left after the planner, less the
  finisher's reserve, with a STARVED warning (a Sonnet builder's first pass needs about $0.6, Haiku about $0.08).
- **Proof film 2 (Juicero, 2026-11-26, untouched):** 58.7 s, gate passed, package made, **$5.58 in 32 min**
  (narration $1.87 · planner $0.30 · 14 builders $2.15 in 4 min · finisher $0.46 · fresh eyes $0.78). Coherent world and
  signature object; but no real Juicero footage (the press filter refused every newsroom but the wire services — fixed),
  and it read as a tech explainer (race-bar dashboard, UI type, words on 77–80 % of frames). The agents under-worked:
  the planner watched 12 s of one reference film, builders spent $0.15 of $0.73.
- **What the agents did is checked in code** (`process.ts`; every session writes its full tool calls to
  `logs/<label>.tools.jsonl`): the plan is refused until the planner watched ≥ 3 reference stretches from ≥ 2 films
  (≥ 45 s), read ≥ 3 sheets and searched for real material of every person and company it names (two sends-back,
  then logged); a builder's scene check fails unless it read its own rendered stills and — when its scene names a
  subject and shows none of their real material — searched for it first; the finisher answers every judge tell and
  every viewer issue of severity 5+ in `TELLS.md` (even when the film passed), with one more turn for any left open.
- **The referee** (owner, 2026-11-26: "my eyes should not be relied on, that's why the reference exists"):
  `apps/cli/src/referee/`, built and proven by `npx tsx apps/cli/src/dev/referee-build.ts` →
  `data/referee/magnates-media.json` (held-back films, bars, separation, per-film scores).
  - **Test set:** 8 of the channel's 37 films held back from every model's training and hidden from the agents'
    reference tools (`ref list` shows 29). Against them: 15 of our films, short of the channel, and v7. Five 8 s
    stretches each; thresholds set on the 29 training films only.
  - **Measured (2026-11-26):**
    - Look measurements (brightness, contrast, grain, colour…) do NOT separate: 11 % of our stretches caught.
    - The blind side-by-side judge, logo corners masked, is no better than chance: real stretches called the
      imitation 45 %, ours 32 %. Its pass/fail is no longer used anywhere (produce's final-cut judge is advisory;
      the film agent's fresh eyes skip it).
    - The taste model (SigLIP heads), retrained in folds and scored with corners masked, separates whole films:
      held-back channel films 4.87–5.79, ours 3.26–4.87 (v7 4.49 above Juicero 4.01). Per 8 s stretch it catches
      69 % of ours and wrongly flags 8 % of real.
  - **In use:** the production model `data/referee/magnates-media-taste.json` (every film but the held-back ones).
    The film bar is 4.9: the lowest held-back film rounded up, so strict that no film of ours reaches it and 7 of 8
    held-back channel films pass it on 80 s (`dev/referee-sanity.ts`, in regressions). A stretch below 4.57 (the real
    stretches' 10th percentile) is a LOW moment.
    - `film-tools referee [film] | --scene <id>`;
    - the builders' scene check fails a scene below the channel's weakest tenth;
    - the gate refuses a film below the bar;
    - fresh eyes hand the finisher the LOW moments to answer.
  - **Limits:** the test set is small (8 real films, 15 of ours); the model judges stills, not motion or sound; scores
    of films it was trained on are biased low (use the fold scores in the report for those).
- **Finishing and recipes, tested with the referee (2026-11-26, offline):**
  - No global finish helps. Film grain, vignette, bloom, real dust and scratches, a contrast grade and all together
    each LOWER both our frames and the channel's own (all together: channel −1.21, ours −0.60;
    `dev/finish-experiment.ts`). The channel uses texture selectively, so no global finishing layer is built.
  - The gap is in what is on screen (`dev/frame-scores.ts`):
    - v7's highest moments: dark real footage with a heavy condensed caption glowing in the picture;
    - Juicero's lowest: flat designed cards, app-style type, UI dots, plain daylight stock.
  - Recipe lab (`dev/recipe-lab.ts`): on 12 real frames, the channel-style `GlowCaption` over a `DarkPlate` (new in
    `@craft`) scores 4.00–4.07, against 3.68 for app-style type and 3.48 for a flat card. But the footage decides most
    of it: the same untouched frames ranged 2.4–6.2, and no treatment lifts generic stock to the channel.
  - Hence `film-tools rank` (the referee on candidate footage before it is chosen), and builders are told to rank,
    then build with GlowCaption over a DarkPlate.
- **Juicero rebuilt by hand with the platform's tools, no Claude API** (2026-11-26, `out/hand-juicero-r`, the
  agents' Juicero narration). It proves the toolkit can reach the channel's bar on this story.
  - **Referee by pass:** 4.39 → 4.32 → 4.56 → 4.85 → **5.05, passing** the 4.9 bar (the unbiased fold model:
    4.81 → 5.10). The agents' Juicero scored about 4.0. The gate passes.
  - **What moved it:**
    - real footage of the real subject (VICE's Doug Evans, Fast Company's reporters);
    - bright press footage played on a screen in a dark room (`RoomScreen`; 3.5 → 4.9);
    - a real headline as a lit print over dark footage (`PressHeadline`; 3.5 → 4.9);
    - a real photo as a print in dark footage (`PhotoPrint`);
    - the title over the film's strongest footage (3.4 → 5.6);
    - dark stock chosen by rank.
  - **What did not:** darkening product shots, any global finish, generic hand-squeezing stock (all 3.8–4.6).
  - **It does not prove the agents will do the same**; that needs a paid agent run.
  - **Found and fixed:** clips passed to components as `src="v/…"` were invisible to the fair-use count (the gate read
    0 clips; true share 26.6 %); `plan.ts:mediaRefs` now reads any literal media path.
  - **Limits seen:**
    - the referee rewards the documentary look, not fit to the line (choosing still needs the line);
    - the 27 % real-footage cap binds a story whose proof is press footage;
    - the production model scores material from our earlier films low.
- **Proof film 3 by the agents (Juicero, 2026-11-27, `out/agent-juicero-3`, untouched, Sonnet builders, $16 limit):**
  - **Referee 4.64** (bar 4.9; the agents' first Juicero about 4.0, the hand rebuild 5.05). The gate passed every other
    check (7 real clips, 27 % of runtime; 39 pictures credited). **$14.43 in 121 min** (plan 26 min, of which
    about 17 min were the screenshot hang, since fixed; build $4.60; two rebuild rounds $4.67; finishing 34 min).
  - What the process checks bought: real material throughout (Bloomberg's squeeze test, the real Doug Evans, Fast
    Company, real NPR and Guardian pages marked as proof); every 8 s stretch 4.2–4.9 (no collapse).
  - What still read as ours: a **drawn signature object** (a force gauge from `world.tsx`, over footage in six
    scenes; the viewer QA called it templated), a hands-vs-machine **timer panel**, and a **near-black room** under
    a line (0.1–1.6 % of the frame lit).
  - Fixed (offline, `dev/film-agent-test.ts`, 106 checks):
    - `plan.ts:drawnObject`: the signature object must be a thing the camera saw; a drawn dial, gauge, meter,
      timer, counter, icon or a component is refused in the plan and at the gate (an instrument passes only when
      named as real footage or a photo);
    - `too_dark` in the scene check and `dark` in the checks before the finisher: below the channel's darkest
      5 % of frames (`data/quality-profile/magnates-media-lit-band.json`: ≥ 3.2 % of the frame brighter than luma
      48; 10 of 276 real shots are dark throughout) on most of a scene's stills, or for ≥ 2 s of the film;
    - playbooks: no drawn instruments or panels (a figure is big words or the real document); the planner no
      longer writes the signature object as a component;
    - `world-check` before a film exists says so instead of crashing.
- **Agent reference tools:**
  - `film-tools ref similar "<line>"`: the channel's real shots under lines nearest in meaning — a word match over
    its 17,660 labelled shots, then one Haiku call — as a frame sheet, with how each was built.
  - `film-tools ref technique "<name>"`: a technique's definition and real moments of it.
  - Builders must study one before building (scene check `studied`).
- **Solo** (`--solo`): one session does everything (the first design, kept for comparison).
- **Tools:** `film-tools` (`tools.ts`, `TOOLS.md`): the reference watcher, press/film-clip search with strips and cut,
  article screenshots, Commons, stock sheets, the film library, cut-out, depth, render (whole film or one scene),
  scene-check, beds, effects, mix at the channel's levels (`mix.ts`), side-by-side watch, type and world checks, the
  gate, lessons, spend. Shared techniques: `@craft`.
- **Playbooks:** `packages/agents/skills/film-agent.md` (shared craft and rules) + `film-planner.md`,
  `scene-builder.md`, `film-finisher.md`, `film-solo.md`.
- **Guard** (`run.ts:guard`, every tool use): no keys or environment, no Keychain, no git, nothing written outside the
  workspace and its memory (`data/agents/film-agent/`), Library/ and Reference/ read-only, no posting data out; a
  builder writes only its own scene's files.
- **Gate** (`gate.ts`, code, no model): whole narration, 1920×1080 at 24 fps; −12.5 ± 1 LUFS, peak ≤ −1.4 dB; the
  type checks; fair use at the channel's practice (≤ 8.5 s clips, ≤ 27 %, never a documentary channel); every picture
  credited (all scene ledgers merged); no generated imagery; nothing of MagnatesMedia's; a signature object no
  earlier film used; REVIEW.md.
- **Report:** `agent-report.json` (seconds and dollars per phase), `logs/<session>.log`.
- **Memory:** `data/agents/film-agent/<channel>.md` (lessons, shown before the next film) and `owner-notes.md`.
- Test: `npx tsx apps/cli/src/dev/film-agent-test.ts` (in regressions; guard, plan, scaffold, scene checks, a broken
  scene isolated, the assembled film rendered — no API). **Not yet run on a film** (a paid run, the owner's
  approval first). Not built yet: a warm Remotion bundle (every render re-bundles its entry, ~10–30 s).

## Learning, speed and cost (build list 3, part E, 2026-11-22)

- **Every escalation is logged** with its cause and cost (`out/<job>/ladders.jsonl` → `data/escalations.jsonl` after
  every run, `agents/escalations.ts`). A check that needed a stronger rung than the first in **two or more produced
  films** becomes:
  - an open platform fix in `data/escalations-recurring.json`, printed after every film and by `pnpm opumia escalations`
    (`--fixed 'stage|check'` once the fix and its regression case are in; it reopens if it escalates again);
  - a line in `dev/regressions.ts` until a case exists;
  - a lesson for the agent whose first rung did not prevent it, in its own memory (it goes through the usual lesson
    trials).
- **Loop and budget control:**
  - `agentLoop` takes `maxUsd` and `maxSeconds`, checked BEFORE each turn against what a turn has been costing (never overshot); the cap is the smallest of the agent's own, its stage's and what the film has left. Art director $1.20 / 10 min (a change $0.60 / 5 min), scene designer $0.70 / 8 min (revision $0.30 / 4 min), showrunner $0.35 / 7 min, measure-driven agents 3 min (build list 4).
    the scene designer stops at $1.20 for a first design and $0.60 for a revision.
  - The scene designer runs at most 4 times per film (first design, the showrunner's one send-back, two batched gate rounds); past that a revision keeps the scenes.
  - Stage budgets (`STAGE_BUDGET_USD`) are sized from the stages measured on the agents' films (art director $2.50,
    packaging $1.40, narration $1.20, preflight $1.20, finished-film ladders $1.20, …).
  - The pre-render frame gate's cost is gone (deleted, part A).
- **The delivered master** is encoded once at CRF 20 capped at 10 Mbps (x264 slow, high profile;
  `motion-engine/audio.ts:muxFinal`). On film 1 that is 82 MB instead of 155 MB, SSIM 0.980 against the render, in
  35 s. The render itself stays at CRF 18.
- **The reliability target** (`npx tsx apps/cli/src/dev/topic-suite.ts`, from a frozen tag): the 10 films of
  `eval/sets/suite.json` (the first two on the same topic) are produced untouched. The report is written to
  `out/reliability-<tag>.json`:
  - per film: first run with no human, in budget, in time (90 min for a 90 s film, excluding pauses), preflight and QA
    passed, pauses, resumes, ladder attempts, unresolved problems;
  - the summary: at least 9 in 10 meeting all of that, the rest finished after an automatic resume (exit 3 →
    `opumia resume`), and the same-topic pair looking different (inside the channel's band of real film pairs).
  - `--report-only` measures existing folders without producing anything.
  - **Not yet run:** about $70–90 for the ten films.

## Pause and resume (build list 3, part D, 2026-11-22)

A failure outside the platform never stops a film (`senses/outside.ts`):
- **Recognised** (`classifyOutside`): a usage limit or quota (HTTP 402, or 429/400/403 naming a limit, credit or quota),
  a rejected or expired key (401/403), a rate limit (429), an outage (5xx, 529), a dropped connection.
- **The call waits and continues where it was** (`withOutside`, around every Claude call in `agents/llm.ts`, ElevenLabs
  speech and Workers AI Whisper). An agent mid-conversation keeps its state. A usage limit waits until the reset time
  the provider states ("regain access on … UTC", `retry-after`, the rate-limit reset header), otherwise 15 min polls;
  an expired key is retried every 30 min after reloading the keys from Keychain (`loadKeys` + `resetClient`), so a key
  rotated during the pause reaches the running process; outages and rate limits back off 5 s → 15 min.
- **Visible:** a pause longer than a blip is logged ("⏸ PAUSED … trying again at …"), written to `out/<job>/paused.json`,
  and every pause is appended to `pauses.jsonl` when access returns ("▶ RESUMED").
- **Only a pause longer than `OPUMIA_MAX_PAUSE_H` (default 72 h)** ends the process with a `PausedError` (exit code 3);
  `pnpm opumia resume <job>` continues from the cached stages with the job's own options.
- **Cloud:** the container hands any pause over ~9 minutes (`OPUMIA_MAX_PAUSE_H=0.15` there) to the Workflow, which
  marks the job `paused` (D1 `migrations/0003_paused_status.sql`), sleeps durably (`step.sleepUntil`) until access is
  expected back, and runs the stage again.
- **Providers stand in for each other:** a stock or archive source whose key is rejected is down at once, one that
  keeps failing (rate limit after a retry, 5xx, unreachable) after three failures in a row; a down source is skipped
  for the rest of the run while the pooled search goes on with the others (`resolver/stock.ts:providerHealth`, logged
  and written to `sourcing.json.providersDown`). Local whisper.cpp and Workers AI Whisper stand in for each other
  (`senses/asr.ts`); with the other one available a failing backend is switched away from at once.
- Stages are checkpointed by their cached outputs (`out/<job>/`); within a stage, the waiting call keeps the work. If the
  process itself dies mid-stage, that stage's agent starts again on resume (its finished stages do not).
- Test: `npx tsx apps/cli/src/dev/outside-test.ts` (simulated failures, no network; in `dev/regressions.ts`).

## Prevention: the gate's measures run where the work is done (build list 3, part C, 2026-11-22)

The preflight gate is meant to confirm, not to discover: each of its checks has the same measure inside the agent that
does the work.

| Gate check | Where it is prevented |
| --- | --- |
| `soft_footage` | the resolver and `find_picture` pass over footage whose `measureCraft().sharpTop` is below the channel's softest tenth (`softBelow`) |
| `period_footage` | every placed pick under a pre-2009 line is dated on its own footage with `periodCheck` (not only its thumbnail); a late one is replaced |
| `weak_fit` | the resolver's review rejects a pick under 6/10 (the gate's bar; it was 4) |
| `stand_in_face` | the resolver's review (no face under a named person's line) and the scene designer's name guard |
| `unreadable_text` (new), `scene_defects`, `film_taste`, `unique_look` | the scene designer's every `render_previews` reports code legibility (letters on a label box measured against the box), trained taste and likeness to our earlier films (`film-kit.ts:makeLikeness`, > 0.9 = too close); the critic is told about pale letters on light boxes |
| `unique_plan` colour/treatment | the art director: `set_tokens` refuses a primary and accent within 25° of hue of an earlier film's; a used typeface is refused; samples report likeness |
| font weight (film 2) | `write_kit` refuses a `loadFont()` that loads every weight (aliases followed) |
| `unbridged_split` | the editor's `split_shot` bridges with the film's transition as it splits; `cut_on_action` reads motion and match frames around a cut |
| `cause_as_fact` (writer) | `writer-agent.ts:causesAsFact`: "X caused Y" without a fact-sheet claim stating the cause, or a hedge, is refused like a motive |
| voice repeatability | the voice direction of an unchanged script is cached (`voice-direction.json`); take seeds come from each passage's text |
| jumps under overlays | `senses/jumps.ts:samePicture` compares the six best of twelve tiles when a card covers part of the frame |

## Preflight gate (2026-11-22)

`produce` stage **B6** (`apps/cli/src/preflight.ts`, wired in `produce.ts`) runs every release-gate check that can be computed before the render, on the plan, the final scene previews and the narration. **A failing check goes to its owner, which replaces or redesigns — nothing is ever reduced to a weaker look** (build list 3, L8: the old `safe_scene`, `prune_shapes`, `soften_wash`, `vary_stage` reductions and dropping a picture without a replacement were removed). Up to eight rounds, each failing check one rung higher on its ladder (see **Escalation ladders**); what every ladder leaves unresolved is written to `out/<job>/preflight.json` and the render is refused.

| Check (blocker unless noted) | Owner |
| --- | --- |
| picture repeated in the film / used by a recent film; second clip from one source video; press clip > 7.5 s; press footage > 45 % of runtime; footage too modern or too soft; > 2 stage scenes in a row; > 35 % picture-less scenes | `replace_picture`: the picture leaves its shot, the picture tools find another (searched, rated by eye, dated against the line), the scene designer designs the shot again |
| scene with a visible defect on its **final** preview; clean shot without moving footage; film taste below the channel's lowest tenth | `redesign_scene`: the scene designer, told the defect (an editor's frozen split half is first merged back) |
| previews too dark, dull, or carried by one colour (`one_colour_film`, against the channel's own films — `data/.cache/hue-dominance-<channel>.json`) | `regrade`: the colourist, told what the previews measured (a one-colour film's picture-less stage shots also get real footage) |
| effects or music a recent film used; one sound family > 60 %; plan too close to an earlier film in sound only | `reseed_sound`: the sound designer |
| picture coverage < 60 %; designed share < 70 %; slow-zoom share > 20 %; plan too close to an earlier film in colour/treatment/layout/story/words; unresolved narration words; word error > 1 %; pace outside the voice's natural band | picture coverage → the picture ladder; designed share → the scene designer; slow zoom → the editor; the rest are refused with the reason |
| voice expressiveness against the reference narrator (pace variety, pitch travel, melody, dynamics, pauses) | **advisory**: reported |

- After scene repairs the sound timeline is laid again on the final scenes; the manifest and fingerprint are rebuilt.
- Measured on the Kodak plan: the first version passed a plan with a visible empty box, garbled text and a one-tone look, so the one-colour, empty-frame and all-scenes second-look checks were added; it then failed 3 checks, repaired them in two rounds and passed — 61 s, under $0.01.
- Movement, near-still time, cuts and anything needing the mixed audio can only be measured on the rendered film: those stay with `opumia eval`.
- Listen-back compares a hyphenated compound as one word when the recogniser writes it that way ("Film-less" / "filmless") — it used to cost three paid retakes and leave the line unresolved.

### The packaging agent (fifth agent rebuilt, 2026-11-22)

- **Thumbnail measurement** (`agents/thumbnail-measure.ts`): every thumbnail — the channel's real ones and ours — is labelled the same way (hero kind and how much of the frame it covers, cut out or not, faces and expression, background kind, focal elements, words and text height, marks such as glow/fire/money/outline/burst, and whether it could be made from real pictures alone). Band: `data/thumbnail-profile/<channel>.json`. **Measured on 37 MagnatesMedia thumbnails: about 35–46 % are made from real pictures alone; the rest are retouched, composited or illustrated — but 76 % are reachable with the agent's toolkit without generation (`reach`); 13 % alter a real face and 11 % need painting made for the thumbnail, and those are never imitated.** The labeller varies about ±10 points between runs. Also measured: hero 30–60 % of the frame (cut out on 92 %), a real photo behind the hero on 51 %, glow on 51 %, money 30 %, fire 27 %, median one word (35 % none, never more than 6), text median 17 % of the frame height, at most 5 focal elements, colourfulness 94–139.
- **Skill:** `packages/agents/skills/packaging.md`.
- **Tools** (`agents/packaging-agent.ts`; pictures in `resolver/thumbnail-tools.ts`, rendered in their own small folder `out/<job>/thumb-public/`): `view_reference_thumbnails` (real ones by hero/background/mark, with their labels), `list_pictures`, `find_picture` (a subject's photos and logos from Wikipedia/Commons, checked to show them; or a place, object or texture from stock and archives, rated by eye; photo-agency pictures never taken), `film_footage` + `use_film_frame` (a strip of a shot of the film's own footage, then the strongest frame — real expressions from press clips), `cut_out`, `search_library` / `add_library` (cut-out objects, icons, and fire/smoke/sparks/light filmed on black), `test_titles` (figures in the film, ≤ 70 characters, blind among real titles), `render_thumbnail` (full size and at phone size 360/168 px, measured against the band, plus code checks), `imposter_test` (blind among four real thumbnails), `submit_package`, `note_lesson`.
- **Finishing on real pixels** (`remotion/thumb/ThumbnailScene.tsx` and `thumb/ThumbLayers.tsx` — the thumbnail's own renderer, used by nothing else): a real photo filling the frame behind the hero (blur, dim, tint), a two-colour split, a light burst, real overlays blended over or under, vignette; per cut-out a coloured glow (rim light), outline colour, colour tint masked to the subject, punch/mono/glitch grade, one half only (two halves of two faces make one), mirrored.
- **More tools (2026-11-22, second pass):** `find_overlay` (stock VIDEO of fire, smoke, explosions, sparks on black; several moments measured, the densest frames kept), `find_expression` + `use_press_frame` (frames grabbed from interviews, news and speeches about a named person — same press filters as footage, rated for being them, face large, no captions, expression strength), `find_texture` (real blood splatter, cracks, burns, dirt; laid on a subject via `textureSlot` or over the frame), `find_illustration` (human-made illustrations/vectors from Pixabay and Vecteezy; AI-flagged excluded), `stylise` (ffmpeg painterly/posterise/ink/halftone/sharpen, alpha kept), `compare` (two renders side by side and at phone size). Renderer: thumbnail typefaces (Montserrat Black, Archivo Black, Anton, Bebas Neue, Oswald, Roboto Slab, Playfair — OFL, loaded via `@remotion/google-fonts` only in thumbnails, same on Mac and container), per-text `letter` style and exact colours, `card3d` for logos with depth, cut-out compositing (`contactShadow`, `soften`, `turnX/turnY`, `matchBackground` from the background's mean colour, `brightness`), whole-image `grade`.
- **Fair blind test:** the imposter test hides ours among the channel's thumbnails the toolkit can reach (`reach = reachable`), topped up with others only when too few.
- **Known environment limit:** this machine's ffmpeg has no `drawtext`; strips and sheets carry no drawn text (frames are numbered in reading order in the tool's text).
- **Blocking checks** (submission refused): a face that is not a verified subject of the film (`stand_in_face`), a figure or name on the thumbnail the narration never says, thumbnail words that repeat the title, a title not tested or failed, a thumbnail not tested blind. Until three renders exist, anything outside the band or a confident blind pick-out also refuses.
- **Memory / score:** `data/agents/packaging/<channel>.md`, `owner-notes.md`; `npx tsx apps/cli/src/dev/package-score.ts out/<job>` → `data/agents/packaging/score-history.json`. Band alone: `npx tsx apps/cli/src/dev/thumb-band.ts`.
- **After the agent:** description, tags, hashtags and pinned comment are written from its title (`writePublishingText({ title })`), the package check runs, and thumbnail pictures whose licence requires a credit are credited in the description. `publish.json.thumbnail` lists every picture used with its source and `generatedImagery: false`.

### Learning from the reference: craft, quality and retrieval (2026-11-22)

The reference channel is the taste source of truth (owner) — not anyone's personal rating. Agents learn *how* it is made, not only *what* it measures:

- **Thumbnail deconstructions** (`agents/thumbnail-craft.ts` → `data/thumbnail-profile/<channel>-craft.json`): the 28 reachable real thumbnails taken apart (idea, fusion, layers, edges, background, lettering, phone read, recipe). The packaging agent studies them (`study_reference_ideas`), proposes 6–14 concepts that a critic scores against them (`propose_concepts`; nothing is rendered until a concept scores 8/10, three rounds at most), and every render is critiqued beside the three nearest real thumbnails (`critique_thumbnail`: fused or collage, empty areas, what each real one does that ours does not, score /10, fixes). Submission needs the critic's score for the channel's own thumbnails (measured 4.5/10 — `dev/critic-models.ts`; a fixed 8/10 was a bar the channel itself fails) or twelve renders. The blind imposter test runs three times; it proved too lenient on its own (it passed a render the critique scored 4.5/10). Craft steps run on Sonnet; `OPUMIA_CRAFT_MODEL=opus` switches to Opus 5.5 (owner: measure without Opus first).
- **Pixel-level quality bar** (`senses/craft.ts`, `agents/quality-band.ts` → `data/quality-profile/<channel>.json`): sharpness of the sharpest tenth (`sharpTop`), of the typical block (`sharpMedian`), contrast (p95−p5), grain — the same function on 37 real thumbnails, 276 real shot frames and ours, all scaled to 640×360. Measured: the channel's thumbnails hold about 8× the typical detail of our early renders (median 1,219 vs ~160) and visible grain (17.5 vs ~5); 14 of 17 early renders fell below the bar. Our footage mostly sits inside the frames' band. `npx tsx apps/cli/src/dev/quality-gap.ts out/<job>`.
- **Where the bar applies:** every thumbnail render (`soft_image`, `smeared_image`, `flat_contrast`, `too_clean`); preflight `soft_footage` (footage softer than the channel's softest tenth; blocker, dropped and refilled like period footage).
- **Thumbnail finishing:** rendered at 2560×1440, brought to 1280×720 with Lanczos, an unsharp mask and film grain on the real pixels (`finish.sharpen`, `finish.grain`).
- **Retrieval by meaning** (`agents/retrieve.ts:nearestByMeaning`, Haiku, text only): the real examples nearest to the task — the critic's comparison thumbnails, `study_reference_ideas`, and the scene designer's `similar_real_shots` (the real shots whose spoken line is nearest in meaning and role, with what was on screen).
- **Measured before this pass** (Kodak, Theranos): best concepts 5.5–5.6/10, renders 2.5–4.5/10 against the real thumbnails. Not at the channel's level.

## Build list A–H (2026-11-22, `docs/BUILD-LIST.md` — every item ☑, details and measurements there)

Learning from the whole reference, a film owned end to end, and a craft agent per role. Each agent has a skill
file, tools, memory (`data/agents/<agent>/`), its own score (`apps/cli/src/dev/<agent>-score.ts`) and an off switch.

- **Reference index** (`ingest/reference/shot-index.ts`, `pnpm opumia build-reference-index`): all 67,906 shots and 154
  thumbnails of the five channels with labels, words, cut-vs-voice, hits and music, SigLIP 2 embedded with our own
  embedder (`tools/siglip/embed.py`) → `data/reference-index/` (git-ignored, ~4 h to embed).
- **Unified channel profile v2** (`agents/channel-profile.ts`, `pnpm opumia build-channel-profile --channel X`):
  every band, by position, relations (line→picture, hit→screen, music→story), variety and look distance, grade arc,
  view correlations with a permutation test — for all five channels (Big Company: no shot analysis). Its version is
  stamped on eval runs, lesson trials and score histories; a new profile is a new baseline.
- **Trained taste** (`agents/taste.ts`, `dev/taste-train.ts`): SigLIP heads (real vs ours/degraded, this channel vs
  others) per channel; in the film score and every thumbnail render (`taste_far`). Measures distance to the
  reference, not quality on its own; it does not separate owner-rejected films from our other old films.
- **Whole-film score** (`agents/film-score.ts`): our plan measured with the channel's own function, every gap named
  with its owner; look distance to our earlier films (`data/looks/`) — too close is a preflight blocker (`unique_look`).
- **Order of production stages after the director:** B2 sourcing → **B2d art director** (the film's kit and its
  design tokens, `film-designer-agent.ts`) → **B2s picture researcher** (`sourcing-agent.ts`) → scene designer → **B4e editor** (`editor-agent.ts`) → **B4k compositor** (`resolver/composite.ts`, no model) →
  **B4c colourist** (`colourist-agent.ts`) → **B5 sound designer** (`sound-agent.ts` + music editing
  `music-edit.ts`) → **B5s showrunner** (`showrunner-agent.ts`: sends work back, once to the writer) → B6 preflight →
  render, with the **publishing package beside it** → C4 QA → **C4v viewer QA** (`qa-agent.ts`, watches the finished
  mp4 via `watch.ts:watchFile`; can only tighten the verdict). Narration: the **voice director hears its own takes**
  (`voice-agent.ts`) before the pronunciation listen-back.
- **No off switches** (build list 3): every agent always runs and no gate can be waved through; only model, provider and
  budget settings remain (`OPUMIA_TTS_MODEL`, `OPUMIA_ASR`, `OPUMIA_MAX_USD`,
  `OPUMIA_TTS_USD_PER_1K`).
- **Memory that earns its place** (`agents/lessons.ts`): a lesson is dropped if the next films it was shown to score
  3+ points worse; every agent reads the shared film memory `data/films/<channel>.jsonl`; the researcher reuses
  verified facts of earlier films on overlapping subjects as leads (`data/agents/research/subjects.jsonl`).
- **Design and scene vocabulary:** two-sided design fundamentals on pixels (`senses/design.ts`); scene cut-outs can be
  colour-matched, lit from the backdrop's light, contact-shadowed and edge-softened; new elements `counter`, `steps`,
  `icongrid`, `newspaper` (headline must be spoken words, no masthead), `screen`.
- **Truth guards added:** a motive stated as fact fails the writer's check unless hedged or in the fact sheet; research
  scores sources (primary / reputable / weak) and confirms contested claims; package sentences the narration never
  supports are removed; undersized stock is refused before rating; the Archive is searched by moment.
- **Not yet proven on a film:** none of the agents built on this list has run inside a full `produce` of a new film;
  each was measured on the Kodak plan (or a rendered Kodak film) alone. That run is the owner's next step.

## Sound: timeline sound designer (rebuild stage 7)

`agents/sound-timeline.ts:designSoundTimeline` (no model call) runs as `produce` stage **B5**, after the scenes are final, and replaces the director's sound plan:

- **Sound goes on what the viewer sees.** Events come from the finished scenes: a stamp landing, a headline, 3D type, a 3D card, a data graphic opening, a document, a story turn. Each asks for a sound *family*.
- **Reference budget and mix** (measured on MagnatesMedia: 3.06 strong hits/min — 55 % thud, 26 % boom, a few clicks/plucks/risers, almost no whooshes): strong hits capped at the channel's density and ≥ 2.4 s apart, booms ≤ 30 % of them, ≤ 2 light accents/min, a riser into the biggest moments.
- **Files by measured character:** `pnpm opumia profile-audio` → `data/audio-profile.json` (`measureSound` / `measureMusic` on every usable effect and bed, incremental). Only designed hit sounds may be hits (`HIT_CLASS`); literal object noises are never used as accents. Choices are shuffled by the film's id, never repeated in a film, and exclude sounds the last 12 films used (`data/asset-usage.json`). The sound's peak is placed on the visual moment (start = moment − measured attack); level is set from the measured peak.
- **Music:** per mood span, by title mood + measured tempo and pulse, off cooldown; `MusicCue.inS` starts the bed after its quiet intro with the beat on the first strong hit. Drop-outs from the earlier sound design are kept.
- `resolver/resolve.ts:resolveAudio` re-materialises effects and music after this stage.

## Publishing package (rebuild stage 8)

`produce` stage **C3** builds the whole package with `apps/cli/src/publish.ts` + `agents/publishing.ts` (test without rendering: `npx tsx apps/cli/src/dev/package-test.ts out/<job>`). Outputs: `thumbnail.jpg`, `publish.json`, `youtube-description.txt`, `youtube-tags.txt`, `pinned-comment.txt`.

- **Thumbnail from real pictures, no generated imagery.** The film's verified press stills, the main subjects' Wikipedia photos and logos, and matching `Library/objects` cutouts become picture slots; photos are cut out with `senses/cutout.ts:removeBackground` (BiRefNet-lite, MIT, ONNX; keeps only source pixels). Designed by the packaging agent (below); a channel without a thumbnail band gets its band built first (the single-prompt designer was removed). Recent concepts are avoided (`data/thumbnail-concepts.json`).
- **Title:** six candidates from the reference titles weighted by views; figures must be in the film; the winner is the candidate least often picked out among real titles.
- **Credits follow each source's terms** (`publish.ts:creditLines`, `SOURCE_CREDIT`): one visible link line per source the film really uses ("Stock footage and photos provided by Pexels — https://www.pexels.com", likewise Pixabay, Coverr, Vecteezy, Commons, Europeana, NARA, Openverse, Internet Archive), then per-item credits with a link — licence-required ones (CC BY / BY-SA, Vecteezy, music) always, creator credits for Pexels and Pixabay as space allows. Press excerpts are covered by the fair-use notice, not here.
- **Description:** hook + story paragraph in the channel's style (only figures the narration speaks), chapters, sources, a fair-use notice naming the rights holders of press excerpts, credits, hashtags. **No channel-links slot** (owner decision).
- **Tags** (≤ 480 characters; never the reference channel's name or a term the film does not use), **hashtags** (3–5), **pinned comment** (a specific question about the story; no links).
- **Package check** (Haiku): title, thumbnail words, description and pinned comment against the narration — anything promised but not delivered is listed in `publish.json.checks`.
- Reference packaging lives in the exemplar library (`packaging`: title, views, description story paragraph, tags).

## Uniqueness: treatment and fingerprint (rebuild stage 9)

No two films may share anything but the channel's style. `agents/fingerprint.ts`:

- **Fingerprint** of every planned film (`data/fingerprints.json`, and `out/<job>/fingerprint.json`): colour, the kit's typefaces, visual idea and **signature transition**, where designed elements sit on screen (element type × 3×3 cell), backdrop and shot-kind mix, story blueprint, opening and closing words, title, sounds and music.
- **Similarity** per respect with limits (`UNIQUE_LIMITS`: colour 0.7, treatment 0.56, layout 0.9, story 0.67, words 0.4, sound 0.34). `closest()` names the nearest earlier film and what is over a limit; the release gate check `unique_plan` fails a film that is too close in any respect.
- **Prevention at every planning stage** (`habitsOf` over the last 6 films): the art director sees our earlier films' kits (`data/film-kits.json`: typefaces, palettes, concepts, transitions; a used typeface is refused) and measures its samples' likeness to our earlier films; the writer is given recent openings to avoid; the scene designer is told the placements recent films leaned on; sounds and pictures are on cooldown; thumbnail concepts are avoided.
- **Within a film:** the kit keeps it coherent; scene guards keep it from becoming a slide deck — no filler-word headlines, at most two stage scenes in a row (the next gets a real picture).
- `out/<job>/treatment.md` is the film's written treatment (concept, colours, typefaces, the kit's roles, transition, story shape, closest earlier film).

## Platform evaluation (blind reference test)

`opumia eval` measures the platform, not one film. Every film is cut into 20 s picture windows (frames + narration + same-method cut counts) and 45 s narration passages, each paired with a real reference window of the same position and shown blind (A/B) to a Sonnet judge. The judge is only trusted after calibration on degraded reference windows (wrong picture, generic stock, bland rewrite, real-vs-real). Report: caught count + indistinguishability, judge tells grouped by area, trend in `data/eval/<set>/history.json`.

```bash
pnpm opumia eval calibrate --channel magnates-media
pnpm opumia eval score out/<job> [out/<job> …] --set adhoc
pnpm opumia eval run --set quick            # produce eval/sets/quick.json untouched, then score
```
Rule: platform changes are kept only if the set's caught count drops. Never tune a single film by hand; films are produced from a committed, frozen platform.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm opumia index-library            # → data/library-index.json (incremental)
pnpm opumia index-library --no-probe # stats + metadata only, no ffprobe
pnpm opumia inspect-reference        # done*.txt status per channel → data/reference-status.json
pnpm opumia analyze-styles           # → data/style-profiles/*.json (draft)
```

## Production pipeline (`opumia produce`)

```bash
pnpm opumia produce --topic "The rise and fall of Enron" --channel magnates-media --aspect 9:16 --duration 60
pnpm opumia produce ... --until script            # stop after a stage (research|script|narration|storyboard|resolve|manifest|render|thumbnail|qa)
pnpm opumia produce ... --redo resolve,render     # re-run stages; everything else comes from out/<job>/ cache
pnpm opumia produce ... --repair 'sh001=why'      # editor override: re-pick a shot's picture, re-render, re-QA
npx tsx apps/cli/src/dev/smoke.ts                 # offline render test of every kit role and scene element (test kit, no paid APIs)
```

| Stage | Model / tool | Output in `out/<job>/` |
| --- | --- | --- |
| A1 research | Sonnet 5.5 + web search/fetch → Haiku 5.5 extracts claims → each source page fetched, Haiku checks each claim; evidence must appear verbatim | `facts.json` (`FactSheet` + `story` layer = `StoryDossier`: characters, scenes, contrast anchors, quotes — every item bound to verified claim ids) |
| A2 script | the writer agent (see **The writer**) | `script.draft.json` |
| A3 narration | directed narration (see **Voice**): voice director → passage takes → listen-back → retakes; length fitted by re-writing words, never by stretching the voice | `narration.mp3`, `timed-script.json` |
| B1 director | the director agent (see **The director**); its plan is converted by `director.ts` (data graphics bound to verified facts, every other shot a `scene`); music beds per chapter on a mood arc | `storyboard.json`, `probes.json` |
| B2 resolver | (see **Sourcing: planned, pooled, judged by eye** for the current flow) **press first** for entity shots (Wikipedia lead photo/logo + YouTube news excerpts via yt-dlp section downloads, Haiku vision check that the frame really shows the subject; `resolver/press.ts`) → archives → (20,946 captioned shots, cinematic, era, objects) → Haiku rerank (era- and person-aware) → stock/archival fallback → black-frame screen | `resolution.json`, `public/media/` |
| B2d art director | the film's own kit as code + its design tokens (see **Motion system**) | `design/film/`, `design.json` |
| B3 scene designer | the scene designer agent (see **The scene designer**): every scene from the kit and real pictures, checked in code (`scene-designer.ts`) | `scenes.json` |
| C1–C2 render | manifest → Remotion (muted) → FFmpeg mix (voice chain, sidechain-ducked bed, SFX at frame delays) → two-pass loudnorm −14 LUFS / −1.5 dBTP → mux | `manifest.json`, final `*_9x16.mp4`, `captions.srt` |
| C3 package | packaging agent (see **The packaging agent**) → description, tags, hashtags, pinned comment from its title | `thumbnail.jpg`, `publish.json`, `thumbs/` |
| C4 QA | ffprobe/ebur128/blackdetect/freezedetect + provenance + caption sync + facts + number parity + pacing; then the viewer QA agent and the final-cut judge | `qa.json`, `LICENSES.md`, `usage.json` |

Platform layer (topic- and channel-agnostic; no topic is hardcoded anywhere):
- **Art direction** (`agents/film-designer-agent.ts`, stage B2d → `design/film/` + `design.json`): the film's own kit (its components by role, typefaces, transition) and its `FilmDesignSystem` v2 tokens (palette from the film's pictures, contrast-guarded text colours, grain/vignette, one grade per act). The motion engine reads the tokens through live bindings (`remotion/types.ts:applyDesign` → `PALETTE`, `FONT*`, `TEXTURE`) and the kit through `@film`; act grades switch at chapter cards.
- **Blueprints:** the hook/ending/spine names the writer agent reports are kept as labels for the uniqueness check (`ScriptDraft.blueprint`, ProductionMemory).

- **ProductionMemory** (`agents/memory.ts` → `data/production-memory.json`; D1 table `production_memory`, `migrations/0002`): blocked asset refs (the resolver never offers them again), failed query phrasings (shown to the director as "avoid"), blueprint labels per channel.

Editorial rules enforced in code (keep them):
- **Story engine (script):** the writer works from the StoryDossier (characters, scenes, contrasts, quotes) and the channel's measured prose (median sentence 19 words, ~16 % of sentences with a digit, turn every ~31 s). `agents/narrative.ts` rejects: an origin/date in the cold open (before the thesis), no turn in the first 30 s, stretches > 50 s without a turn, choppy prose (median < 15 words or > 15 % of sentences ≤ 6 words), number dumps (> 30 % of sentences with a digit), stock filler re-hooks, and runs of date-led sentences; up to two targeted revisions. Long-form chapters run 90–150 s (`chapterCount`). Figures are digits with symbols (`normalizeFigures`).
- **Number parity:** `motion-engine/parity.ts` parses the spoken figures; a chart shows each spoken value exactly as said (`display`), and the scene designer refuses a kit number the narrator does not say in that shot. QA `number_parity`.
- **Sharp-plate compositing:** designed elements sit over SHARP footage graded darker (never blurred); a shot without footage sits on the kit's stage around a real picture, never on a borrowed plate or a stamp.
- **Reenactment first:** staged stock reenactment with anonymous actors is allowed and preferred for power/secrecy/engineers/boardroom/consumer beats; only recognisable celebrities/politicians shown as someone else are rejected. `resolver:mismatch` rejects title slates/credits, devices that post-date the beat (touchscreens before 2007 etc.) and a rival brand the line doesn't name.
- **Chapter cards** (long-form) are drawn by the kit's chapter role for 2.4 s; burned-in captions are hidden under them.
- **Voice:** see **Voice: directed narration** (Christopher, eleven v4, natural pace); broadcast voice chain in `audio.ts` (warmth, presence, de-ess, two-stage compression). Master −12.5 LUFS, music ducked ~8 dB.
- **Sound:** music bed evolves every ~45 s within a mood span; breathing drop-outs (1.2–1.6 s) about once a minute, a sub drop only after rehook/twist; hits ≈ 3/min, mostly low thuds/booms (no whooshes); riser + boom on chapter pivots.
- Only the reranker's accepted pick is ever used. A rejected shot gets another picture through the picture tools or is designed around a real picture on the kit's stage. Lines that name a person never show a stand-in face.
- Footage more than 15 years older than the story's era is out (5 years in repairs). Assets with `bugSpots` are excluded.
- The licence gate (`agents/library-menu.ts:isUsable`): licence required; `moments/`, `bank/` and `thumb_cache/` are never used in output; generated assets are allowed only for audio.
- Remotion's `bundle()` snapshots `public/`, so every render re-bundles.
- **Captions follow the channel** (`StylePack.captions`, learned from reference OCR with the watermark removed): MagnatesMedia long-form shows burned captions on ~2 % of shots, so 16:9 films in that style burn none (the SRT keeps every word); vertical shorts always burn captions.
- **Style data learned from the reference** (`agents/reference-grammar.ts`, in the style pack): section 8 visual grammar (276 hand-labelled MagnatesMedia shots joined with the words spoken over them) drives the director and scene designer; section 9 beat library (real passages per story role) drives the writer.
- **No duplicate text:** burned-in captions are suppressed under the kit's chapter cards (`FULLSCREEN_TEXT`), while the SRT keeps every word. Enforced by the `duplicate_text` QA check.
- **Safe zones** (`remotion/types.ts:SAFE`): lower thirds sit at `bottom: 24%` (9:16) and `16%` (16:9), with captions in the band below them.
- **Fact binding:** charts reference numeric fact IDs (`agents/numeric-facts.ts`) and their values are filled from the `FactSheet`; the kit draws them from those values only. Unbound graphics are returned to footage. Enforced by the `fact_binding` QA check (blocker).
- **Archive first:** shots with `entities` query Commons/NARA/Europeana by name + year first. A candidate's own metadata must name the entity. Archival photos render as 2.5D cards with a citation badge.
- **Period props:** typewriters, dip pens, rotary phones, vinyl and similar props are rejected for post-1985 stories (`resolver:anachronistic`). Frames over 85% white or uniform fail `blank_frames`.
- **Long-form:** chaptered scripts with `rehook` beats every 25–35 s, chapter-chunked narration stitched with FFmpeg, per-chunk director plans, music cue changes with crossfades, parallel chunk rendering (`render.ts:chunkRanges`), `youtube-description.txt` with chapter timestamps, and a `chapters` QA check.
- **`data/license-overrides.json`:** licence whitelists by glob (applied by the indexer only where a licence is missing) and per-channel `maxWpm` caps.

Credentials are loaded by `pnpm opumia …` (see **Secrets** above; check with `pnpm opumia keys`): `OPUMIA_ANTHROPIC_KEY`, `ELEVENLABS_API_KEY`, and the stock keys. In Cloudflare the same names are Workers secrets (the container receives the Claude key as `ANTHROPIC_API_KEY`).

## Sprint plan

1. ✅ **Foundation + local indexers**: monorepo, contracts, Library index, Reference status, draft StyleProfiles.
2. ✅ **Narration-first production**: research/fact-check, script, ElevenLabs `TimedScript`, director, resolver + 8 stock/archival adapters, Remotion scenes (parallax card, chart, map flyover, document highlighter, kinetic type, B-roll drift + overlays, word captions), FFmpeg mastering, thumbnail, QA + auto-repair. First film: `out/enron-short-9x16/` (60 s 9:16 MagnatesMedia).
3. ✅ **Cinema polish, archive-first, long-form, cloud**: duplicate-text, safe-zone, fact-binding, prop and blank-frame fixes; archive-first entity sourcing with citation badges; chaptered 16:9 long-form with parallel chunk rendering; license overrides; R2/D1 adapters, Worker, Workflow and Container. Verification film: `out/nokia-longform-16x9/`.
4. SigLIP embedding search over `footage/index` (text→image), per-chapter mastering stems, a remote Workflow run on a real Cloudflare account, and R2 upload tooling for the Library subset.

## Conventions

- Node ≥ 20, pnpm workspaces, ESM, TypeScript `strict` + `noUncheckedIndexedAccess`. Run with `tsx`.
- **Frame rate: 24 fps** (`contracts/render.ts:PLATFORM_FPS`, owner decision 2026-11-22): the documentary standard and the reference channel's most common rate (MagnatesMedia: 14 of 37 films at 24, 11 at 25, 10 at 30, 2 at 60). Every clip is conformed to it; never hard-code a frame rate.
- Keep CLI output short. Write details to `data/`.
- Never print API keys. Never put user data in URLs.
