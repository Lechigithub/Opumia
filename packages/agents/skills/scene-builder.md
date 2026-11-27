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
   brought in — the same picture twice reads as a repeat; find another. When you search stock or films:
   the channel's most common shot is a person performing or reacting to the line, lit low-key, under a
   big caption — search for people doing THIS line ("man counting money desk lamp" for "$120 million from
   backers", "man staring at machine dark room" for "what was the machine for?", "man pitching on stage dark
   audience" for a sales claim). Measured on Juicero: such searches found 7 of 155 candidates at the channel's level,
   objects and places ("sports car night garage", "boardroom") 1 of 157, moods ("dark moody light bulb") dark
   pictures that fit no line. Objects and places second; moods only as backgrounds.
   `film-tools ref similar` matches by meaning only roughly (it matched "force to lift two Teslas" to a man named
   Frick being "a force"): take from it what KIND of shot the channel uses, not its words.
4. **Rank your candidates with the referee** before choosing: `film-tools rank downloads/<id>/… public/v/<id>_…`.
   Footage decides most of how a scene reads (the same untouched frames ranged 2.4–6.2 in the recipe lab); among the
   pictures that show your line, take the highest — dark, dramatic, real footage of the subject reads like the channel,
   bright generic stock does not, and no caption or grade rescues it. The scene check holds you to it (agent Juicero:
   builders placed footage a full point weaker than what they had already found):
   - `best_footage`: a candidate in your own downloads that ranks ≥ 0.8 above what you placed must be used, or
     answered in `notes/<id>.md` as `not used: <name> — <why it does not show the line>` (the referee rewards dark
     cinematic pictures whatever they show — a clown mask is not your line).
   - `searched_enough`: footage below the channel's weakest moments needs at least three different searches first.
     For an abstract line ("what was the machine for?"), search for what the channel showed under lines like it
     (`film-tools ref similar`), not for the words.
5. **Build the scene**: a layered composition in the film's world. Words over footage the channel's way: `GlowCaption`
   over a `DarkPlate` (heavy condensed capitals glowing in the film's colour, footage dimmed and pushing in) — proven
   in the recipe lab above app-style type (+0.3) and flat designed cards (+0.6). Never an app panel, a dashboard, a
   sticker or a card on an empty stage, and never a drawn instrument (a gauge, dial, timer, counter, meter,
   scoreboard or progress bar): a figure is big words in the picture or the real document it comes from. Bright news or product footage — the proof — plays as footage being watched:
   `RoomScreen` (a screen in a dark room); a real photo or a headline goes in as a print over dark footage
   (`PhotoPrint`, `PressHeadline`), never full frame on black (proven in the Juicero rebuild: 3.2–3.5 full frame,
   4.9 treated). A camera that moves on the words, the entrance the plan asks for. Let the footage show: the check
   `footage_shows` fails a scene that scores ≥ 0.6 below its own footage (a 130 % zoom into the dark, a card over
   most of the frame, a heavy filter). A news clip with a broadcaster's caption or logo burned in must have it framed
   out (`RoomScreen crop={1.35} focus="50% 0%"`, or a tighter crop) — `burned_in_text` reads the stills.
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
