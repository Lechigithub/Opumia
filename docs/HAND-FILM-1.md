# Hand film 1: FTX, made in the session with no Claude API call (2026-11-23/24)

Owner request: stop spending on the Claude API; prove in the session that a MagnatesMedia-style film can be made,
close every gap, then teach the agents. `OPUMIA_NO_CLAUDE=1` makes any platform Claude call throw
(`agents/llm.ts:client`). Spend: ElevenLabs only (≈ 5k characters including a 12-voice audition).

Film: `out/hand-ftx/film_16x9.mp4` (80 s, 16:9, 32 shots). Scripts: `apps/cli/src/dev/hand/`.
The owner judged pass 2 better than every agent-made film.

## Four passes, measured (local instruments only, first 80 s)
| | taste (real 6.1) | voice (real 0.91) | mix (real 0.84) | luma | dark share | colourfulness | motion | still share | cuts/min |
|---|---|---|---|---|---|---|---|---|---|
| MagnatesMedia, Ponzi 0–80 s | 7.4 | 0.85 | 0.85 | 0.34 | 0.13 | 47.8 | 0.05 | 0.08 | 37.5 |
| MagnatesMedia, Ponzi 420–500 s | 6.9 | 0.95 | 0.88 | 0.39 | 0.02 | 44.4 | 0.04 | 0.00 | 2.3 |
| hand v1 | 4.8 | 0.28 | 0.19 | 0.25 | 0.30 | 40.6 | 0.01 | 0.19 | 14.3 |
| hand v2 | 4.8 | 0.28 | 0.19 | 0.29 | 0.26 | 46.8 | 0.01 | 0.12 | 15.8 |
| hand v3 (mix + camera fixes) | 4.6 | 0.62 | 0.55 | 0.32 | 0.19 | 51.0 | 0.02 | 0.01 | 20.3 |
| **hand v4** (variety, atmospheres) | 4.8 | 0.62 | 0.55 | **0.34** | **0.12** | 50.6 | 0.03 | **0.01** | **20.3** |
| agent Quibi | 4.8 | 0.41 | 0.25 | 0.29 | 0.14 | 40.3 | 0.01 | 0.46 | 15.8 |

The channel's cut pace across whole films is 13–21 a minute. v4 is inside the channel's range on brightness, dark
share, still share and cut pace. It is near the range on motion (0.03 vs 0.04–0.05) and slightly over on colour.
Voice (0.62 vs 0.91) and mix (0.55 vs 0.84) are still short.

## Every gap found, its cause, and status
### Fixed in the engine (they hit every agent film too)
1. **The voice was mixed dry and the bed sat ~22 dB under it with almost no duck.** Ears: voice 0.28, mix 0.19.
   Two early reflections in the narrator chain (`audio.ts:VOICE_ROOM`) and a real duck (−14 dB, ratio 11.7) lifted
   the same narration to voice 0.62 and mix 0.55. The beds also have to sit louder: the hand film uses −9 dB, and
   the director's default should move to match.
2. **The atmosphere resolver screened clips filmed on white** (`grain_loop_on_white`), turning whole shots white.
   Those clips are now excluded (`resolve.ts`). Screened overlays get their lifted blacks crushed (`Media.tsx`).
3. **No money atmosphere.** The library's real "banknotes falling on black" clip is now `atmos: money`.
### Fixed in the hand film; the agents still make these mistakes
4. **Footage never moved when the storyboard camera was static.** The scene camera only moves layers, at 30 %.
   Every footage shot needs a real ken-burns move with a pan (motion 0.01 → 0.03; still share 0.19 → 0.01).
5. **Too dark.** Dimming footage 0.45–0.65 under type gave dark share 0.30. The channel never dims much: cap dim at 0.3.
6. **Documents and figures on a near-black stage** were the weakest frames (taste 3.3–3.9). Put them over real
   footage, defocused.
7. **One stock picture reused for five moments** (the red crash screen). Give each moment its own picture: a bank-run
   queue for "$6 billion out", piles of bills for "$14.6 billion", real coins for "40 % FTT".
8. **Long holds** (a document 5.6 s unchanged). Split them: card → punch-in on the highlighted line.
9. **Slow cold open.** Split shots so the opening cuts every 1.3–1.8 s.
10. **Type that lands then freezes.** Kit type keeps a slow push and float after landing.
### Not closed
11. **Voice (0.62 vs 0.91): the voice itself.** In an audition on the same line and in the same mix, Christopher
    scored 0.77 mixed (0.23 dry). Professional (human-recorded) voices on the account scored higher: Patrick 0.88,
    Marcus K 0.87 (0.64 dry, the most human dry), Jefferson 0.86, Atlas 0.85. Owner decision: "Christopher stays".
12. **Picture taste stuck at 4.8.** The score is √(looks professional × looks like this channel):
    - our frames score as professional as the channel's or more (0.5–0.9 vs 0.42–0.65);
    - the whole gap is "looks like MagnatesMedia" (ours 0.17–0.49 vs 0.83–0.89);
    - raw source clips already score 2.8–5.3 before any design, so the head mostly judges which footage is shown;
    - the channel's own corner logo is worth 0.6–1.0 points, and we leave it out on purpose;
    - by nearest neighbours, the hand film reads 37 % MagnatesMedia and 29 % Moon; the agent Quibi film reads 48 %
      MagnatesMedia.

    The owner ranks the hand film above Quibi, so **this instrument does not rank films the way the owner does**.
    It is not a valid target as built.
13. **Motion 0.03 vs 0.04–0.05.** The channel's frames are always moving: moving footage, parallax and constant
    layer motion. Ours still has stills (cut-outs, cards) between moving shots.
14. **Things the instruments cannot see:** whether the story grips, whether a joke lands, whether a cut is on the
    beat. No person has watched the film besides the owner, and the blind judge needs the API.

## Why the gaps were not all closed in the session
- The voice is an owner decision (Christopher), and no processing gets a dry TTS voice to a human score (best: room +
  mic chain + louder bed, 0.54–0.68).
- The picture-taste head measures channel identity (its logo, its footage) as much as craft, so making better frames
  does not move it. Optimising against it would mean copying the channel's footage and logo.
- My eyes are still frames and contact sheets, and I cannot hear. Sound and timing are judged only through
  instruments, which this test showed are partly wrong.
- Each render-and-measure round takes 5–6 minutes. Four rounds were run; motion and colour can still be improved.

## How to make the agents do this on their own (the plan)
1. **Instruments first.** Retrain the picture head so it measures design, not footage or the logo:
   - mask the logo corner on every real frame;
   - train on pairs of the same footage raw and designed;
   - validate against the owner's ranking (hand film > Quibi > WeWork > FTX short) before any agent is scored on it.

   Re-check the ears the same way.
2. **Move the measures into the doing.** The scene designer and editor see, per shot, as they work: dim, dark share,
   camera motion, hold length, repeated pictures, cut pace in the opening, and legibility of type over its backdrop.
   Each has a refusal in code, so it is prevented rather than found at the gate.
3. **Pictures chosen by looking at sheets.** The picture researcher sees 12–16 candidates per need on one contact
   sheet and picks with the line in view, as in the session. Each moment gets its own picture, never one stock shot
   for five moments. Press in-points are picked from the video's own thumbnail strip.
4. **The channel's grammar in the kit contract, not a template.** Spoken words land as huge condensed caps on their
   own word times; figures count; documents are taped real screenshots with a highlighter sweep, then a punch-in;
   type keeps moving after it lands. Each film's art director still chooses its own typefaces, palette and
   transition.
5. **Mix defaults** (done in the engine): voice room, real duck, beds at about −9 dB.
6. **Voice:** an ears-scored audition among the professional voices, at the owner's word.
7. **Proof:** one film through the agents with these changes (needs the API), scored on the corrected instruments
   and by the owner against this hand film.

## Ratchet: every level frozen, never lower (2026-11-24)
`apps/cli/src/dev/hand/ratchet.ts` keeps every measure of the frozen film in `eval/ratchet/hand-ftx.json`. A new
version is frozen only if no measure is worse (within noise) and one is better. Each frozen version keeps its film
and inputs in `out/hand-ftx/frozen/<tag>/` and has a git tag `ratchet/hand-ftx/<tag>`.

| frozen | what changed | voice (ch. 0.72–0.91) | mix (ch. 0.74–0.84) | luma | dark | colour (≤48) | motion (≥0.04) | still | cuts/min | clean shots (19–75 %) |
|---|---|---|---|---|---|---|---|---|---|---|
| v4 | baseline | 0.62 | 0.48 | 0.34 | 0.12 | 50.6 | 0.036 | 0.6 % | 20 | 12.5 % |
| v5 | narrator Marcus K (ears-chosen) | 0.83 | 0.77 | 0.34 | 0.11 | 50.9 | 0.037 | 0.3 % | 21 | |
| v6 | stronger camera, saturation, larger room | 0.85 | 0.77 | 0.34 | 0.12 | 49.0 | 0.039 | 0 | 21 | |
| v7 | quote on moving footage, cards keep moving | 0.85 | 0.77 | 0.36 | 0.09 | 47.0 | 0.042 | 0 | 21 | |
| v8 | two reflection sets on the narrator | 0.83 | **0.843** | 0.36 | 0.09 | 47.0 | 0.042 | 0 | 21 | 12.5 % |
| v9 | four more clean-footage shots | 0.83 | 0.843 | 0.36 | 0.10 | 46.6 | 0.042 | 0 | 21 | 25 % |
| **v10** | music no longer drowns the voice (below) | **0.805** | retired | **0.36** | **0.10** | **46.6** | **0.042** | **0** | **21** | **25 %** |

Rejected (no improvement): an earlier v10 candidate with re-tuned delivery settings (voice 0.82, mix 0.85: within noise).

### v10: the music overpowered the voice (owner, by ear, 2026-11-24)
- **Measured:** in v9 the voice sat 2.6 dB over the music while speaking; the channel's 37 films sit at 14.4–24.3 dB
  (median 18.1), with the music ducked a median 8.2 dB under speech.
- **Causes:**
  1. The engine did not level the narration. Marcus K arrives 10.7 dB quieter than Christopher, against music at a
     fixed level.
  2. The room reflections (`aecho` with gains 0.8/0.6) also cut the dry voice by about 14 dB.
  3. The music level was tuned on the mix ears, which scored the drowned mix 0.84 and the corrected one 0.58: they
     reward the defect.
- **Fixed in the engine (every film):**
  - every narration is levelled to −16 LUFS before the mix (`audio.ts:NARRATION_LUFS`, `narrationGainDb`);
  - the room stage is unity-gain, so it adds reflections without lowering the voice.
- **Fixed in the hand film:** music cues at −12/−13/−12 dB. The voice now sits 19.1 dB over the music while speaking.
  The owner confirmed by ear: "Sounds right".
- **In the ratchet:**
  - `voiceOverBed` is gated against the channel's 14.4–24.3 dB band;
  - `mix` is still recorded but retired from the gate.
- **Rule taken from this:** a measure that disagrees with the owner's ear or eye is retired, not obeyed. This is the
  second one, after the picture-style heads.

**Status at v10:**
- Every content-free measure is inside the channel's band, now including voice over music.
- Voice is inside the band (0.805 against a 0.72 floor), below the 0.91 median.

**What no instrument can settle yet:**
- Picture "style": the trained heads read content (period, subject, logo), not craft. They rank the hand film
  below agent films the owner judged worse, so they cannot be targets until they agree with the owner's ranking.
- Story, humour, cutting on the beat.

The judge for these is the owner, or a blind test that has been validated against the owner.
