# Opumia — autonomous documentary production

Opumia makes finished documentaries, topic to rendered, checked and packaged film, in the style of one reference
channel (MagnatesMedia today), in **16:9 and 9:16, at any length**. This file describes the platform as it is now.
How it got here (the old `produce` pipeline, every measurement and dead end) is in `docs/HISTORY.md`; the audit that
retired the old pipeline is `docs/PLATFORM-AUDIT.md`. History is never instructions.

## Owner decisions (current; older ones are in docs/HISTORY.md and no longer apply)

- **Match the reference style 1:1**, using everything the reference uses where available: how it writes and
  structures, its typefaces, layouts, grades, cutting, sound, thumbnail and title formulas. Any topic is open.
- **Originality between our films** = vary what the channel varies between its own films, as much as it does —
  measured against the channel's own film-to-film spread, never a stricter rule of ours.
- **Never reused:** the channel's name; its actual material (sentences, frames, graphics, music files, thumbnails);
  its logo, corner bug, intro/outro; a clone of its narrator's voice.
- **No AI-generated pixels anywhere**, thumbnails included. Deterministic edits of real pictures (filters,
  compositing, retouching) are allowed. Audio may be generated; it is marked as such in the credits.
- **Fair use at the channel's measured practice:** press and film clips ≤ 8.5 s, real footage ≤ 27 % of the runtime,
  several clips per source allowed, source audio never used, every use logged. A named person is shown with real
  material when it exists; otherwise a performed reenactment (the name over it is allowed).
- **Voice:** the owner's only voice rule — every voice speaks at its own natural pace (speed 1.0, never stretched or
  pushed toward the reference narrator). Everything else about the voice is engineering judgement against the
  reference. MagnatesMedia's voice: Christopher on Eleven v4.
- **Covers:** a 9:16 film's cover is its first frame (baked in, so the shorts/reels feed shows it with no upload); a
  16:9 film has a separate thumbnail. Both are made the way the channel makes its thumbnails, at its measured level.
- **Speed and cost are priorities:** targets ≈ $3 and 30 min for a 90 s film, $2 per minute of film.
- **One production path: the film agent.** Retired code is deleted, superseded instructions are removed.
- **The reference is the judge**, never the owner's eye. **Every paid run needs the owner's approval.**
- Models: Sonnet and Haiku; Opus 5.5 writes scripts for films with chapters (≥ 5 min). 3D through Three.js inside
  Remotion. No Storyblocks. Single user (the owner's channels) first.

## Secrets (non-negotiable, applies to every agent session)

- **Where keys live:** macOS Keychain, generic password, service `opumia`, account = the variable name
  (e.g. `opumia / ELEVENLABS_API_KEY`). CI uses GitHub Actions secrets.
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
- Names: `OPUMIA_ANTHROPIC_KEY` (Claude), `ELEVENLABS_API_KEY`, the stock/archive keys (`.env.example` lists them).

## Data safety (non-negotiable)

- **`Library/` and `Reference/` are read-only to all code.** Never write, move, rename, delete or "clean up" anything
  in them (`.DS_Store`, logs, locks and caches included). The film agent's guard refuses writes there, any use of
  `Library/moments`, `bank`, `thumb_cache`, and any cut or copy from `Reference/` into a film.
- `Library/bank/` files are used by another tool: read without locks; if `items.json` is mid-write, retry, then skip.
- Never overwrite `Library/bugspot_cache.json` or `Library/wiki_ipa_cache.json`; our caches go in `data/.cache/`.
- Writes are atomic (temp file, then rename). ffprobe read-only, `-v error`, only on files whose size|mtime changed.
- `data/` holds generated outputs and memories; `out/<job>/` is each film's workspace (git-ignored).

## The production path: `pnpm opumia film-agent`

```bash
pnpm opumia film-agent --topic "…" [--duration 70] [--aspect 16:9|9:16] [--max-usd N] [--parallel 4] [--solo] [--dry-run]
```
A paid run (owner approval first). Re-running the same command resumes: every finished stage is cached in `out/<job>/`.
Code: `apps/cli/src/film-agent/`. The default spend limit scales with length (today ≈ $9 per 70 s, see Limits).

1. **Story** (`story.ts`, in-process): research → script → narration, each cached.
   - **Researcher** (`agents/research-agent.ts`, skill `research.md`): web search, pages read live / from the archive /
     PDFs / YouTube captions, every claim checked word for word on its page → `facts.json`.
   - **Writer** (`agents/writer-agent.ts`, `writer.md`): writes to the channel's measured story bands and structure
     (`story-structure.ts`: intro ≈ 50 s, chapters ≈ 3:11, twist mid-film), checked by the script referee (below);
     long films get a parallel first draft. Can ask the researcher for facts → `script.draft.json`.
   - **Voice** (`narration/directed.ts`, voice director `voice.md`): one take per sentence, listen-back (Whisper +
     phoneme check), retakes of failing lines, lines that still fail reworded for speech; length fitted by pauses
     and rewording, never by speed; cold open shaped (pauses ≤ 0.6 s; a title breath for long films)
     → `narration.mp3`, `timed-script.json`, `narration.report.json`.
2. **Planner** (one Sonnet session, `film-planner.md`): watches the reference, checks the pictures exist, writes
   `WORLD.md`, `src/world.tsx` (the film's look as code) and `plan.json` (a scene per idea against the word times,
   the signature object, chapter scenes). `plan.ts:validatePlan` refuses an unusable plan; `process.ts` refuses a plan
   made without watching the reference or searching for real material of every named subject.
3. **Prefetch** (code): every scene's planned searches run at once into `downloads/<id>/PREFETCH.md`.
4. **Scene builders** (one session per scene, 4 at once, `scene-builder.md`): find their pictures, build
   `src/scenes/<id>.tsx` until `film-tools scene-check <id>` passes.
5. **Render** (code, `packages/motion-engine/src/hand/render-film.ts`) → `picture.mp4`; a draft `mix.json` from the
   plan's marks and builders' hit points (`sound-draft.ts`).
6. **Checks before the finisher** (`checks.ts` → `FINDINGS.md`), then the **finisher** (the planner's session
   resumed, `film-finisher.md`): watches the film whole beside the reference, sends scenes back (`REBUILD.json`, up to
   three rounds), fixes seams, mixes, answers every FIX in `FIXES.md`, runs the gate.
7. **Fresh eyes** (`after.ts`, in parallel): the viewer QA agent (`qa.md`), the picture referee, the packaging agent
   (`packaging.md`: title, thumbnail from real pictures, description, tags, pinned comment). Their issues go back to
   the finisher once (`TELLS.md`).
8. **Gate passes → the film is registered** (`register.ts`): `data/produced.json`, `asset-usage.json` (pictures by
   source, beds, effects — the cooldown), `film-kits.json`, its type look and world profile, music credits in
   `LICENSES.md`.

`--solo` runs one session for every role (`film-solo.md`). Every session's tools go through `run.ts:guard`: no keys
or environment, no Keychain, no git, writes only in the workspace (a builder only its own scene's files), Library and
Reference read-only, no other film's workspace, nothing posted out.

### Instructions the agents read (`settingSources: []` — they never see this file)
`packages/agents/skills/`: `film-agent.md` (shared playbook) + `film-planner.md`, `scene-builder.md`,
`film-finisher.md`, `film-solo.md`; `research.md`, `writer.md`, `voice.md`; `qa.md`, `packaging.md`. Also the
`CRAFT_TOOLS` list in `packages/motion-engine/src/remotion/craft.tsx` (techniques with no look of their own: every
colour, type, case and camera move is set by the film) and each agent's lessons in `data/agents/<agent>/`
(`film-agent/magnates-media.md`, last 40 lines; writer and voice, last 30). A skill or lesson must never prescribe one
look for every film or name an earlier film of ours as the model.

### `film-tools` (the agents' commands, `tools.ts`, `TOOLS.md`)
`ref` (list / watch / similar / technique — the channel's real shots, held-back films hidden), `watch`, `press`,
`clip` (≤ 8.5 s, muted, logged; a moment a recent film used is refused), `screenshot`, `commons`, `stock`,
`stock-get`, `films` (public-domain), `credit`, `cutout`, `depth`, `render`, `referee`, `rank`, `scene-check`,
`beds` / `sfx` (licensed and off cooldown only), `mix`, `type-check`, `world-check`, `gate`, `lesson`, `spend`.

### Checks
| Where | Checks |
|---|---|
| Plan (`plan.ts`, `process.ts`) | scene count and lengths, scenes touch end to end, signature object is a real thing (no drawn instrument), a person-performing search where nothing real exists, each chapter opened by a `chapter` scene; the planner watched ≥ 3 reference stretches from ≥ 2 films and searched for every named subject |
| Scene (`scene-check.ts`, `footage.ts`) | built, own media only, every file credited, renders, not blank, not too dark (channel's darkest 5 %), fair-use share so far ≤ 27 %, the builder looked at its stills and studied the reference, real material searched first, picture referee ≥ the channel's weakest tenth (4.57), best footage used, footage shows through, no burned-in text, searched enough |
| Before the finisher (`checks.ts`, FIX or look) | captions.srt, LICENSES.md, figures on screen vs narration and facts, period of footage vs the line's year, a stranger's face where the real person's material exists, repeats, dark stretches, closing title over the strongest footage, **type look** vs our earlier films, motion (advisory), world check (advisory) |
| Gate (`gate.ts`) | whole narration at the film's frame and 24 fps; a 9:16 film opens on its cover (`cover_9x16.jpg`, made frame one by `mix.ts`); −12.5 ± 1 LUFS, peak ≤ −1.4 dB; the mix is of the current picture; type checks; fair use (≤ 8.5 s clips, ≤ 27 %, never a documentary or reference channel); every picture credited; no AI; nothing of the channel's own; signature object not reused or generic; **type look**; voice pace ±12 % of natural, word error ≤ 1 %, ≤ 1 unresolved line; every bed and effect licensed; every FIX answered; picture referee ≥ 4.9; REVIEW.md |

### The mix (`mix.ts`)
Voice through the broadcast chain at −16 LUFS; room tone 27 dB under it; beds **not ducked** (the channels duck
0.2 dB), 17.3 dB under the voice in the cold open and 20.6 dB in the body; cues and drop-outs from `mix.json`;
master −12.5 LUFS, limiter. Only beds and effects with a recorded licence in `data/library-index.json` (56 of 127 beds).

## Referees and measures (the reference decides; built locally, no model at scoring time)
- **Picture referee** (`apps/cli/src/referee/`, `data/referee/magnates-media-taste.json`): SigLIP heads; film bar 4.9,
  weak-stretch bar 4.57; 8 channel films held back. It rewards a family of dark cinematic documentaries, not fit to
  the line — a floor, not the goal. Build/prove: `npx tsx apps/cli/src/dev/referee-build.ts`.
- **Script referee** (`tools/referee/script_referee.py`, `agents/script-referee.ts`): two measures on topic-free
  features — human (bars 0.70 under 600 words / 0.90 whole; blocks short scripts only) and channel (0.50 / 0.75).
- **Type look** (`tools/world/type_look.py`): how a film sets its words (size, position, letter width, capitals,
  colour, glow, stacked lines) vs our earlier films; bar = the channel's own film-to-film spread (p05 1.906 over 30
  films). Caught MoviePass vs the Juicero rebuild (1.623); scene-sized checks proved unreliable, so it runs on the film.
- **Type check** (`tools/world/type_check.py`): boxed words, size spread, capitals vs the channel's band.
- **World check** (`tools/world/world_check.py`): line fit, word look and pictures vs our films (advisory).
- **Motion** (`tools/referee/motion3.py`, advisory): camera moves vs the channel (it pulls out as often as it pushes in).
- **Sound** (`tools/referee/motion_sound2.py`, Demucs voice/bed): used to set the mix levels.

## Repository
```
apps/cli/src/            CLI (index.ts), keys, publish.ts (packaging), referee/, audio-profile.ts, exemplars.ts
  film-agent/            run, story, plan, process, prefetch, tools (film-tools), checks, footage, scene-check, gate,
                         register, mix, sound-draft, after; template/ (each film's Remotion project)
  dev/                   offline tests and data builders (regressions.ts runs the suite); dev/hand/ = the tools
                         film-tools calls (watch, stock-look, stock-get, film-search) and text band builders
packages/contracts/      Zod schemas (FactSheet, ScriptDraft, TimedScript, Storyboard, FilmDesignSystem, …)
packages/agents/         llm.ts (models, budget), research, writer, voice director, story/structure/voice measures,
                         script referee, qa agent, packaging agent, publishing, fingerprint, lessons, skills/
packages/narration/      ElevenLabs takes, alignment, directed narration, names, pause refit, voice measure
packages/resolver/       press (YouTube news, screenshots, period/face checks), stock + archive adapters, thumbnail tools
packages/motion-engine/  remotion/craft.tsx (@craft), remotion/thumb/ (thumbnail), hand/render-film.ts, captions, watch
packages/senses/         ffmpeg helpers, eyes/ears, ASR, phonemes, cutout, OCR build, outside-failure pause/resume
packages/ingest/         Library indexer, reference status, style analysis, reference shot index
tools/                   Python/Swift measures: referee/, world/, siglip/, depth/, audio/, ocr/
data/                    generated data, bands, caches, agents' memories (rebuildable)
Library/  Reference/     read-only sources
```

## Commands
```bash
pnpm install
pnpm typecheck
pnpm opumia keys                          # names and sources only
pnpm opumia film-agent --topic "…" …      # a film (paid; owner approval first)
pnpm opumia index-library                 # → data/library-index.json (incremental)
pnpm opumia profile-audio                 # → data/audio-profile.json
pnpm opumia build-reference-index         # → data/reference-index/ (SigLIP, ~4 h)
pnpm opumia build-exemplars --channel magnates-media
npx tsx apps/cli/src/dev/regressions.ts   # the regression suite (offline, no API)
npx tsx apps/cli/src/dev/film-agent-test.ts
~/lechi_tts/venv/bin/python -I tools/world/type_look.py check <name> <film.mp4>
```
Python tools run with `~/lechi_tts/venv/bin/python -I` (or `OPUMIA_PY`), from the repository root.

## Library map (what the indexer understands)

| Folder | Contents | Metadata merged into `AssetRecord` |
| --- | --- | --- |
| `music/` | mp3 beds | `licenses.csv`, `<name>.json` (generation prompt, seconds) |
| `sfx/` | mp3 one-shots | `licenses.csv`, `catalogue.json` |
| `objects/` | png cut-outs (+ `_src` originals) | `licenses.csv` |
| `overlays/` | light leaks, dust, burns, smoke, paper, textures | `licenses.csv` |
| `cinematic/`, `era/` | mood and decade clips | `index.csv`, `restored/provenance.csv` |
| `footage/` | public-domain feature films + SigLIP shot index | `licenses.csv`, `meta/*.json`, `index/shots.jsonl` |
| `moments/` | the reference channels' technique clips — **never in a film** | `<channel>/index.json` |
| `icons/`, `maps/` | icons, geojson and relief | filename / — |
| `thumb_cache/`, `bank/` | thumbnail stills; a remote catalogue — **never in a film** | summarised only |

## Reference corpus
Six channels: `MagnatesMedia` (the style), `Logically Answered`, `Big Company`, `Modern MBA`, `How Money Works`, `Moon`.
Five share `<channel>/<YYYYMMDD - title>/` with `<ytid>.mp4`, `.info.json`, `pretrain.json` (words, shots, look),
`sound.json` (Demucs voice/bed) and `sheet.jpg`; Big Company uses `Videos/NN - title/`. `.analysis/` holds per-film
meta, story, motion, text and words (prefixes MM, LA, MBA, HMW, MOON). Done files (`done*.txt`) list analysed videos.

## Conventions
- Node ≥ 20, pnpm workspaces, ESM, TypeScript strict + `noUncheckedIndexedAccess`, run with `tsx`. Zod at every I/O
  boundary; every schema has a `schemaVersion`.
- **24 fps** everywhere; 16:9 = 1920×1080 (`film_16x9.mp4`), 9:16 = 1080×1920 (`film_9x16.mp4`), from `job.json`.
- Keep CLI output short; details go to files. Never print keys; never put user data in URLs.
- A change is kept only if the reference-calibrated measures say it helps; every defect a film shows becomes a case
  in `dev/regressions.ts`. Commit code and docs, not `data/` or `out/`.

## Limits (true today, 2026-11-28)
- **Cost and time are not low yet.** The last agent film (Juicero, 60 s) cost $14.43 and took 121 min; the target is
  ≈ $3 and 30 min. The default limit scales at today's rate (≈ $9 per 70 s) until cost work lands.
- **Not yet run on a real film:** the in-process story stage, 9:16, long films with chapters, registration, the
  cooldowns, licence checks and type look inside a production. Each needs a paid run.
- No agent film has passed the picture referee's 4.9 (agent Juicero 4.64); hand-built films with the same tools
  have (Juicero rebuild 5.05, MoviePass 4.96 — MoviePass used two unlicensed beds and copied Juicero's treatment).
- The picture referee judges stills against a family of dark documentaries, not fit to the line or motion; the
  motion measure is advisory; 9:16 has no channel band of its own (the reference is long-form 16:9).
- 71 of 127 Library music beds have no recorded licence and cannot be used.
