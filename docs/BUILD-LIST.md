# Build list (owner go-ahead 2026-11-22)

Everything below is built before the next end-to-end film and before Cloudflare is run on a real account
(both deferred by the owner). Order of work: D and G23 first (most agents depend on them), then A → H.
Each item is committed and measured as it lands. Status: ☐ open · ◐ in progress · ☑ done.

## A. Orchestration
- ☑ A1 Showrunner agent: holds the film's central idea as a contract, reads every stage's report, sends work back.
- ◐ A2 Backward loops: scenes → writer (a line no picture can show), sound → narration/edit (held beat), packaging ↔ script.
- ☑ A3 Whole-film score (`film-score.ts`, `dev/film-score.ts`): our plan measured with the channel's own function, gaps named with their owner. Kodak 84, Theranos 77 (structure only until the taste model is trained).

## B. Agents
- ☑ B4 Editor agent (`editor-agent.ts`, skill `editor.md`, stage B4e in produce, `dev/editor-score.ts`): Kodak editor measures 68 → 83, film 80 → 85, 66 s, $0.07. Limit: designed stage shots cannot be split (no footage), so shot-length variety stays under the band.
- ☑ B5 Sound designer agent (`sound-agent.ts`, skill `sound.md`, stage B5 in produce, `dev/sound-score.ts`; `OPUMIA_SOUND=legacy` = timeline only): starts from the timeline kit, measures hits/min overall and by position, hits on cuts, hit mix, hits on text, drop-outs; studies real passages, listens, revises; the showrunner's sound send-back goes to it with a brief. Kodak: 98 → 98 (the timeline already sat in band), 18 placement changes, 57 s, $0.10.
- ☐ B6 Music editor (new): cut on phrases, endings that land, energy arc.
- ☐ B7 Voice director as an agent that hears its own takes.
- ☐ B8 Sourcing as an agent.
- ☐ B9 Colourist (new): grade per act, fixes tinted shots.
- ☐ B10 Final QA as an agent that watches the film like a viewer.

## C. Senses
- ☑ C11 `motion-engine/watch.ts:watchClip` (12 s clip in 30 s).
- ☑ C12 `watch.ts:listen` from stems (voice over bed, floor, hits on cuts, drops, gaps).

## D. Learning from the reference (including the style profile)
- ☑ D13 Full-reference embedding index (SigLIP 2 so400m, the Library's footage space): every reference shot and thumbnail.
- ☑ D14 Trained taste scorer (`agents/taste.ts`): two SigLIP heads per kind, grouped hold-out. Thumbs: AUC 0.93 (real 6.3 / ours 5.1 / degraded 3.1). Shots: AUC 0.89 (6.1 / 4.9 / 3.5). In the film score, packaging renders (`taste_far`). It does not separate the two owner-rejected films from our other old films (all ours 3.6–5.2): it measures distance to the reference, and our old jobs were training negatives.
- ☑ D15 Edit-rhythm library: cuts against words and music (`reference-library.ts:findPassages`, `edl`).
- ☑ D16 Sound against picture: hits, beds, drops and cues per shot in the index; `relations.hitOnScreen`, passages show them.
- ☑ D17 Colour grade per act: `grade.arc` and chapter-to-chapter shift in the channel profile.
- ☑ D18 Design fundamentals (`senses/design.ts`), two-sided band in `quality-profile`, checked on every thumbnail render. Kodak renders: 8 of 9 outside (sparse frame / pasted on a void).
- ☑ D35 One unified, versioned channel profile — every band in one place, all on the `senses` method, read by every agent.
- ☑ D36 Profile by position in the film: cold open, chapter openings, middle, turns, ending.
- ☑ D37 Relationship measures: line → picture, cut → word/beat, hit → visual event, music → story moment.
- ☑ D38 Variety range: look distance between and within films in every channel profile; ours measured in the film score (data/looks) and blocked in preflight (`unique_look`) when closer to an earlier film than two channel films usually are.
- ☑ D39 Real technique frequencies counted from every reference shot (the old profile's counts were example-clip counts).
- ☑ D40 Short-form: the reference has 1 film under 3 min and no real shorts — recorded in the profile; shorts follow the cold-open segment until real shorts are added (owner decision needed to source them).
- ☑ D41 Weighting by views: rank correlations, top-quartile band, permutation test (p < 0.05) — MagnatesMedia: only length goes with views beyond noise; Moon: less designed, more staged stock. A tie-breaker directive, not a target. Our own click-through: needs published films.
- ◐ D42 Other channels: unified profiles built for four (Big Company has no shot analysis); story/visual/thumbnail bands still MagnatesMedia only.
- ☑ D43 Profile version tied to evaluation: eval history, the lesson ledger and agent score histories record the channel-profile version; trends and lesson trials only compare runs on the same profile (a new profile is a new baseline).

## E. Craft written down
- ☐ E19 Fundamentals in every skill file: editing, design, sound, story arc (setups/payoffs).

## F. Memory
- ☑ F20 Lessons kept only if the agent's score improves.
- ☑ F21 Shared film-level memory every agent reads.
- ☑ F22 Cache of researched subjects across films.

## G. Tools and vocabulary
- ☐ G23 Real compositor: masks, light falling on subjects, clean edges, colour matching.
- ☐ G24 Scene vocabulary: icon infographics, picture counters, step flows, screen recordings, newspaper layouts.
- ☐ G25 Stronger footage-less shots.
- ☐ G26 Sharper sources only (thumbnails and footage).
- ☐ G27 Opus for ideas and critique (measured first).

## H. Known defects and limits
- ☐ H28 Description promises facts the narration never says.
- ☐ H29 Script states a motive as fact.
- ☐ H30 Research scores source quality.
- ☐ H31 Internet Archive moment finding (then join the pooled search).
- ☐ H32 ElevenLabs spend in the cost ledger.
- ☐ H33 Publishing package beside the render.
- ☐ H34 Remove `legacy` paths once each replacement is proven.
