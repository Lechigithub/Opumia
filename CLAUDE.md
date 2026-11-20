# Opumia — Autonomous Documentary Production Platform

## Goal

Opumia produces finished documentaries end to end, from topic to rendered and QA-checked film, in two formats:

- **Long-form `16:9`** (1920×1080, 8–30 min) explainer and business documentaries.
- **Short-form `9:16`** (1080×1920, 30–90 s) cut-downs and standalone shorts.

### The hard rule: ZERO AI-generated video

No frame of picture may come from a generative video or image model. Every visual is one of:

1. **A local asset** from `Library/`, a licensed and provenance-tracked catalog (see below).
2. **Licensed stock or archival media** fetched through an API: Pexels, Pixabay, Coverr, Vecteezy, Vimeo, Europeana, NARA and Wikimedia Commons.
3. **Designed motion graphics** rendered deterministically by Remotion: charts, maps, text cards, cutout collages and versus cards, built from data and licensed stills.

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

### Environment variables

Never commit them. Load from `.env`, documented in `.env.example`.

```
ANTHROPIC_API_KEY
ELEVENLABS_API_KEY
PEXELS_API_KEY  PIXABAY_API_KEY  COVERR_API_KEY
VECTEEZY_API_KEY  VECTEEZY_ACCOUNT_ID
VIMEO_ACCESS_TOKEN  EUROPEANA_API_KEY  NARA_API_KEY  WIKIMEDIA_ACCESS_TOKEN
HIGGSFIELD_API_KEY
OPUMIA_LIBRARY_DIR     (default ./Library)
OPUMIA_REFERENCE_DIR   (default ./Reference)
OPUMIA_DATA_DIR        (default ./data)
```

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
  motion-engine/  Aspect presets, camera-move math (Remotion compositions in Sprint 3)
apps/
  cli/            `opumia` CLI: index-library, analyze-styles, inspect-reference
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

## Cloudflare migration path

Code talks to persistence only through the adapter interfaces in `@opumia/contracts/adapters`:

- `BlobStore` (get/put/head/list by key) — local: `data/` + read-only `Library/` roots; cloud: **R2**.
- `CatalogDb` (upsert/get/query assets, profiles, jobs) — local: JSON files; cloud: **D1** (SQLite). The Zod schemas map to tables, with JSON columns for nested data.
- `JobQueue` / stage runner — local: CLI sequential; cloud: **Workflows** (one step per pipeline stage, retries and idempotency keys = stage + input hash).
- Stateless stages (Claude calls, ElevenLabs, stock search, QA judging) → **Workers**.
- FFmpeg/Remotion rendering → **Containers** (Remotion's renderer needs Chromium + FFmpeg).

Rule: no stage imports `node:fs` directly except the local adapters and the ingest probes, which run where the files live.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm opumia index-library            # → data/library-index.json (incremental)
pnpm opumia index-library --no-probe # stats + metadata only, no ffprobe
pnpm opumia inspect-reference        # done*.txt status per channel → data/reference-status.json
pnpm opumia analyze-styles           # → data/style-profiles/*.json (draft)
```

## Sprint plan

1. **Foundation + local indexers** (this sprint): monorepo, contracts, Library index, Reference status, draft StyleProfiles.
2. Research + script + ElevenLabs narration → `TimedScript`. Stock/archival API adapters with licence capture.
3. Direction + asset matching (SigLIP/text index + Haiku rerank) → `StoryboardShot[]`. Remotion compositions.
4. Render manifest → Remotion/FFmpeg render for 16:9 + 9:16. QA stage. Higgsfield thumbnails.
5. Cloudflare adapters (R2/D1/Workflows/Containers).

## Conventions

- Node ≥ 20, pnpm workspaces, ESM, TypeScript `strict` + `noUncheckedIndexedAccess`. Run with `tsx`.
- Keep CLI output short. Write details to `data/`.
- Never print API keys. Never put user data in URLs.
