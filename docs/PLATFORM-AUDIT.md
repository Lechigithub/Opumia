# Platform readiness audit (2026-11-28)

Owner decision: the film agent (`opumia film-agent`) is the one production path. This audit read the code, the skills,
the agents' memory files, CLAUDE.md and Claude's memory. Nothing was changed. Every finding below was traced in code;
the key ones were re-checked by hand.

## 1. What the platform is today

- **Two production paths are live.** `produce` (old: research → script → narration → director → sourcing → art
  director → scene designer → editor → colourist → sound → showrunner → preflight → render → QA → packaging) and
  `film-agent` (planner → scene builders → render → finisher → fresh eyes → gate).
- **The film agent is not self-contained.** Its first step runs `produce --until narration` (`film-agent/run.ts:105`);
  produce.ts lines 1–374 (research, script, narration, budget, pause/resume) are live, lines 375–1319 are not.
- **Everything loads anyway.** `apps/cli/src/index.ts` imports produce, eval and exemplars statically and every package
  exports through `export *`, so starting the film agent loads every old module.
- **Fresh eyes still lean on the old system.** `after.ts` runs the viewer QA agent, the packaging agent (whose thumbnail
  renders through the old Remotion tree: `Documentary.tsx`, `scenes/*`, `thumb/*`) and an old final-cut judge (off by
  default; measured no better than chance).
- **The film agents never see CLAUDE.md or Claude's memory** (`settingSources: []`, `run.ts:146`). They see only their
  skills (`film-agent.md` + role file + TOOLS.md), the `CRAFT_TOOLS` list in `craft.tsx`, the last 40 lines of
  `data/agents/film-agent/magnates-media.md`, and (fresh eyes) `qa.md`, `packaging.md` and their memories. The writer,
  voice and research agents see their own skills and the last 20–30 lines of their memories.

## 2. Rules the live path does not enforce (82 rules mapped; the important gaps)

| Rule | Where it lives today | Live path |
|---|---|---|
| Zero template share, opening not like earlier films, plan fingerprint (colour, treatment, layout, story, words, sound) | `flow-measure.ts`, `fingerprint.ts` → produce preflight | **none** |
| Typeface never reused; colours ≥ 25° of hue from earlier films | produce art director | **none** (gate records fonts; nothing reads them) |
| Picture cooldown (last 12 films) | produce resolver | **none** |
| Music / effects cooldown | produce | draft only; data never written by the film agent |
| Finished films registered for later comparison (`produced.json`, `fingerprints.json`, `asset-usage.json`, `looks/`, `world-profile/films`) | produce | **only `film-kits.json`**; world check runs with `--no-save` |
| Voice: word error ≤ 1 %, unresolved words, pace in the voice's band ±12 % | produce preflight | **none** (retakes run, nothing blocks) |
| Voice chain and room tone | `motion-engine/audio.ts` | **missing from the film agent's `mix.ts`** |
| Library `moments/`, `bank/`, `thumb_cache/` and Reference/ never in a film | `library-menu.ts:isUsable` | **none** (a builder can cut from them with ffmpeg) |
| Music and effects credited | produce publish | **none** |
| Words held until read; cards in a row; picture-less share; real subjects ≥ half of named shots | produce preflight | **none** |
| Period footage, faces under named people, number parity | — | found on the finished film, **never blocks** |
| Type checks, fair-use share | — | **only on the finished film** (not at plan or scene time) |
| Spend limit by film length; time budget | `film-length.ts` | flat $9 whatever the length; no time budget |
| Pause/resume when a provider fails | `senses/outside.ts` | narration only; agent sessions end on error; no film-agent resume |

## 3. Instructions that mislead the live agents

**Push every film to one look (the MoviePass/Juicero cause):**
- `scene-builder.md:52-58` — words over footage always `GlowCaption` over `DarkPlate`; news always `RoomScreen`; photos
  and headlines always `PhotoPrint` / `PressHeadline`.
- `craft.tsx` defaults: GlowCaption's steel-blue glow, always capitals, size 180; DarkPlate dim 0.55 and a push-in;
  RoomScreen's warm glow and −14° tilt; PhotoPrint's cream border; "the channel's caption" described as THE caption.
- `film-agent.md:28-31`, `craft.tsx:530` — Wirecard's world and signature object as the worked example.
- `film-planner.md:30-31`, `film-solo.md:25-27` — the same component kit asked of every world.
- `film-agent.md:42-43`, `film-planner.md:50-52`, `scene-builder.md:33-44` — "lit low-key, under a big caption" as the
  default shot.

**Contradict current owner decisions:**
- `film-agent.md:46-47` — bed "ducked under lines" (decided 2026-11-27: no ducking; 17.3 / 20.6 dB, not 16 / 19).
- `film-agent.md:58-59` — claims the opening is "checked against our earlier films" (nothing checks it).
- `film-agent.md:8-9` — calls Wirecard v7.2 the best film (the Juicero rebuild scored higher).
- `film-finisher.md:34-35` and film-agent memory line 2 — add grain/texture (measured: lowers ours and the channel's).
- Film-agent memory lines 2 and 5 — count-ups and timers (now refused); "never a name over a stand-in" (2026-11-26
  allows it); `qa.md:9` flags a stranger under a named person as a defect (same conflict, in the viewer QA).
- `craft.tsx` LedBoard "a scoreboard" vs `film-agent.md:37` never a scoreboard; DarkPlate/RoomScreen/PhotoPrint push in
  by default vs `scene-builder.md:63-66` pull out as often as push in.
- Writer memory (lines shown to the writer): "repeat names", "add short sentences", "add connectives", "a question
  every ~120 words", "bar 0.9 on long scripts" — all contradicted by later measurements and `writer.md`.
- Voice memory: contradictory lessons on retakes (short vs long lines; plain vs emphasis retakes).
- `voice.md:26-44` and `produce.ts:342` reword lines and reroll takes, against the owner's 2026-11-24 voice scope
  ("only sound quality and the mix").

**Mislead Claude sessions only (CLAUDE.md and memory):** old fair-use limits in the hard-rule section (6.5 s, 45 %,
one clip per source), "music ducked ~8 dB", "designed share ≥ 70 %", "chapters 90–150 s", "never a stand-in face",
"Sonnet and Haiku only", the produce pipeline described as current (goal, pipeline diagram, stage tables, preflight,
ladders, sprint plan), `STAGE_BUDGET_USD` (no longer exists), owner-notes files (none exist), memory telling me to copy
the channel's typefaces (conflicts with originality) and a hand-film look prescribed in memory.

## 4. Old code (not used by the film agent)

About 10,800 lines of production code are used only by produce after narration or by eval (counted below), plus the
produce-only dev scripts and tests:
- `apps/cli/src`: preflight, ladders, bl5-checks, flow-checks, craft-report, slop, eval, film-kit, compare-ref, inspect,
  produce.ts lines 375–1319.
- `packages/agents/src`: director, director-agent, sourcing-agent, scene-agent, editor-agent, colourist-agent,
  sound-agent, sound-timeline, sound-design, music-edit, bed-level, showrunner-agent, cut-timeline, design-measure,
  flow-measure, visual-measure, film-score, eval-judge, uniqueness (and technique-grammar/-inventory, used only as types).
- `packages/resolver/src`: resolve, scene-tools, composite, local-search, props3d.
- `packages/motion-engine/src`: manifest, qa, preview, parity, map, motion (render.ts/audio.ts keep only what the
  thumbnail and viewer QA use).
- `packages/senses/src`: jumps, seams, legibility, synth, track.
- Skills: colourist, director, editor, film-designer, scenes, showrunner, sound, sourcing, worlds/.
- ~60 dev scripts and ~20 regression cases that test produce only; 72 of 76 files in `dev/hand/`; three Python tools
  referenced by nothing (`motion_sound.py`, `probe_frame.py`, `self_sameness.py`).
- **Cloudflare:** `apps/container/src/server.ts` runs produce stage by stage; the Worker/Workflow is built for produce.

**Pieces to move out before deleting:** `sameObject` / `GENERIC_OBJECTS` (gate) live in `film-designer-agent.ts`; the OCR
binary used by the film agent's checks is compiled only by `design-measure.ts`; `fingerprint`, `templateShare`,
`openingShare` and the cooldown writer are the code the new sameness checks should reuse.

## 5. Proposed plan (for approval; in this order)

1. **Instructions first** (no code risk): rewrite the film-agent skills and `craft.tsx` descriptions so no tool or
   example is a default look (craft tools take the film's colours and type as required inputs, no house defaults;
   camera direction explicit); fix every contradiction in section 3; prune the agents' memory files of lessons that
   contradict current decisions; fix Claude's memory files.
2. **One self-contained path:** move research, script and narration out of produce.ts into the film agent's own stage
   module; stop loading produce at startup; move the few shared functions (sameObject, OCR build) to small modules;
   give the packaging thumbnail its own small Remotion entry.
3. **Wire the missing rules, early:** sameness to earlier films at plan validation (fingerprint of plan + world: type,
   palette, caption treatment, devices by moment, opening, closing title — no closer to an earlier film than the
   channel's own films are to each other), picture and
   sound cooldown in the fetch tools, type check and fair-use share in the scene check, voice gates in the gate,
   voice chain + room tone in the mix, Library/Reference source block in the guard and gate, music credits, period and
   face findings blocking, budget scaled by length, registration of every finished film (hand films included), and
   9:16 and long-form support in the film agent.
4. **Delete the old code** of section 4 and its tests; rebuild `dev/regressions.ts` around the one path.
5. **Verify:** typecheck, regressions, `film-agent-test`, a `--dry-run`; then a no-API offline check that MoviePass is
   refused as too close to the Juicero rebuild.
6. **CLAUDE.md rewritten** as a short spec of the current platform; the history moves to `docs/HISTORY.md`.

## 6. Owner decisions (answered 2026-11-28)

1. **Voice:** the owner's only voice rule is natural pace. Takes, retakes for mispronounced words, processing and mix
   are engineering choices measured against the reference — kept where they help, never pushing pace.
2. **Cloudflare:** production speed decides. The container runs the old pipeline stage by stage and cannot run the film
   agent; it is retired with the old code. Cloud rendering returns only as part of the film agent, if it makes films
   faster.
3. **Delete** the old code, the old final-cut judge and the blind `eval`.
4. **Formats:** the platform makes both 16:9 and 9:16, at any length — the film agent must support both (a build item
   in step 3).
5. **Style:** match the reference 1:1, using everything it uses (its typefaces included). Originality between our films
   is measured against the channel's own film-to-film spread: we vary what the channel varies, as much as it does.
   The "never reuse a typeface" and fixed-hue rules are dropped; the sameness check compares with that spread.

### The questions as asked

1. **Voice scope:** the narration stage retakes lines and has the writer reword them; your 2026-11-24 note says voice
   work is sound quality and mix only. Keep retakes/rewording for mispronounced words, or remove them?
2. **Cloudflare:** retire the container/Workflow path now, or port it to the film agent later?
3. **Old final-cut judge and the blind `eval`** (measured no better than chance; the referees replaced them): delete?
4. **Formats:** the goal says long-form 8–30 min and 9:16 shorts; the film agent makes 16:9 only. Keep both formats as
   goals (to build into the film agent), or 16:9 first?
5. **Typefaces:** your 2026-11-24 note says copy the channel's typefaces; the originality rule says a typeface is never
   reused between our films. Which wins?
