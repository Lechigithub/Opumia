# Build list 4 — a cheap, fast film that always finishes (2026-11-22; items 1–20 built, 22–23 to run)

Source: frozen film 3 (`docs/FILM3-FINDINGS.md`). Two runs cost $18.73 and took 2 h 22 min, and still nothing rendered.
Wait for the owner's "start fixing".

**Targets for a 90 s film:**
- **$3 or less.** A hard ceiling, counted across resumes.
- **30 min or less** from topic to the finished mp4.
- **It always renders.** Problems the ladders leave are logged and shipped, never a stop.

## A. Never stop, never overspend

1. ☑ The film's spend is counted across runs. `resume` carries `usage.json` into `setBudget`.
2. ☑ A downstream reserve (render, QA, packaging) that no ladder or agent can spend.
3. ☑ An exhausted ladder or the reserve line → render with the unresolved problems logged in `preflight.json` and
   `qa.json`. Exit 0, never 1.
4. ☑ Agent caps are checked before each turn, using the cost of the last turn, so a cap is never overshot.
5. ☑ Rung costs come from measured spend per agent. A rung that has already failed on this film is not bought again.
6. ☑ Stage budgets become hard caps (today they only print "OVER BUDGET").

## B. Checks that misfire or waste money

7. ☑ `unique_look` is measured on what the platform designs (kit, grade, layout, treatment) and excludes real pictures
   two films share. Same-topic films are judged by the suite's same-topic test. Escalate only past a margin.
8. ☑ `film_taste` sends back only the worst 3 scenes per round, never 15.
9. ☑ The showrunner sends at most one revision to the scene designer, for named shots only, and uses the same
   hit-rate measure as the sound designer.
10. ☑ Remove overlap: the scene designer's own measures, the showrunner, the critic and the preflight gate check the
    same things up to four times. Each check gets one place.
11. ☑ The `repeat_in_film` rung widens its search (it found 0 of 4).

## C. What the frames showed

12. ☑ Number parity: a currency sign on a count ("$1,100" patents) is refused.
13. ☑ Placeholder pictogram cards (grey person and landscape icons) are banned from kits and scenes.
14. ☑ Lone-word cards and broken fragments ("EARNED FROM") are refused. Words on screen must read as a phrase from
    the line.
15. ☑ Strong colour washes on footage (red reel, blue factory) are capped.
16. ☑ Modern stand-ins under period lines (open-plan office, turtleneck man): `periodCheck` on every placed shot.

## D. Speed and cost

17. ☑ **Sonnet and Haiku only, no Opus** (owner decision 2026-11-22). The art director moves to Sonnet (its only Opus
    use); `MODELS.opus`, `OPUMIA_DESIGN_MODEL` and `OPUMIA_CRAFT_MODEL=opus` are removed. Each stage then uses the
    cheapest of the two whose agent score holds: Haiku wherever it scores the same as Sonnet (Haiku is 20× cheaper).
    **Owner decision 2026-11-22 (revised): Sonnet for creative work, Haiku for the jobs it does well.**
    - **Sonnet:** the writer, the researcher's story planning, the director, the art director, the scene designer,
      the showrunner, packaging (thumbnail concepts and critique, titles), the voice director, and the judgements
      where a mistake ships: the period check and the final-cut judge.
    - **Haiku:** claim verification, query expansion and sourcing plans, first-pass picture rating (Sonnet decides
      only among the top few), labelling (shots, thumbnails, story lines), retrieval, caption, package and number
      checks, asset tagging, and the measure-driven agents: the editor, the colourist and the sound designer.
    - **Borderline, settled by score:** the editor, colourist, sound designer and QA viewer start on Haiku and go back
      to Sonnet only if their own score drops. Each role's model sits in one table in `llm.ts`.
18. ☑ Agents get tight turn and time limits (art director 13 min, showrunner 16 min, preflight 81 min seen) and stop
    after the first accepted result.
19. ◐ Previews are rendered once and shared (the gate renders only missing ones); the publishing package runs beside
    the render. Running more stages side by side is NOT done: the stage clock is serial (log headers).
20. ☑ Already in place: every agent conversation is cached turn to turn and skills are cached system blocks. Batch
    pricing is not used: every call is waited on.
21. ✗ Dropped (owner decision: stay on Claude). A provider layer: every model call goes through one interface, so a stage can be moved to another provider (for
    example DeepSeek) and measured with that agent's own score before switching.

## E. Proof

22. ☐ One fresh 90 s film from a new frozen tag: renders, QA, packaging. Check it against the targets.
23. ☐ Only then the 10-film suite.

## Found while proving build list 4 (to fix after the proof film; the platform is frozen during the run)

- A run that ends in an error never exits: the headless browser it opened for previews keeps the process alive
  (`bl4-theranos` sat idle 1 h 24 min after its error). Close the shared browser in `produce`'s `finally`.
- A ladder rung is skipped when its estimate exceeds what is left by a cent (writer trim: needs $0.60, $0.59 left) —
  narration kept 6 s long. Allow a rung when it fits within a small tolerance, or size the narration cap for one trim.
- The scene designer stopped at its 28-turn limit without the finishing go (only money and time caps give it).
- **Proof film `bl4b-theranos` (tag platform-frozen-bl4.1): it FINISHED** — rendered, QA verdict FAIL (exit 2), 56 min,
  $4.60 (target $3, limit $5). Art director on Sonnet: $0.38 / 4 min (film 3 on Opus: $2.31 / 13 min). Measured agents on
  Haiku: editor $0.01, colourist $0.004, sound $0.006. Found:
- No thumbnail: the package starts beside the render, and the render's stage header set the stage cap to C2's $0.05,
  so the packaging agent stopped at $0.05. Stage caps must belong to the work, not the last log header.
- Preflight ladders skipped every scene rung (estimates $0.40–0.50, $0.33 left in B6); scene_defects and film_taste
  shipped unresolved. The finished-film ladders then spent more (3 rounds, $0.57, 4 final-cut judges at ~$0.10 and
  2.5 min each — about 25 of the 56 min) and sent ~25 shots to the scene designer for `final_cut`. Cap C5 to one round,
  worst three shots, and judge once.
- Black / blank frames at 83.8–85.5 s and 11.5 s, a frozen stretch at 69 s: survived three C5 rounds (sh004 replaced,
  re-planned, then designed). Needs a cause found in the render, not another rung.
- The `chapters` check fired on a 95 s film (it treats anything over 90 s as long-form): use the requested duration.
- In the frames: a "Promised vs real" chart with one bar and a label cut off at the right edge ($100M vs $100,00…);
  a person-and-arrows icon over lab footage; generic stock (calculator and money twice, laptop typing twice).
  Better than film 3: Holmes portrait with the real Theranos machine, a Walgreens store, the CMS "Immediate jeopardy"
  document card, a quote card.

**Fixed after the proof film (tag platform-frozen-bl4.2):** packaging has its own $0.70 cap and render stages no cap;
a footage scene whose footage is gone goes back to the scene designer in the same round, and the render falls back to
the kit's stage (never black); rung estimates resized to Sonnet/Haiku costs, a one-cent tolerance, preflight cap $0.90;
one finished-film round, final-cut fixes on the worst three shots; the finishing go also at the turn limit; chapters
only past 150 s; every run closes its browser and exits; unreadable bar charts (one value under 2 % of another) are
refused; a lone icon over footage is flagged as a placeholder. Not covered by a regression yet: the black-frame
fallback (checked on the next film).
