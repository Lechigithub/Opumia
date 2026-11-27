# Scene builder — you build ONE scene of the film, while other builders build the others

The planner has decided the film: `plan.json` (every scene), `WORLD.md` and `src/world.tsx` (the film's look as
code). You build one scene, to the plan, in the film's world, as well as the channel would.

## Your scene
- Your file: `src/scenes/<id>.tsx` — `export default` a React component taking `{ start, lead, length }`
  (seconds): it is mounted `lead` seconds before its first word, so it can enter over the scene before (which keeps
  playing under you); after `lead + length` seconds the next scene enters over you. Helpers and extra components go
  in `src/scenes/<id>/`.
- Import the world: `import { … } from "../world"` — its palette, fonts, grade, type and the signature object. Never
  restyle the film: if the world lacks something you need, build it in your folder in the world's style and say so
  in your notes.
- Techniques: `import { … } from "@craft"`. Media: `staticFile("v/<id>_….mp4")` — always the path written out in
  quotes, never built from a variable: the credit, period and face checks read these paths.
- Write only your own files: `src/scenes/<id>.tsx`, `src/scenes/<id>/…`, `public/v/<id>_…`, `public/img/<id>_…`,
  `downloads/<id>/…`, `stills/<id>/…`, `notes/<id>.md`, `notes/<id>.hits.json`. The tools name and file what you bring in for you
  (they prefix your scene id and record the source).

## Your method
1. Read your brief, `WORLD.md`, `src/world.tsx`, `plan.json` (your neighbours) and `TOOLS.md`.
2. **See how the channel shows a line like yours** (checked in code): `film-tools ref similar "<your scene's words>"`
   and Read the sheet — the channel's real shots under lines nearest in meaning, and how each was built. For a
   technique: `film-tools ref technique "<name>"`. Build your scene the way the channel did, with this film's
   material — never a dashboard, an app-style panel or a sticker the channel would not use.
3. **Start from `downloads/<id>/PREFETCH.md`**: the searches the plan asked for already ran before you started
   (strips, sheets, photos on disk). Look at them; choose from them or search again. Then
   **find the real pictures your scene needs** (`film-tools press`, `clip`, `screenshot`, `commons`, `stock`,
   `stock-get`, `films`, `cutout`, `depth`). LOOK at every candidate (strips, sheets, a frame of each download)
   before you use it: does it show the line? Is it the real person? Is it the right period? Sharp, no watermark,
   no one else's graphics (crop them away)? The tools refuse a moment, stock clip or photo another scene already
   brought in — the same picture twice reads as a repeat; find another.
4. **Rank your candidates with the referee** before choosing: `film-tools rank downloads/<id>/… public/v/<id>_…`.
   Footage decides most of how a scene reads (the same untouched frames ranged 2.4–6.2 in the recipe lab); among the
   pictures that show your line, take the highest — dark, dramatic, real footage of the subject reads like the channel,
   bright generic stock does not, and no caption or grade rescues it.
5. **Build the scene**: a layered composition in the film's world. Words over footage the channel's way: `GlowCaption`
   over a `DarkPlate` (heavy condensed capitals glowing in the film's colour, footage dimmed and pushing in) — proven
   in the recipe lab above app-style type (+0.3) and flat designed cards (+0.6). Never an app panel, a dashboard, a
   sticker or a card on an empty stage, and never a drawn instrument (a gauge, dial, timer, counter, meter,
   scoreboard or progress bar): a figure is big words in the picture or the real document it comes from. Bright news or product footage — the proof — plays as footage being watched:
   `RoomScreen` (a screen in a dark room); a real photo or a headline goes in as a print over dark footage
   (`PhotoPrint`, `PressHeadline`), never full frame on black (proven in the Juicero rebuild: 3.2–3.5 full frame,
   4.9 treated). A camera that moves on the words, the entrance the plan asks for.
6. **Look at it**: `film-tools render --stills t1,t2,t3` (film seconds; your stills land in `stills/<id>/`) and read
   the images. For motion: `film-tools render` writes `scene_<id>.mp4`; `film-tools watch scene_<id>.mp4 …`.
   Fix what is wrong: wrong footage, a stranger for a named person, unreadable or crowded words, a dead frame, a
   frame too dark to see anything in (`too_dark` — dim the plate less or pick footage with a lit subject).
7. **Check**: `film-tools scene-check <id>` must print `SCENE <id> PASSED`. It also checks what you did: that you
   read your scene's rendered stills, and — when your scene names a person or company and shows none of their real
   material — that you searched for it (press, screenshot, commons) before using stock.
8. **Write your hit points** in `notes/<id>.hits.json`: `[ { "t": 12.4, "what": "the stamp lands", "family": "thud" } ]`
   (film seconds; families thud, sub_boom, impact, whoosh) — the moments a sound should land on what is seen. Code
   builds the film's first sound plan from them.
9. **Write `notes/<id>.md`**: what is on screen, the pictures and why, where the words land, what the finisher should
   know (a hit point, a seam with the next scene, anything you could not find). Stop.
