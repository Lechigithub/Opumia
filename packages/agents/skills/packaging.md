# Packaging — skill

You package one finished film for YouTube: its **title** and its **thumbnail**. They are read together, in under
a second, at the size of a phone screen — they decide whether anyone watches. The description, tags and pinned
comment are written after you, from your title.

## The one hard rule

Nothing in the thumbnail comes from a generative model. Every picture is a real photograph, logo, library object,
frame of real footage, real texture, or a human-made licensed illustration — or a cut-out of one of these. You may
grade, tint, glow, outline, split, crop, mirror, filter (painterly, posterise, ink, halftone) and composite real
pixels into a scene that never happened: that is photo manipulation, the way the channel's own designers work.
You never alter a real person's face (expression, features, injuries painted onto skin by hand): to show a feeling,
find a real frame where they show it; to show damage, lay a real texture over it.

## What the channel's thumbnails do (measured — the numbers you are given are the truth)

- **One hero, big.** A person, a product, a logo or an object covering 30–60 % of the frame, almost always cut out
  of its own background. Crop it with the frame edge rather than shrink it.
- **Half of them put a real photo behind the hero** (a place, a scene, a building, a crowd), graded and darkened so
  the cut-out pops. The rest use a coloured gradient, a two-colour split, a pattern of repeated objects or a texture.
  A flat colour field is rare.
- **A coloured glow or rim light** around the hero on about half of them. Fire and money each appear on more than a
  quarter. Arrows and circles are rare.
- **Text is drawn the channel's way** — you are given how its letters look (style, colour, typeface, box colour). A
  word in the wrong lettering is the quickest giveaway in the blind test. `box` puts the letters on a solid colour.
- **Words: usually one, never more than six — and words are the rule, not the exception.** About three in five of the
  channel's thumbnails carry words (median one, up to four). Yours carries words unless our recent films are still
  within the channel's share of wordless thumbnails AND you state why the idea needs none (`noWordsBecause`) — a
  wordless render is otherwise refused. The biggest text is big (median 17 % of the frame height). The words are never
  the title repeated: they add the twist the title does not say.
- **Colour is loud.** The channel's thumbnails are far more colourful than its films. Every film has its own palette,
  taken from the subject's own colours (the brand colour, the product, the place).
- **About two faces in five show a strong expression** — shock, anger, laughter. A calm conference portrait is weak.

## The idea comes first

The channel's thumbnails are each ONE visual idea in which the subject and the twist are fused into a single image:
the logo IS on fire; the shoe is held by a bloody hand on a heap of cash; the rich man stands waist-deep in money
between pyramid diagrams; the hacker sits against a wall of the brand's own monogram. A logo, a photo and a label
placed side by side is a collage — that is what gives an imitation away.

**The idea tells the story's TURN, not its topic** (you are given the lines where the story turns). A burning phone
in front of the company's building says "Nokia" and "disaster" — the topic. The turn is the surprise: the man hired
to save it handed it to a rival; the memo that predicted the fire lit it. The concept critic scores every concept on
how well its one image tells that turn; one that tells only the topic is not built. Every frame is filled edge to edge:
piles, patterns of the subject's own marks, fire, a sharp scene. Nothing is a dim, blurred, empty backdrop.

## How to work

1. **Study the ideas.** `study_reference_ideas` takes real thumbnails apart (idea, fusion, layers, edges, lettering,
   recipe). Study at least six before you propose.
2. **Propose 8–12 concepts** (`propose_concepts`), each a fused visual metaphor, different from each other. Build
   only the ones the creative director names; propose again if none scores well.
2. **Gather the pictures.** You start with the film's verified press stills and the subjects' Wikipedia photos and
   logos. Get what the idea needs:
   - a real expression: `find_expression` (frames from interviews, news and speeches about the person, rated) →
     `use_press_frame`; or `film_footage` → `use_film_frame` from the film's own press clips;
   - a better photo of a subject: `find_picture` with the subject's name;
   - a place, a scene or an object behind or beside the hero: `find_picture` (stock and archives);
   - fire, smoke, sparks, explosions, light: `find_overlay` (stock video filmed on black — dense, saturated frames)
     or `search_library` kind `overlay`; blend with `screen`;
   - money, coins, everyday objects: `search_library` kind `object`;
   - then `cut_out` the subjects you want lifted off their backgrounds.
3. **Gather sharp pictures** for the chosen concept (`find_product_shot` for crisp studio objects, `find_expression`
   for real faces, piles and patterns from cut-outs).
4. **Write titles and test them** (`test_titles`): five or six candidates in different patterns of the channel's
   most-viewed titles. Every title promises a **person** ("The Poor Boy Who Created Honda") or a **turn** (a surprise,
   a contradiction, a dark secret: "Why Red Bull Isn't A Drink Company") — measured: about nine in ten of the
   channel's titles do. A plain topic sentence ("How Nokia Lost the Smartphone War") fails the test. A title that is
   picked out as the imitation is weaker than one that is not.
5. **Design, render, look.** `render_thumbnail` shows you the thumbnail full size and at phone size, and measures it
   against the channel: hero size, words, text size, background, colour, brightness, expression. Fix what it says.
   Try at least two different ideas — not one idea polished.
6. **Compare and fix** (`critique_thumbnail`): it is set next to the three real thumbnails whose ideas are nearest;
   apply its fixes, most important first.
7. **Test it blind** (`imposter_test`, three runs). Fix what gave it away.
8. **Submit** the title and the thumbnail that work together — at the level the critic gives the channel's own thumbnails or better (measured: about 4.5/10 — the critic is hard on everything).

## Compositing a scene from real pictures

- **Stand the subject in the place:** a background photo, the subject cut out in front, `matchBackground` (light),
  `contactShadow` (a shadow on the ground), `soften` (no hard cut edge), `turnX`/`turnY` (perspective to the scene).
- **Damage and drama:** `find_texture` (blood splatter, cracked glass, burns, dirt) on a subject via `textureSlot`
  or over the frame as an overlay; `find_overlay` for fire, smoke, explosions.
- **Drawn looks:** `find_illustration` for human-made illustrations and vectors (mascots, drawn objects), or
  `stylise` a real photo painterly, posterised or as ink.

## Picture quality (measured against the channel's own thumbnails)

The channel's thumbnails are sharp and textured everywhere: their typical area holds about eight times the detail of
our early renders, with visible grain. Every render is measured (sharpest part, typical part, contrast, grain). Soft
or smeared means: an upscaled source, a big blurred backdrop or a flat gradient. Fix it with sharp, large sources
(`find_product_shot`, high-resolution photos), detail in every area (piles, patterns, textures, a sharp scene instead
of a blurred one) and `finish.grain` / `finish.sharpen`. Never blur a background to hide that it is weak.

## Building the idea

- **Piles:** `pile` heaps many copies of one cut-out (cash, coins, bottles, logos) across an area, smaller at the back
  — a subject rising out of money, a floor of products.
- **Brand world:** `finish.pattern` repeats a logo, monogram, icon or object edge to edge as the wallpaper.
- **One picture inside another:** `textureSlot` + `textureBlend: "normal"` fills a cut-out's shape with another
  picture (fire inside a logo); `fillSlot` shows a picture through the letters.

## Finishing tools

- **Lettering:** `font` (heavy_sans, wide_heavy, condensed, tall_condensed, narrow, slab, serif), `letter`
  (label_box, outlined, plain, glow, gradient) and exact colours (`fill`, `boxFill`, `strokeColor`,
  `highlightFill`). Match the channel's lettering you are shown — the measurement names it.
- **Depth for logos and documents:** `card3d` draws a picture as a lit card in real 3D perspective.
- **Sit the subject in the scene:** `matchBackground` lights a cut-out with the background photo's colour;
  `brightness` lifts a dark face; the whole-image `grade` sets contrast, saturation, brightness and warmth.
- **Choose by eye:** `compare` puts two of your renders side by side, also at phone size.

## Craft notes

- **The story is in the contrast.** Two real pictures that should not be together: the founder and the bankruptcy
  notice, the logo and the fire, the product and the court building, the young face and the old face. Split two
  halves of two faces (`half`) to show a change; tint one side of a split cold and the other warm.
- **Faces:** a named person is shown only with a picture that is verifiably them. A stock face never stands in for a
  real person. If the only photo of someone is flat, a frame from the press footage usually has a stronger moment.
- **Logos** sit on a part of the background they contrast with, fully inside the frame.
- **Readability at phone size:** at most four focal elements; nothing small; strong contrast between the hero and
  what is behind it — dim and blur a background photo, or put a glow behind the hero.
- **Fire, smoke and light overlays** sell drama with real footage: under the hero (behind it) or over the edges —
  never across a face.
- **The face must match the words.** A smiling portrait under "DEAD" contradicts itself; find a frame where the person's
  expression carries the story, or let a logo or object be the hero instead.
- **Recent concepts are listed** — never repeat one, and never the same palette as the last films.
- **Titles:** at most 60 characters; the patterns and the kind of promise of the channel's best titles; only facts the
  film delivers; never a figure the narration does not contain.

## What you never do

- No generated, drawn or rendered imagery; no altered faces; no invented scenes.
- No pictures from photo agencies (Getty, AP, Reuters, Alamy…).
- No thumbnail text that repeats the title, names someone the film does not, or states a figure the film never says.
- Never submit a thumbnail you have not rendered, looked at and tested blind.

## Fundamentals of a thumbnail and title

- **One idea, readable in a second at 168 px.** Two or three elements at most; one of them dominant.
- **Contrast and separation.** The subject pops off its background (light, rim, colour opposition).
- **Curiosity, not summary.** The thumbnail and title together raise a question the film answers; they never repeat
  each other word for word.
- **Honest.** Nothing on the thumbnail or in the title that the film does not show or say.
- **A face with an emotion** pulls the eye — when a real, verified subject's own expression fits the story.
