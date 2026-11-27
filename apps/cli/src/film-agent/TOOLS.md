# film-tools — your commands (run with Bash from the workspace)

Look at every image a command produces (Read the .jpg). Every command that brings in a picture records its source.
This is macOS: there is no `timeout` command (every film-tools command ends on its own).

## The reference (MagnatesMedia, read-only)
- `film-tools ref list` — the channel's films.
- `film-tools ref watch "<name part>" <fromS> <toS> [--fps 12]` — frame sheets (6 or 12 frames a second), spectrogram,
  every word with its time, hits and cuts. Watch openings (0–30 s) and middles.

- `film-tools ref similar "<a line of your narration>" [--n 6]` — the channel's real shots under lines nearest in meaning
  to yours: a sheet of frames and how each was built (picture, what was laid over it, motion, words). Start every scene
  here: build it the way the channel showed that kind of line, with this film's own material.
- `film-tools ref technique "<technique or words>"` — a technique's definition and real moments of it (sheets, and the
  `ref watch` command to see each one move). With no words: all 90 techniques the channel uses.
Eight of the channel's films are held back for the referee and never shown here.

## Your film
- `film-tools render [--stills 1.2,5.0,…] [--frames a-b]` — render `src/` (stills to `stills/`, or `picture.mp4`).
  A scene builder renders only its own scene (`--scene <id>` is implied): stills to `stills/<id>/`, or
  `scene_<id>.mp4`; times are always film seconds.
- `film-tools scene-check <id>` — the scene is built, compiles, uses only files that exist and are credited, and is
  not blank at its start, middle and end. Must print `SCENE <id> PASSED`.
- `film-tools mix` — sound from `mix.json` at the channel's levels, muxed with `picture.mp4` → `film_16x9.mp4`.
  `mix.json`: `{ "beds": [{ "file", "from", "to", "inS" }], "cues": [{ "t", "file", "db" }], "drops": [{ "from", "to" }] }`
- `film-tools beds` — music beds ranked by how like the channel's own beds they sound (pick past their quiet intros).
- `film-tools sfx [thud|sub_boom|impact|whoosh|riser|texture|shimmer]` — sound effects by family.
- `film-tools watch film_16x9.mp4 <fromS> <toS> --ref "<name part>" --ref-from <s>` — yours beside a real stretch.
- `film-tools type-check` / `film-tools world-check` — how words are set; line fit and sameness to our earlier films.
- `film-tools referee [film.mp4]` — the platform's judge of whether the film reads like the channel (proven on held-back
  channel films it never saw): a score per 8 s stretch, the weakest moments, and the film's score against the bar
  every channel film reaches. `film-tools referee --scene <id>` scores a scene's stills.
- `film-tools rank <clips/photos/folder> …` — the referee on candidate footage BEFORE you choose: each scored against
  the channel. Footage decides most of a scene's score (the same untouched frames ranged 2.4–6.2); choose among the
  pictures that show your line from the top of this list.
- `film-tools gate` — the hard rules. Must print GATE PASSED.

## Pictures
- `film-tools press "<query>" [--person "Full Name"] [--world "Company"] [--film] [--n 8]` — real news reports
  (broadcasters first) or, with `--film`, film/TV scenes; each hit gets a strip (tile i = second 2i) so you can SEE
  where the moment is.
- `film-tools clip <videoId> <startS> <lenS ≤ 8.5> <name> [--crop "crop=iw*0.8:ih*0.8:iw*0.1:0"] [--film]` — cut the
  moment you saw, 1080p, muted, 24 fps → `public/v/<name>.mp4`, logged as fair use.
- `film-tools screenshot <url> <name>` — a real article → `public/img/<name>.jpg` (crop the headline with ffmpeg).
- `film-tools commons "<query>" [--n 5]` — Wikimedia Commons photos with their licences → `public/img/`.
- `film-tools stock "<query>" ["<query>" …] [--image]` — Pexels/Pixabay candidates on sheets (4 per row; the .json
  beside each sheet gives the key at each position); then `film-tools stock-get <key> …` → `downloads/stock/`
  (look at each, then copy what fits into `public/v/` with ffmpeg: 1920×1080, 24 fps, keep the key in the name).
- `film-tools films "<what is seen>" [--n 12]` — public-domain feature films in the Library, ranked by meaning and taste.
- `film-tools cutout <in> <out.png>` — cut a subject out of a real photo (real pixels only).
- `film-tools depth <in> <out_depth.png>` — depth map for `@craft` DepthPlate (a still filmed in 3D).
- `film-tools credit <public file> <kind> "<source>" "<url>" [--license "…"]` — record a source you brought in by hand.

A scene builder works in its own scene's mode: what it brings in is named `<id>_…` and recorded in its own
ledgers, and the tools refuse a video moment, stock clip or Commons photo another scene already uses.

## Memory and money
- `film-tools lesson "<one lesson>"` — saved to your memory for every later film.
- `film-tools spend` — what the film has cost so far and its limit.

## Remotion (src/)
Solo: `src/Film.tsx` exports `FilmRoot` (1920×1080, 24 fps, length = the narration + a 2–3 s title). Parallel:
`src/world.tsx` (planner), `src/scenes/<id>.tsx` (builders: `export default` a component taking
`{ start, lead, length }`), `src/Film.tsx` generated from `plan.json`. Media from `public/`
with `staticFile("v/…")`. Shared techniques: `import { … } from "@craft"` (see the playbook). Fonts:
`import { loadFont } from "@remotion/google-fonts/<Font>"`. Render only through `film-tools render`.
