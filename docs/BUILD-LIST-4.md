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
