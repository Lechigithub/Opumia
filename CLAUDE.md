# Opumia — Autonomous Documentary Production Platform

## Goal

Opumia produces finished documentaries end to end, from topic to rendered and QA-checked film, in two formats:

- **Long-form `16:9`** (1920×1080, 8–30 min) explainer and business documentaries.
- **Short-form `9:16`** (1080×1920, 30–90 s) cut-downs and standalone shorts.

### The hard rule: ZERO AI-generated video

No frame of picture may come from a generative video or image model. Every visual is one of:

1. **A local asset** from `Library/`, a licensed and provenance-tracked catalog (see below).
2. **Licensed stock or archival media** fetched through an API: Pexels, Pixabay, Coverr, Vecteezy, Vimeo, Europeana, NARA and Wikimedia Commons.
3. **Designed motion graphics** rendered deterministically by Remotion: charts, maps, text cards, cutout collages, versus cards and **composed scenes** (layered layouts written per shot by the scene designer), built from data and licensed or press stills.
4. **Fair-use press material** (`origin: "press"`, decided 2026-11-20): real news/interview/keynote footage from YouTube and Wikipedia portraits and logos of the people and companies the narration names. Used defensibly: excerpts ≤ 6.5 s, source audio never used, reframed/graded/composited under commentary, one clip per source video per film, never lifted from documentary channels (reference channels included), every use logged with source, channel, in-point and seconds in `ResolvedMedia.fairUse` and listed in `LICENSES.md`. QA `fair_use` (major): clips ≤ 7.5 s, ≤ 45 % of runtime, one clip per source, all logged.

The one exception is **thumbnails**, which are generated through the Higgsfield API. Thumbnails never enter the film timeline.

The rule is enforced in code. `StoryboardShot.source.kind` and `RenderManifest` layers have no AI-video variant, and the QA stage fails any manifest whose layer is not traced to an `AssetRecord` with a licence, or to a designed (Remotion) component.

Music beds in `Library/music` may carry generation prompts (`*.json` sidecars). Audio is allowed, but the indexer flags it as `provenance.generated = true` so credits stay honest.

## Tech stack

| Concern | Tool |
| --- | --- |
| Research, scripting, direction, QA judging, asset tagging | Claude API: **Sonnet** for reasoning-heavy stages (research, script, storyboard, QA verdicts) and **Haiku** for high-volume work (asset tagging, query expansion, caption checks) |
| Narration and word timestamps | ElevenLabs (TTS with character/word alignment), producing a `TimedScript` |
| Motion, camera moves (Ken Burns, pan, parallax), compositing, captions | Remotion |
| Probing, transcoding, trims, loudness (EBU R128), muxing | FFmpeg / ffprobe |
| Thumbnails | Higgsfield API |
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
  → Thumbnail (Higgsfield) + title/description
```

`StyleProfile`, derived from the six reference channels, conditions the script (WPM, structure), the direction (cuts/min, shot length, designed-vs-stock mix), the audio mix (LUFS, ducking, hit density) and QA thresholds.

## Repository layout

```
CLAUDE.md
package.json / pnpm-workspace.yaml / tsconfig.base.json
packages/
  contracts/      Zod schemas + inferred types + storage/DB adapter interfaces
  ingest/         Library indexer, Reference style analyzer, ffprobe + fs helpers
  agents/         Claude agents: research/fact-check, script, director, thumbnail style, QA judge; style pack; licence gate
  narration/      ElevenLabs /with-timestamps adapter, IPA pronunciation rules, word alignment, tempo-fit
  resolver/       Library-first asset resolver (BM25 + Claude rerank), 8 stock/archival adapters, QA repair
  motion-engine/  Remotion compositions (src/remotion), manifest builder, FFmpeg mastering, captions/SRT, Higgsfield, QA
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
pnpm db:migrate                          # applies migrations/0001_init.sql remotely
# Upload data/ (and the Library subset you want available) to R2, e.g. rclone sync data r2:opumia-media/data
for s in API_TOKEN INTERNAL_TOKEN ANTHROPIC_API_KEY ELEVENLABS_API_KEY PEXELS_API_KEY PIXABAY_API_KEY COVERR_API_KEY VECTEEZY_API_KEY VECTEEZY_ACCOUNT_ID VIMEO_ACCESS_TOKEN EUROPEANA_API_KEY NARA_API_KEY WIKIMEDIA_ACCESS_TOKEN HF_API_KEY_ID HF_API_KEY_SECRET; do npx wrangler secret put $s; done
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

- **Every shot is designed.** The director turns every non-data shot into a `scene`; `agents/scene-designer.ts` designs all of them in parallel batches after looking at reference frames (`data/exemplars`), inside the film's `FilmTreatment` (`design.json`: text styles, label/photo style, colour world, particles, wash, motif — never the headline+world pair of a recent film, `data/treatments.json`). `remotion/scenes/Composed.tsx` renders them: kinetic narration phrases synced to the voice, colour worlds, washes, particles, floating elements, light sweeps, sticker cutouts; `Three.tsx` adds real 3D (extruded type, lit picture cards).
- **Preview → critique → revise** (`produce` stage B4): every scene is rendered at three moments (`renderShotPreviews`), a Haiku critic flags what would not ship, flagged scenes are redesigned once. A code layout guard (`fitLayout`) keeps elements in the safe area and apart; the camera never crops designed elements.
- **Every picked picture is reviewed by eye** (`resolver/press.ts:reviewPictures`, Haiku): fit to the line (≥ 4/10), no burned-in graphics, right period, and **no stand-in face under a line naming a person**. Rejected picks get a wider search and alternates; failing that the shot has no footage and is designed on the film's colour world (never a borrowed clip).
- **Name guard** (scene designer, in code): on-screen text naming a real person may sit over footage only when that footage is verified press of that person; otherwise the scene moves to the colour world. Press checks are told how the sources refer to the person (he/she). **Scripted dramas, film clips and trailers are never press** (title/channel filter + vision rule).
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
- **Known limits:** Pexels allows ~200 searches/hour by default and a film asks ~130 — ask Pexels to lift it before running films back to back. The stored Europeana key is rejected (HTTP 401). Openverse times out intermittently. The Internet Archive adapter works but is not asked in the pooled search (whole films; the fixed moment fitted 0 of 55) until it has the moment finding YouTube has. Spare pictures can make a film repeat a motif (three CRT screens). No cross-film cache of researched subjects yet.

## Speed and cost (rebuild stage 10, 2026-11-21)

- **Stage clock** (`produce.ts`): every `[XX] name` log header opens a stage; seconds and Claude spend per stage go to `out/<job>/timing.json` and are printed at the end of every run ("Where the time and money went"). Each stage has a budget (`STAGE_BUDGET_USD`, for a 90 s film, scaled for longer ones); a stage over it is marked `OVER BUDGET`.
- **Film spend limit** (`agents/llm.ts:setBudget`): no model call starts once the film has spent its limit — $3 up to 90 s, $6 up to 4 min, else $15, or `OPUMIA_MAX_USD`. Finished stages are cached, so a stopped job resumes. ElevenLabs spend is not in this ledger.
- **Sourcing stage** has per-phase times in `sourcing.json.seconds`. One Wikipedia lookup and one YouTube press search per subject per film (they were repeated per shot); the plan and the web picture research run alongside the press and search phases. Measured on the Kodak plan: 352 s → 129 s, $0.08.
- **Scene critic is calibrated on the real channel** (`apps/cli/src/dev/critic-test.ts <job>`): real reference shots are shown to it as if they were ours and it must pass nearly all (measured 0 of 24 flagged; at the earlier, looser bar it rejected 8 of 24 real shots and 27–29 of 29 of ours). Only visible defects send a scene back (`HARD_DEFECT` with severity ≥ 7, or severity ≥ 9), worst first, at most 40 % of the film. It judges defects, not taste — taste is the release gate's job. Measured: 6 of 27 scenes revised; preview → critique → revise 45 s, $0.04.
- **Previews** render four stills at a time on one shared browser (27 scenes × 3 moments in 30 s).
- **Art direction runs alongside the script** (both need only the facts). Not yet exercised on a fresh film.
- Measured on the Kodak plan, sourcing to manifest (no render): B2 129 s $0.08, B3 43 s $0.17, B4 45 s $0.04.
- **Not done:** the publishing package still runs after the render rather than beside it (untested concurrency on the render was not risked without a film); the story blind test was not moved before narration (the blind judge is weak on story, so it would add cost without a trustworthy signal); render time has not been re-measured since the rebuild (no film has been rendered).

## Voice: directed narration and listen-back (rebuild stage 6)

`narration/directed.ts:narrateDirected` is the default (`OPUMIA_NARRATION=legacy` restores the single-pass path).

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
10. **Room tone** (`motion-engine/audio.ts`): measured on five MagnatesMedia films, the quietest 1 % of the sound sits 21–33 dB below the speech level; ours fell 34–53 dB below (a dry voice on digital silence when the music drops out). A filtered-noise bed made by FFmpeg sits 27 dB under the voice's level across the film: quietest 1 % now 26.6 dB below speech, loudness unchanged (−12.5 LUFS). `OPUMIA_ROOM_TONE=off` disables it.

11. **First-use voice measurement, automatic** (`narration/measure.ts:ensureVoiceMeasured`): the first time a voice is used on a model, the script stage has it read a short standard passage (six sentences, ≈ 465 characters, one take per sentence as in production) before any script is written. Its natural pace and expressiveness are stored in `data/voice-calibration.json` under `_natural` (`voiceId|modelId`) and never measured again; the script is cut to that pace and both gates check narration against it (±12 %). A voice clearly flatter than the channel's narrator is flagged in the log. There is no onboarding command to run. Measured: Christopher on v4 reads the passage at 171.1 wpm against 171 on a real narration (9 s, 463 characters); Brian, never used before, measured 172.5 wpm, melody 2.8.

## Agents: skill, tools, memory, own score (owner direction 2026-11-22)

Craft roles are being rebuilt one at a time as real agents instead of single prompts in a fixed pipeline. Each has: a **skill file** (the craft, versioned apart from code), **tools it calls itself**, a **loop** (work → measure → revise), a **memory of its own**, and **its own score** on a fixed set, so it can be improved independently and a change is kept only if the score improves. `agents/llm.ts:agentLoop` is the shared tool-using loop (validated tool inputs, all results of a turn in one message, thinking passed back unchanged, conversation cached turn to turn, the film's spend limit applies).

### The writer (first agent rebuilt)

- **Why:** the five-pass writer (draft → editor → structure critic → story revision → number rewrite) failed its own story test and damaged the prose ("By the end of that decade's follow-up, the late eighties"): each pass fixed one measure and broke another. It also used facts the research had not verified.
- **Story measurement** (`agents/story-measure.ts`): every line of a narration is labelled for what it does (scene, story, fact, explain, motive, quote, question, address, tease, maxim) by the same function for our scripts and the channel's real films. The blind A/B story judge could not tell a bland rewrite from the real channel (missed 4 of 4); this can. Measured on 30 MagnatesMedia films (`data/story-profile/magnates-media.json`): explains what things mean in 16–40 % of lines, talks to the viewer or as the narrator in 2–24 %, quotes ≤ 7 %, bare facts ≤ 19 %. Bland rewrites: viewer address 0 %; our old scripts: explains 6–17 %, quotes 8–24 %, facts up to 39 %.
- **Skill:** `packages/agents/skills/writer.md`.
- **Tools** (`agents/writer-agent.ts`): `list_reference_films`, `read_reference_film` (whole real narrations, `data/story-profile/<channel>-films.json`), `search_reference`, `measure_draft` (story band, length at the voice's pace, structure, figures, every figure and quotation checked against the verified fact sheet, speakable punctuation), `submit_script`, `note_lesson`.
- **One author:** code only verifies and formats (figures, ear punctuation); it never rewrites a sentence. No story menu: the writer builds each film's own structure from its facts; the old hook/ending names survive only as labels for the uniqueness check.
- **Memory:** `data/agents/writer/<channel>.md` (its own lessons and a log of every script) and `data/agents/writer/owner-notes.md` (the owner's feedback — add a line there and the writer reads it before its next script).
- **Score:** `npx tsx apps/cli/src/dev/writer-score.ts out/<job> …` → `data/agents/writer/score-history.json`. First score (2026-11-22): 3 of 3 accepted (Kodak 97 s $0.36, Theranos 129 s $0.37, Enron 78 s $0.23); the five-pass writer on Kodak: not accepted, 200 s, $0.61.
- **Gate:** a script that is not accepted is not narrated (`script.story.json`; `OPUMIA_STORY=warn` overrides). `OPUMIA_WRITER=legacy` runs the five-pass writer.
- **Limits:** acceptance means "inside the channel's measured range and factually clean", not "as good as the channel" — nobody has judged these scripts by ear or eye yet. Only 90-second scripts have been run; long-form is untested. Research leaves many claims unverified (Kodak: 20 of 36 "unreachable"), which starves the writer of facts — a research-agent problem. The other roles (director, scene designer, packaging) are still single prompts.

### The researcher (second agent rebuilt)

- **Why:** research was one pass — search once, fetch each source once with a basic request, drop every claim whose page could not be read. On Kodak 20 of 36 claims were lost that way (Washington Post, CNN Money, PetaPixel, Medium, even justice.gov refused or were gone), and the writer was left without the story's best facts.
- **Skill:** `packages/agents/skills/research.md`.
- **Tools** (`agents/research-agent.ts`): `web_search` (run by the API), `read_page` (live page, else the Internet Archive's copy — `agents/web.ts:readPage`; with `find` it returns the passages around a phrase), `plan_story` (the angle and the must-have facts it is held to), `record_claim` (one fact + its exact evidence sentence; the page is read, the sentence must be on it word for word, a strict Haiku check must agree; a failed claim is retried on another source), `sheet_status`, `finish` (refused until the sheet has depth and every must-have is covered or declared in `FactSheet.gaps`).
- **Depth:** the sheet aims at twice the bare minimum (≥ 20 facts for a short): ≥ 3 word-for-word quotations, ≥ 5 figures, ≥ 8 dated events, ≥ 5 independent sources, no source carrying more than 45 %; near-duplicates and paraphrases labelled as quotations are refused.
- **Memory:** `data/agents/research/hosts.json` (which sites could be read, from the archive, or not — learned every run, shown before the next) and `notes.md` (a log of every sheet).
- **Score:** `npx tsx apps/cli/src/dev/research-score.ts "Topic" …` → `data/agents/research/score-history.json`. Kodak: 24 verified (20 fully), 4 quotations, 10 figures, 7 sources, 3 pages recovered from the archive, 102 s, $0.33 — the single pass had 16 usable of 36. Theranos: 49 verified, 168 s, $0.62 (it over-collected; it is now told to stop once the sheet is full — not re-run).
- **Chain check:** the writer on the new Kodak sheet was accepted in 59 s for $0.28 with a visibly better script (viewer address 14 %, ends on Sasson keeping the camera "because it was too cool to throw away").
- **Limits:** page reading still fails on some sites even with the archive (Theranos: 9 of 16 pages unreadable, e.g. bbc.com, fda.gov) — a headless-browser reader is the next step. Source quality is not yet scored (a blog counts the same as a court filing). `OPUMIA_RESEARCH=legacy` runs the old single pass.

### The scene designer (third agent rebuilt)

- **Visual measurement** (`agents/visual-measure.ts`): a frame is labelled for the kind of shot it is (plain_footage, words_over_footage, caption_on_footage, title_card, picture_composition, logo, number_stat, chart, document_or_screen, map, comparison, infographic, quote_card), how many words it shows and how many pictures it composes — the same labeller for the channel's real shots and for our previews. Band: `data/visual-profile/<channel>.json`.
- **Measured on 276 real MagnatesMedia shots (9 films): 42 % are clean footage with nothing on them** (19–75 % per film), 26 % words over footage, the rest spread over ten kinds; text on 26–86 % of shots. Ours had text on 93–100 % of shots and clean footage on 0–4 %. **This overrides the older rule "every shot is designed / designed share ≥ 70 %"**: a scene may now be clean (`SceneSpec.elements` empty), only on moving video; a clean still is a `dead_frames` blocker in preflight.
- **Skill:** `packages/agents/skills/scenes.md`.
- **Tools** (`agents/scene-agent.ts`): `view_reference_shots` (real frames by kind), `design_scenes` (checked by the same guards as before), `render_previews` (its own shots at three moments — its eyes), `measure_film` (the visual band, unused pictures, one-word cards on a plain stage, four of a kind in a row), `submit_scenes` (refused until it has looked at every shot it designed or changed and has studied the reference), `note_lesson`. Tools can return images.
- **More tools (2026-11-22, owner: "the agents should have all the tools that make them better"):** `find_picture` (a different or additional picture for a shot — every stock and archive source, rated by eye against the line and the line's own year, as footage or as a slot), `search_library_objects` / `add_library_object` (the library's licensed cut-out objects and line icons), `cut_out_subject` (BiRefNet background removal on a photo slot), `play_shot` (seven moments of a shot as a strip). They live in `resolver/scene-tools.ts` and are handed to the agent as functions; pictures it fetches are written to `resolution.json` with their licences. A footage-less shot must now be built around a picture unless two different requests found nothing (`stage_without_picture`). Kodak plan: 11 pictures requested, 2 library objects added, one picture-less shot left of seven; 149 s, $0.29.
- **Researcher:** `read_page` now falls back to a real browser (`resolver/press.ts:pageTextViaBrowser`) after the plain request and the archive.
- **Memory / score:** `data/agents/scenes/<channel>.md`, `owner-notes.md`; `npx tsx apps/cli/src/dev/scene-score.ts out/<job>` → `data/agents/scenes/score-history.json`. Kodak plan: accepted in 109 s for $0.19 — 7 kinds of shot, clean footage 52 %, text on 52 % (the single prompt + critic: 88 s, $0.21, text on 93 %).
- **In production** the agent replaces stages B3 and B4 (`OPUMIA_SCENES=legacy` restores them); the preflight gate still gives every final scene a second look.
- **One-colour measure corrected:** a frame now counts as "carried by a colour" only when at least half of all its pixels are saturated pixels of one colour family (a wash or a colour stage); natural footage is carried by none. On the reference the typical film has 5–11 % of shots carried by one colour, the most extreme 38 %; the Kodak plan after repairs has 30 % (it passes, but sits above what is typical for the channel).
- **Limits:** shots with no footage are still the weak ones — a name or a word on the film's colour stage; the engine has no icon infographics, counters built from pictures, step flows, screen recordings or newspaper layouts, which the channel uses. The whole-film colour wash still reads warm. The **director has not been rebuilt**: it still decides the shot list and what each shot needs in one prompt, before any footage is known.

## Preflight gate (2026-11-22)

`produce` stage **B6** (`apps/cli/src/preflight.ts`, wired in `produce.ts`) runs every release-gate check that can be computed before the render, on the plan, the final scene previews and the narration. A failing check with a repair is repaired and checked again (two repair rounds); what still fails is written to `out/<job>/preflight.json` and **the render is refused** ("nothing was rendered"). `OPUMIA_PREFLIGHT=warn` renders anyway, for debugging only.

| Check (blocker unless noted) | Repair |
| --- | --- |
| picture repeated in the film / used by a recent film; second clip from one source video; press clip > 7.5 s; press footage > 45 % of runtime | `drop_picture`: the picture is removed and that scene designed again |
| scene with a visible defect on its **final** preview (every scene gets a second look, not only revised ones) | `safe_scene`: reduced to its clean core (backdrop + its spoken phrase) |
| outlined box or circle that frames nothing | `prune_shapes` |
| previews too dark, dull, or carried by one colour (`one_colour_film`: share of scenes whose dominant colour family is the film's most common one, against the channel's own films — `data/.cache/hue-dominance-<channel>.json`) | `soften_wash`: colour wash and dimming halved on washed scenes; if still one-colour, `vary_stage`: picture-less scenes move from the colour stage to paper and the dark surface in turn |
| effects or music a recent film used; one sound family > 60 %; plan too close to an earlier film in sound only | `reseed_sound` |
| picture coverage < 60 %; designed share < 70 %; slow-zoom share > 20 %; > 2 scenes in a row on one bare backdrop; > 35 % picture-less scenes; plan too close to an earlier film in colour/treatment/layout/story/words; unresolved narration words; word error > 1 %; pace outside the voice's natural band | none — the render is refused with the reason |
| voice expressiveness against the reference narrator (pace variety, pitch travel, melody, dynamics, pauses) | **advisory**: reported, no automatic repair with a fixed voice |

- After scene repairs the sound timeline is laid again on the final scenes; the manifest and fingerprint are rebuilt.
- Measured on the Kodak plan: the first version passed a plan with a visible empty box, garbled text and a one-tone look, so the one-colour, empty-frame and all-scenes second-look checks were added; it then failed 3 checks, repaired them in two rounds and passed — 61 s, under $0.01.
- Movement, near-still time, cuts and anything needing the mixed audio can only be measured on the rendered film: those stay with `opumia eval`.
- Listen-back compares a hyphenated compound as one word when the recogniser writes it that way ("Film-less" / "filmless") — it used to cost three paid retakes and leave the line unresolved.

## Sound: timeline sound designer (rebuild stage 7)

`agents/sound-timeline.ts:designSoundTimeline` (no model call) runs as `produce` stage **B5**, after the scenes are final, and replaces the director's sound plan:

- **Sound goes on what the viewer sees.** Events come from the finished scenes: a stamp landing, a headline, 3D type, a 3D card, a data graphic opening, a document, a story turn. Each asks for a sound *family*.
- **Reference budget and mix** (measured on MagnatesMedia: 3.06 strong hits/min — 55 % thud, 26 % boom, a few clicks/plucks/risers, almost no whooshes): strong hits capped at the channel's density and ≥ 2.4 s apart, booms ≤ 30 % of them, ≤ 2 light accents/min, a riser into the biggest moments.
- **Files by measured character:** `pnpm opumia profile-audio` → `data/audio-profile.json` (`measureSound` / `measureMusic` on every usable effect and bed, incremental). Only designed hit sounds may be hits (`HIT_CLASS`); literal object noises are never used as accents. Choices are shuffled by the film's id, never repeated in a film, and exclude sounds the last 12 films used (`data/asset-usage.json`). The sound's peak is placed on the visual moment (start = moment − measured attack); level is set from the measured peak.
- **Music:** per mood span, by title mood + measured tempo and pulse, off cooldown; `MusicCue.inS` starts the bed after its quiet intro with the beat on the first strong hit. Drop-outs from the earlier sound design are kept.
- `resolver/resolve.ts:resolveAudio` re-materialises effects and music after this stage.

## Publishing package (rebuild stage 8)

`produce` stage **C3** builds the whole package with `apps/cli/src/publish.ts` + `agents/publishing.ts` (test without rendering: `npx tsx apps/cli/src/dev/package-test.ts out/<job>`). Outputs: `thumbnail.jpg`, `publish.json`, `youtube-description.txt`, `youtube-tags.txt`, `pinned-comment.txt`.

- **Thumbnail from real pictures, no generated imagery.** The film's verified press stills, the main subjects' Wikipedia photos and logos, and matching `Library/objects` cutouts become picture slots; photos are cut out with `senses/cutout.ts:removeBackground` (BiRefNet-lite, MIT, ONNX; keeps only source pixels). A Sonnet designer, shown real reference thumbnails and the channel's learned rules (`data/thumbnail-grammar/<channel>.json`), writes one composed scene with its own palette; it is rendered by the film's scene engine (`ThumbnailScene`), measured against the reference thumbnails' colourfulness, and put through an **imposter test** among real thumbnails; one revision if picked out. Recent concepts are avoided (`data/thumbnail-concepts.json`). The Higgsfield plate path is legacy (`OPUMIA_THUMBNAIL=higgsfield`).
- **Title:** six candidates from the reference titles weighted by views; figures must be in the film; the winner is the candidate least often picked out among real titles.
- **Credits follow each source's terms** (`publish.ts:creditLines`, `SOURCE_CREDIT`): one visible link line per source the film really uses ("Stock footage and photos provided by Pexels — https://www.pexels.com", likewise Pixabay, Coverr, Vecteezy, Commons, Europeana, NARA, Openverse, Internet Archive), then per-item credits with a link — licence-required ones (CC BY / BY-SA, Vecteezy, music) always, creator credits for Pexels and Pixabay as space allows. Press excerpts are covered by the fair-use notice, not here.
- **Description:** hook + story paragraph in the channel's style (only figures the narration speaks), chapters, sources, a fair-use notice naming the rights holders of press excerpts, credits, hashtags. **No channel-links slot** (owner decision).
- **Tags** (≤ 480 characters; never the reference channel's name or a term the film does not use), **hashtags** (3–5), **pinned comment** (a specific question about the story; no links).
- **Package check** (Haiku): title, thumbnail words, description and pinned comment against the narration — anything promised but not delivered is listed in `publish.json.checks`.
- Reference packaging lives in the exemplar library (`packaging`: title, views, description story paragraph, tags).

## Uniqueness: treatment and fingerprint (rebuild stage 9)

No two films may share anything but the channel's style. `agents/fingerprint.ts`:

- **Fingerprint** of every planned film (`data/fingerprints.json`, and `out/<job>/fingerprint.json`): colour world, type and treatment (incl. the film's **signature transition**), where designed elements sit on screen (element type × 3×3 cell), backdrop and shot-kind mix, story blueprint, opening and closing words, title, sounds and music.
- **Similarity** per respect with limits (`UNIQUE_LIMITS`: colour 0.7, treatment 0.56, layout 0.9, story 0.67, words 0.4, sound 0.34). `closest()` names the nearest earlier film and what is over a limit; the release gate check `unique_plan` fails a film that is too close in any respect.
- **Prevention at every planning stage** (`habitsOf` over the last 6 films): the art director is told recent hues, treatments, type and transitions (and guarded in code); the writer is given recent openings to avoid; the scene designer is told the placements recent films leaned on; sounds and pictures are on cooldown; thumbnail concepts are avoided.
- **Within a film:** the treatment keeps it coherent; scene guards keep it from becoming a slide deck — no filler-word headlines, no empty frames (a frame shape must frame something), at most two scenes in a row on the same non-footage backdrop (rotates colour world → dark surface → paper).
- `out/<job>/treatment.md` is the film's written treatment (concept, colour world, type, styles, transition, motif, story shape, closest earlier film).

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
npx tsx apps/cli/src/dev/smoke.ts                 # offline render test of every scene primitive (no paid APIs)
```

| Stage | Model / tool | Output in `out/<job>/` |
| --- | --- | --- |
| A1 research | Sonnet 5.5 + web search/fetch → Haiku 5.5 extracts claims → each source page fetched, Haiku checks each claim; evidence must appear verbatim | `facts.json` (`FactSheet` + `story` layer = `StoryDossier`: characters, scenes, contrast anchors, quotes — every item bound to verified claim ids) |
| A2 script | Sonnet 5.5, channel **style pack** in a cached system block (profile + technique cards + story labels + real cold opens) | `script.draft.json` |
| A3 narration | ElevenLabs `/with-timestamps`; channel voice resolved by name via `/v1/voices` and cached with its tuned settings in `data/voice-calibration.json` (`_voices`; MagnatesMedia = "Christopher", tuned by `apps/cli/src/dev/voice-audition.ts`); dramatic `<break>` beats (`narration/beats.ts`, skipped by the aligner); char→word alignment, fit window (short: duration−8 … −1 s), ≤6 % `atempo` fit, else one re-write; pace learned per voice+settings | `narration.mp3`, `timed-script.json` |
| B1 director | Sonnet 5.5, shots start on word indices, designed kinds + props; then `agents/sound-design.ts`: one music bed per chapter on a mood arc, drop-outs on cliffhangers, riser+boom on chapter pivots, SFX on ~50 % of reveals at the channel's hit density (from `sound.json` → StyleProfile.audio) | `storyboard.json` |
| B2 resolver | (see **Sourcing: planned, pooled, judged by eye** for the current flow) **press first** for entity shots (Wikipedia lead photo/logo + YouTube news excerpts via yt-dlp section downloads, Haiku vision check that the frame really shows the subject; `resolver/press.ts`) → archives → (20,946 captioned shots, cinematic, era, objects) → Haiku rerank (era- and person-aware) → stock/archival fallback → black-frame screen | `resolution.json`, `public/media/` |
| B3 scene designer | Sonnet 5.5, one call per film (`agents/scene-designer.ts`): a `SceneSpec` per `scene` shot — backdrop, layered photo/cutout/text/shape/texture elements with entrances, depth and camera — from the film's design tokens, the resolved picture slots (layer role) and the channel's labelled designed shots; sanitised in code (slots must exist, figures only if spoken). Rendered by `remotion/scenes/Composed.tsx` | `scenes.json` |
| C1–C2 render | manifest → Remotion (muted) → FFmpeg mix (voice chain, sidechain-ducked bed, SFX at frame delays) → two-pass loudnorm −14 LUFS / −1.5 dBTP → mux | `manifest.json`, final `*_9x16.mp4`, `captions.srt` |
| C3 thumbnail | Sonnet vision extracts channel thumbnail rules (`data/thumbnail-styles/`) → Haiku brief → Higgsfield plate (no text, no real people) → Remotion still with headline | `thumbnail.jpg` |
| C4 QA | ffprobe/ebur128/blackdetect/freezedetect + provenance + caption sync + facts + number parity + card length + lower-third backdrop + pacing + Sonnet vision judge; ≤2 autonomous B-roll repair rounds | `qa.json`, `LICENSES.md`, `usage.json` |
| benchmark (dev) | `npx tsx apps/cli/src/dev/benchmark.ts out/<job>`: our frames + metrics vs the channel's technique clips (`Library/moments/<channel>/`), reference b-roll and profile; strict Sonnet vision gap list | `benchmark.md`, `benchmark.json`, `benchmark/` |

Platform layer (topic- and channel-agnostic; no topic is hardcoded anywhere):
- **Art direction** (`agents/art-director.ts`, stage A1b → `design.json`): a `FilmDesignSystem` per film — palette tokens (primary, accent, surfaces, paper, marker, text; contrast-guarded), display/body type pairing, grain/vignette/halftone, one grade per act, scene-grammar favour/avoid list. The motion engine reads it through live bindings (`remotion/types.ts:applyDesign` → `PALETTE`, `FONT*`, `TEXTURE`); act grades switch at chapter openers.
- **Blueprints** (`agents/script.ts`): cold-open archetype (irony, reversal, mystery, stakes, flash_forward, claim, question) + story-family spine + ending archetype (callback, lesson, open_question, where_now, warning), chosen per dossier from the style pack's catalog (section 7) and never repeating the channel's recent films (ProductionMemory). Stored on `ScriptDraft.blueprint`.
- **Asset-aware composer** (`motion-engine/compose.ts`, inside `buildManifest`): layouts are checked against what really resolved (no portrait → name slam, no subject → title slam; never a placeholder) and the scene grammar stops any layout repeating within 45 s. Captions are hidden under layouts with their own lower-frame text (`CAPTION_HIDE`).
- **ProductionMemory** (`agents/memory.ts` → `data/production-memory.json`; D1 table `production_memory`, `migrations/0002`): blocked asset refs (gate + judge rejections; the resolver never offers them again), failed query phrasings (shown to the director as "avoid"), blueprints used per channel, benchmark outcomes with visual mix.
- **Pre-render frame gate** (`motion-engine/gate.ts` + `agents/judge.ts:gateReview`, Haiku vision): ~10 key stills before the full render; off-era/mismatched/misleading footage is re-picked (and blocked in memory), broken or overlapping graphics are dropped to footage, then the manifest is rebuilt. Output `gate/`, `gate.json`.

Editorial rules enforced in code (keep them):
- **Story engine (script):** the writer works from the StoryDossier (characters, scenes, contrasts, quotes) and the channel's measured prose (median sentence 19 words, ~16 % of sentences with a digit, turn every ~31 s). `agents/narrative.ts` rejects: an origin/date in the cold open (before the thesis), no turn in the first 30 s, stretches > 50 s without a turn, choppy prose (median < 15 words or > 15 % of sentences ≤ 6 words), number dumps (> 30 % of sentences with a digit), stock filler re-hooks, and runs of date-led sentences; up to two targeted revisions. Long-form chapters run 90–150 s (`chapterCount`). Figures are digits with symbols (`normalizeFigures`).
- **Number parity:** `motion-engine/parity.ts` parses the spoken figures; a counter shows exactly the spoken string ("$7.2 billion" → "$7.2B") or is dropped; chart/versus values that are spoken use the spoken form. QA `number_parity`.
- **Sharp-plate compositing:** designed elements sit over SHARP footage graded darker (never blurred); the procedural `atmosphere` only when a film has no footage at all. Signature primitives (`remotion/scenes/Signature.tsx`): HeroFaceSplit (`hero_face`), SharpOverlayCounter (`money_figure`), CutoutCollage (`cutout_collage`), TitleRollChapter (`chapter_card`, auto at each long-form chapter start), ScreenMock (`screen`); plus DocumentHighlightCard, TrajectoryChart, VersusSplitCard, tactical MapFlyover. Director caps: ≤ 3 counters per 150 s (unique facts, ≥ 20 s apart), unique text slams, ≤ 30 % designed shots.
- **Reenactment first:** staged stock reenactment with anonymous actors is allowed and preferred for power/secrecy/engineers/boardroom/consumer beats; only recognisable celebrities/politicians shown as someone else are rejected. `resolver:mismatch` rejects title slates/credits, devices that post-date the beat (touchscreens before 2007 etc.) and a rival brand the line doesn't name.
- **Text slams ≤ 3.2 s** (`big_word`, `quote_card`; `CARD_MAX_S`, reference median 3.12 s) laid over sharp footage; chapter rolls 2.4 s; burned-in captions (dark translucent pill) hidden under them. QA `card_length`; lower thirds must sit over a detailed picture (QA `lower_third_backdrop`).
- **Voice:** Christopher at stability 0.4 / similarity 0.8 / style 0.35 / speed 1.1 (~196 wpm, audition in `voice-calibration.json`); `<break>` only before chapter changes and after rehook/twist lines; broadcast voice chain in `audio.ts` (warmth, presence, de-ess, two-stage compression). Master −12.5 LUFS, music ducked ~8 dB.
- **Sound:** music bed evolves every ~45 s within a mood span; breathing drop-outs (1.2–1.6 s) about once a minute, a sub drop only after rehook/twist; hits ≈ 3/min, mostly low thuds/booms (no whooshes); riser + boom on chapter pivots.
- **Thumbnail fallback:** without a Higgsfield plate, `ThumbnailLocal` composites the top-10 pattern from Library assets (one focal cutout, crimson/gold/emerald field, flames/cash motif, 0–3 words) → `thumbnail.local.json`.
- Only the reranker's accepted pick is ever used. A rejected shot falls back to an approved picture from the same segment, or to kinetic type of the spoken words. Lines that name a person always use kinetic type: never a stand-in face.
- Footage more than 15 years older than the story's era is out (5 years in repairs). Assets with `bugSpots` are excluded.
- The licence gate (`agents/library-menu.ts:isUsable`): licence required; `moments/`, `bank/` and `thumb_cache/` are never used in output; generated assets are allowed only for audio.
- Remotion's `bundle()` snapshots `public/`, so every render re-bundles.
- **Captions follow the channel** (`StylePack.captions`, learned from reference OCR with the watermark removed): MagnatesMedia long-form shows burned captions on ~2 % of shots, so 16:9 films in that style burn none (the SRT keeps every word); vertical shorts always burn captions.
- **Style data learned from the reference** (`agents/reference-grammar.ts`, in the style pack): section 8 visual grammar (276 hand-labelled MagnatesMedia shots joined with the words spoken over them) drives the director and scene designer; section 9 beat library (real passages per story role) drives the writer and the **story editor pass** (`script.editor`), which rewrites AI/news-wire lines into the channel's voice before the structural critic.
- **No duplicate text:** `big_word` is only a date, a stat or a 1–2 word stamp. Burned-in captions are suppressed under full-screen text cards (`FULLSCREEN_TEXT`), while the SRT keeps every word. Enforced by the `duplicate_text` QA check.
- **Safe zones** (`remotion/types.ts:SAFE`): lower thirds sit at `bottom: 24%` (9:16) and `16%` (16:9), with captions in the band below them.
- **Fact binding:** charts, counters and versus cards reference numeric fact IDs (`agents/numeric-facts.ts`) and their values are filled from the `FactSheet`. Unbound graphics are demoted to footage. Enforced by the `fact_binding` QA check (blocker).
- **Archive first:** shots with `entities` query Commons/NARA/Europeana by name + year first. A candidate's own metadata must name the entity. Archival photos render as 2.5D cards with a citation badge.
- **Period props:** typewriters, dip pens, rotary phones, vinyl and similar props are rejected for post-1985 stories (`resolver:anachronistic`). Frames over 85% white or uniform fail `blank_frames`.
- **Long-form:** chaptered scripts with `rehook` beats every 25–35 s, chapter-chunked narration stitched with FFmpeg, per-chunk director plans, music cue changes with crossfades, parallel chunk rendering (`render.ts:chunkRanges`), `youtube-description.txt` with chapter timestamps, and a `chapters` QA check.
- **`data/license-overrides.json`:** licence whitelists by glob (applied by the indexer only where a licence is missing) and per-channel `maxWpm` caps.

Credentials are loaded by `pnpm opumia …` (see **Secrets** above; check with `pnpm opumia keys`): `OPUMIA_ANTHROPIC_KEY`, `ELEVENLABS_API_KEY`, the stock keys, and Higgsfield `HIGGSFIELD_API_KEY` in `id:secret` form (or `HF_API_KEY_ID` + `HF_API_KEY_SECRET`). Without usable Higgsfield credentials the thumbnail stage writes `thumbnail.brief.json`; put a plate at `public/thumb_bg.png` and re-run. In Cloudflare the same names are Workers secrets (the container receives the Claude key as `ANTHROPIC_API_KEY`).

## Sprint plan

1. ✅ **Foundation + local indexers**: monorepo, contracts, Library index, Reference status, draft StyleProfiles.
2. ✅ **Narration-first production**: research/fact-check, script, ElevenLabs `TimedScript`, director, resolver + 8 stock/archival adapters, Remotion scenes (parallax card, chart, map flyover, document highlighter, kinetic type, B-roll drift + overlays, word captions), FFmpeg mastering, Higgsfield thumbnail, QA + auto-repair. First film: `out/enron-short-9x16/` (60 s 9:16 MagnatesMedia).
3. ✅ **Cinema polish, archive-first, long-form, cloud**: duplicate-text, safe-zone, fact-binding, prop and blank-frame fixes; archive-first entity sourcing with citation badges; chaptered 16:9 long-form with parallel chunk rendering; license overrides; R2/D1 adapters, Worker, Workflow and Container. Verification film: `out/nokia-longform-16x9/`.
4. SigLIP embedding search over `footage/index` (text→image), per-chapter mastering stems, a remote Workflow run on a real Cloudflare account, and R2 upload tooling for the Library subset.

## Conventions

- Node ≥ 20, pnpm workspaces, ESM, TypeScript `strict` + `noUncheckedIndexedAccess`. Run with `tsx`.
- Keep CLI output short. Write details to `data/`.
- Never print API keys. Never put user data in URLs.
