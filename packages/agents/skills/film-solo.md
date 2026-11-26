# Solo film agent — you do every role yourself

## The method (in this order)
1. **Watch the reference first.** `film-tools ref list`, then watch two or three openings and one middle stretch of
   real MagnatesMedia films (`film-tools ref watch …`). Write down how scenes enter, move and hand over, how words
   sit in the picture, how long a scene holds, where the sound hits.
2. **Write SCENES.md: a scene per idea, against the word times.** Not a picture per sentence. For a 60–90 s film,
   about 10–16 scenes; an idea that spans clauses is one scene of 5–8 s that grows (a layer added on the voice, a
   pull-back, a push into a screen). For every scene: the words and times, what is SEEN (real subject first), the
   camera path, the words on screen (if any), how it enters, the sound. Name the film's world (grade, type, texture)
   and its signature object (below).
3. **Find the real pictures.** In this order:
   - real news of the real people, company and places: `film-tools press "…"` (broadcasters and wire services first;
     their reports hold HQ exteriors, exchange floors, AGM stages, arrests, share charts), then
     `film-tools clip` the moment you SAW in the strip (never a fixed point);
   - real articles that prove a line: `film-tools screenshot <url>` (a real headline, marked);
   - the subject's own talks and interviews; Wikipedia/Commons photos (`film-tools commons "…"`);
   - performed footage for what was never filmed: `film-tools stock "query"` (look at the sheet, pick by position,
     then CHECK each downloaded clip by eye — ids and positions have been wrong before), public-domain films
     (`film-tools films "…"`), film and TV scenes as metaphor (`film-tools press "… movie scene" --film`).
   - 1080p or better; nothing soft, watermarked, or with someone else's graphics burned in (crop them away).
4. **Build the scenes in `src/Film.tsx`.** Each scene a layered composition in the film's world: real footage graded
   into one look; words set INTO the picture (huge for figures and turns, small mono lines for places and names);
   a camera that moves on the words; hand-overs by moving (push through, whip, flash, fade, a match), few hard cuts.
   Use `@craft` (CameraPath, Parallax, DepthPlate, BuildWords, GlitchIn, PressHeadline, SignatureObject,
   TravellingFigure, ScreenWall, LedBoard, PinnedPrint, LightSweep, PlaceLine, GradedPlate, ZoomThrough, FlashCut,
   Whip…) with THIS film's colours and type. Keep words above the grade.
5. **Look at every scene before the film.** `film-tools render --stills t1,t2,…` and read the images. Fix what is
   wrong: wrong footage, a face that is not the person, unreadable words, words covering the subject, dead frames.
6. **Render, then watch it beside the reference.** `film-tools render`, `film-tools mix`, then
   `film-tools watch film_16x9.mp4 0 20 --ref <film> <from>` (12 frames a second, words, hits, cuts). Ask: does it
   look and feel like the channel here? If not, why not — then fix the cause.
7. **Measure, then gate.** `film-tools type-check`, `film-tools world-check`, `film-tools gate`. The gate must pass.
8. **Review and learn.** Write REVIEW.md (what worked, what failed, the root cause, what you would do first next
   time), and add 1–3 lessons to your memory with `film-tools lesson "…"`.

