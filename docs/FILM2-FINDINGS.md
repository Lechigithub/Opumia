# Film 2: frozen run on `platform-frozen-film2` (`out/film2-kodak/`)

**Stopped at the scene designer (stage B3): the Anthropic account reached its monthly API usage limit** ("You have
reached your specified API usage limits… until 2026-12-01"). This is a limit on the account, not a platform fault.
Every finished stage is cached: re-running the same command resumes at the scene designer, on the same frozen tag.

Spend before the stop: about $4.37 (research $0.32, script $0.30, narration $1.42, director $0.33, sourcing $0.19,
art director $1.80).

## What the run showed so far

1. **Uniqueness works where it matters most.** Same topic as the kit test, a completely different film:
   - kit test: slab type on oxblood, a 35mm gate and a light leak;
   - film 2: condensed Big Shoulders over Martian Mono, soot and taupe greys with a phosphor-green accent, every word
     written on screen by a scan bar, cassette-label tags, tape-counter figures in sensor brackets, a "readout"
     transition.
   The art director's concept: "the first digital picture, read out".
2. **The kit was cheaper the second time:** 12 turns and 22 renders ($1.34 for its agent, $1.80 for the stage)
   against about $9 in the kit test.
3. **Narration and the script disagree on pace (platform finding).** In passage mode the voice reads at about
   161 wpm, but the script is cut to the voice's measured 171 wpm (measured with sentence takes). The first narration
   ran 99.7 s against a window of 82–89 s, so the script was rewritten and narrated again ($1.42, over its $0.90
   budget). Fix after the film: measure each voice's natural pace in passage mode.
4. **Sources:** Commons refused 100 searches and Europeana returned nothing (rate limits, as on every run).
5. **Fonts:** the kit loads every weight of its fonts (27–32 font requests each per render). It works, but the
   kit's skill should tell it to load only the weights it uses.

## Resumed after the limit was raised: blocked at preflight, nothing rendered

Every stage ran on its own after the limit was raised. Preflight refused the render after 4 rounds:
`period_footage` (sh009), `scene_defects` (sh011), `unique_look`, `unique_plan`.
- Film score 84.
- The showrunner approved after sending the sound and scenes back.
- Spend: about $3.20 this run, about $7.60 for film 2 in all, with no film.

### What blocked it, and why (the main platform findings)

1. **The film's kit was barely used.** The art director designed a full kit ("the first digital picture, read
   out", 8 components). But the final scenes contain 1 kit component in 27 scenes. The scene designer built them
   from the old generic elements: 9 text, 4 phrase. Being told about the kit is not enough; the generic text
   elements stay available, and the agent reaches for them.
2. **The old menu art direction still sets the colours.** Stage A1b (the old art director) gave film 2 a palette
   almost identical to film 1's:
   - film 2: #d4141c / #ffc20e on #360e13;
   - film 1: #e8231a / #ffc10e on #39100d.
   Both are Kodak's brand red and yellow. It drives the washes, the stages and the grade, so film 2's scenes look
   like film 1's. The step-1 gates caught it: look distance 0.02 (the channel's films are never closer than 0.046),
   and colour similarity 0.96 (limit 0.7). The new uniqueness measurement works; the design side did not obey it.
3. **Narration pace mismatch, again:** 81.4 s against a window of 82–89 s, so it was rewritten and narrated a
   second time ($0.86 this run, $1.42 before). The script is cut to a pace measured on sentence takes; passage mode
   runs differently.
4. **Pictures:** a modern toaster under a 1975 line survived (period check), and a picture that does not fit its
   line survived (sh011).
5. **Cost:** loops rerun the scene designer. The showrunner's send-back and preflight's send-back to the owner each
   ran it again. Preflight alone cost $1.01 (budget $0.35); the showrunner $0.50.

### Fixes these point to (after this run)
- When a film has a kit, the scenes must be built from it. Generic text, phrases and labels are not available to
  the scene designer; words go through the kit's components.
- The kit owns the colours: the palette, stages and washes come from the kit (its art director already takes the
  palette from the film's pictures). The old menu art direction is removed when a kit exists.
- Measure each voice's natural pace in passage mode, and cut the script to that.
- Cap the loops that rerun the scene designer, and size their budgets.
