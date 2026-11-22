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
