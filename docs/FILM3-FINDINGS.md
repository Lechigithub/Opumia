# Frozen film 3 — findings (tag `platform-frozen-bl3`, 2026-11-22)

Job `suite-kodak-a`: "How Kodak invented the digital camera and still went bankrupt", 90 s, 16:9, limit $9.
Run by `dev/topic-suite.ts --only 1`. Report: `out/reliability-platform-frozen-bl3.json`.

## Outcome

**The film did not finish.** It stopped in the preflight gate (B6) after 61 min with exit 1: "spend limit reached:
$9.04 of $9.00". Nothing was rendered, and no QA or package was made. Reliability: 0/1. The film needs a human (raise the
limit and resume), which breaks the "never stop" rule. The finished stages are cached.

## Where the money went ($9.04)

| Stage | s | $ | Budget |
| --- | ---: | ---: | ---: |
| A1 research | 112 | 0.37 | 0.60 |
| A2 script | 105 | 0.37 | 0.50 |
| A3 narration | 137 | 1.27 | 1.20 over (writer trim rung $0.60) |
| B1 director | 88 | 0.34 | 0.60 |
| B2 sourcing | 197 | 0.14 | 0.20 |
| B2d art director | 788 | 2.31 | 2.50 (Opus) |
| B3 scene designer | 383 | 0.57 | 0.90 |
| B4e/B4c/B5 | 107 | 0.21 | — |
| B5s showrunner | 979 | 1.45 | 0.60 over: 5 send-backs, two full scene-designer runs (26 shots) |
| B6 preflight | 713 | 1.92 | 1.20 over: $1.78 of it was a failed art-director redesign |

## Platform faults found (not fixed: the platform is frozen)

1. **The spend limit is still a hard stop.** The ladder skips a rung whose estimate does not fit, but the next rung
   (`unique_look` → "a new visual concept") was estimated as affordable with $1.85 left. It spent $1.78, failed to submit,
   and the scene designer that followed hit the limit mid-call. The film needs a reserve for render, QA and packaging
   that the ladders can't spend, and when that reserve is reached it needs a defined end state (ship with the issues
   logged), not an exit.
2. **Agent caps overshoot.** `maxUsd` is checked only between turns. The art director spent $1.78 against a $1.50 cap,
   and the scene designer $0.62 against $0.60. One Opus turn with renders costs about $0.3, which is more than the
   headroom that's left.
3. **`unique_look` escalated on a hair's-breadth miss** (0.043 against ≥ 0.046), and the closest film was our own earlier
   Kodak film on the same topic. The most expensive rung (an entirely new concept) was bought for a 0.003 gap.
4. **The showrunner is the most expensive reviewer:** $1.45 and 16 min. It sent the scene designer two full 26-shot
   re-designs, and the first was NOT accepted (cap hit, still `hard_to_read` / `below_channel_taste`). It also quoted
   6.34 hits/min where the sound designer measured 3.52, so two functions measure the same thing differently.
5. **The `repeat_in_film` rung did nothing:** "4 shot(s): 0 given new footage". The cheapest picture rung found no
   replacement for any of the four shots.
6. **`film_taste` sent 15 of 26 scenes back** in a single rung. That is a whole-film redesign at the price of a
   revision cap.
7. **A content bug survived every check:** the patent chart shows "$1,100" for 1,100 patents (a count formatted as
   money). The showrunner noticed it but sent the fix to the wrong shot id.

## What the frames show (`out/suite-kodak-a/preflight_look.jpg`)

- **Better than films 1–2:**
  - real period pictures (Sasson with the prototype, the Kodak works, Kodak Park, Kodak Tower);
  - the prototype camera as a real photo;
  - no slideshow of title cards.
- **Still slop-looking:**
  - The stage behind picture-less shots is lined with grey person and landscape **pictogram cards**, which read as empty
    placeholder slots. That kit decoration should never pass as design.
  - **Lone-word cards** over generic stock: "INVESTMENT", "MARKET" and "COMPETING" over money and circuit boards, and
    "EARNED FROM", a broken fragment.
  - A strong **red wash** on the film-reel shots, and a blue one on the factory.
  - Modern stand-ins: an open-plan office, and a young man in a turtleneck under the Kodak story.
  - The opening paperwork, gavel and money are generic stock.

## What worked

- The narration ladder fixed the length in two rungs (96 s → 85 s).
- The director, sourcing and the first scene pass ran cleanly.
- The showrunner's sound note raised the sound score from 84 to 99.
- Nothing paused: there were no outside failures, so part D was not exercised.

## Suggested fixes (for when the owner says "start fixing")

1. Ring-fence a downstream reserve (render + QA + package, about $1.5) that ladders can't touch. If the limit is
   reached, ship with unresolved problems logged, never exit 1.
2. Estimate each rung from measured spend per agent (the art director is about $1.8 on Opus) and check caps before each
   turn using the cost of the previous turn.
3. Add hysteresis to `unique_look` (escalate only past a margin) and don't compare a film against an earlier film on
   the same topic made by an older platform version.
4. Cap the showrunner's send-backs to the scene designer (one, limited to named shots) and make it use the same hit
   measure as the sound designer.
5. Make `film_taste` send back only the worst few scenes per round.
6. Make the `repeat_in_film` rung widen the search (its result shows it found nothing).
7. Make number parity reject a currency sign on a count. Ban pictogram placeholders and lone-word cards in the kit and
   scene checks.

Cost to continue this film as is: raise the limit (e.g. `OPUMIA_MAX_USD=12`) and run `pnpm opumia resume suite-kodak-a`.

## Resume at $12 (second run, same frozen tag)

**The film still did not render, and the resume spent $9.69 on its own: $18.73 in total.** The limit is applied per
run, not per film. `resume` starts its ledger at zero, so the $9.04 already spent did not count toward the $12.

- Preflight ran 6 rounds in 81 min and made 29 ladder attempts:
  - the art director 4× (~$1.5–1.8 each, **never accepted**);
  - the scene designer 5× (4 not accepted);
  - the picture researcher (period: 2 of 4 shots refilled).
- Every check was eventually cleared except **`unique_look`. It stayed at 0.043 (bar ≥ 0.046) in every round**, while
  four kit redesigns and five scene passes ran. The measure does not respond to what its owners change. The nearest film
  is our earlier `film1-kodak-3` on the same topic. Both use the same real Kodak pictures (Sasson, the prototype, Kodak
  Park, the tower), and the look measure is dominated by those pictures. On a same-topic film this check cannot be
  cleared by design.
- At the end of the ladder the gate refused the render. That is a stop (exit 1), the same failure the ladders were
  meant to remove.
- Advisory: 6.3 pauses ≥ 0.25 s per minute (narrator band ≤ 4.7).

### Faults added by the resume

8. **The spend limit is per process, not per film.** `resume` must carry the job's earlier spend
   (`usage.json` runs) into `setBudget`.
9. **`unique_look` can never pass on a same-topic film,** and its owners can't move it. Either measure it on what
   the platform designs (kit, grade, layout) excluding the shared real pictures, or compare only against films on other
   topics (the same-topic pair is judged by the suite's own same-topic test).
10. **An exhausted ladder still blocks the render.** After the last rung, the film should render with the problem
    logged (the "ship with issues" end state), never exit.
11. **Repeated, unaccepted art-director runs:** 4 × ~$1.6 for nothing. A rung that already failed once on a film
    should not be bought again.
