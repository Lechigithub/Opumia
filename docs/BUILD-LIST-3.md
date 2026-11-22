# Build list 3: self-healing autonomy and the legacy cleanup (approved 2026-11-22)

Goal: an end-to-end autonomous platform that finishes every film itself, inside its budget and time, with no
mistake in the finished film. When something fails, it is sent to the agent that can fix it, which tries
progressively stronger fixes. The quality bar never drops: there is no fallback to the old template look, and the run
does not stop.

**Superseded:** "fail closed: if the new path can't do its job, the run stops and says why". A failure becomes a precise
problem sent to its owner, never a stop. A run only pauses for causes outside the platform, and resumes on its own.

Status: ☐ open · ◐ in progress · ☑ done. Nothing starts before the owner says "start fixing"; nothing is deleted before
the owner approves the inventory (item 1).

## A. Legacy cleanup (remove what the agents fell into)

1. ☑ **Inventory, shown to the owner for approval before anything is deleted.** For every old path: the switch that
   turns it on, what still calls it, and the finding it caused.
2. ☑ **The old menu art direction (stage A1b):**
   - its fixed lists of fonts, label styles, photo frames, backgrounds and particles;
   - its palette, act grades and treatments;
   - its "avoid recent habits" guard.
   The film's kit owns all of this.
3. ☑ **The shared design stages in the renderer:** the generic colour-world, surface, paper and split backgrounds,
   the particles, washes and treatment presets, and the menu font tokens.
4. ☑ **Generic text for scenes:** the text, phrase, label and 3D-type elements. Also the old preset cards: big word,
   quote card, name label, chapter roll, money figure, hero face, cut-out collage, screen mock, timeline, versus,
   document and chart presets, as far as the kit or data graphics cover them. Words go only through the film's kit.
5. ☑ **Old scene design:** the single-prompt scene designer, the separate critic pass, and the old "atmosphere" and
   "kinetic stamp" fill-ins.
6. ☑ **Degrading repairs:** `safe_scene`, `vary_stage`, `soften_wash`, `prune_shapes` as reductions, and
   `drop_picture` without a replacement. Every failed scene goes back to its owner (part B).
7. ☑ **The old voice path:** sentence-by-sentence takes, cutting inside lines, and pace measured on sentence takes.
8. ☑ **Old fallbacks:** the five-pass writer, the single-prompt thumbnail package, the old sound timeline as a
   separate path, the old picture rules that the picture researcher replaced, and `directStoryboard` as a separate
   path.
9. ☑ **Every `legacy` and `off` switch** that brings any of the above back, and the prompt text, skill text,
   CLAUDE.md lines and data files that refer to removed paths.
10. ☑ **Proof:**
    - typecheck;
    - the offline smoke renders (rewritten for kit-based scenes);
    - the regression suite;
    - a search showing nothing imports or mentions a removed path.
    Old test jobs in `out/` that used the menu renderer become history only.

## B. Self-healing: escalation ladders (a stronger fix each step, never a weaker look)

Done 2026-11-22 (CLAUDE.md, **Escalation ladders**). Deviations: "the director re-cuts the stretch" (16) is the editor's
second rung, re-cutting the stretch with split, join and move; the director has no stretch tool yet. Verified offline:
engine unit test, stretch re-render, pause refit on film 2's narration. Not yet exercised on a full film.

11. ☑ **A ladder engine:** each failed check becomes a precise problem (what, where, measured value, the band,
    evidence frames) sent to its owner. Each step is bounded in turns and dollars, the cheapest first, and every
    attempt is logged.
12. ☑ **Pictures:**
    - wrong period → search again with the line's year → a timeless close-up that tells the same line → a designed
      shot from the kit;
    - picture does not fit its line → a different picture → the director re-plans the shot → the writer rewrites the
      line so it can be shown;
    - stand-in face, repeat in the film, shared with a recent film, soft footage → replaced, not dropped.
13. ☑ **Scenes:**
    - below the channel's taste → variants → a different kind of shot from the kit → the art director adds a
      component the film was missing;
    - visible defect or unreadable text → the scene designer fixes it with the defect named → a different component.
14. ☑ **Look:** too close to an earlier film → the kit is redesigned against what made it close → a new visual
    concept for the film.
15. ☑ **Voice:**
    - narration too long or short → pauses adjusted inside silence → a sentence trimmed or extended in the script;
    - a seam, an unresolved word, or word error → a retake of that passage → a respelling → the writer rewords the
      line.
16. ☑ **Edit and sound:**
    - unbridged jump → bridge it with the film's transition → undo the split;
    - pace outside the band → the editor's own tools → the director re-cuts the stretch;
    - sound outside the band → the sound designer.
17. ☑ **After the render:** the final-cut judge's tells, the viewer QA's issues and failed QA checks go back to
    their owners, and only the affected shots are re-rendered (stretch rendering), not the whole film.
18. ☑ **Packaging:** a thumbnail outside the channel's band or below the critic's bar, or a package claim the film
    does not make → its own ladder (another concept, another picture, rewording).

## C. Prevention: the same measures run where the work is done

Done 2026-11-22 (CLAUDE.md, **Prevention**). Verified offline: 11/11 regressions, including new cases for cause stated as
fact (film 1's line), letters on a label box, and a jump under a busy card; the overlay rule found no false jumps on
four reference films. Not yet exercised on a full film. Not done: "melody varies less" is addressed by caching and seeds,
not measured across runs.

19. ☑ **Art director:** checks the kit's colours, type and look against earlier films while designing, and owns the
    palette, stages and grade. Its fonts load only the weights it uses.
20. ☑ **Scene designer:** can only build from the kit. Legibility, taste and likeness are measured on every render
    inside its loop, not only at the end.
21. ☑ **Sourcing and the picture researcher:** date every pick, check fit and soft footage, and screen out
    stand-in faces before placing anything.
22. ☑ **Writer:** cause-and-effect claims ("keeping it quiet caused the bankruptcy") are checked like motives.
    Length is fitted to the voice's measured passage pace.
23. ☑ **Voice:** each voice's natural pace and expressiveness are measured once in passage mode, so the script is
    cut to the real pace and the narration fits the first time. Melody varies less from run to run.
24. ☑ **Editor:** bridges every same-picture change while cutting. Match cuts and cutting on action, from motion
    analysis of the footage. Pace kept inside the channel's band through the gate's repairs.
25. ☑ **Detectors made complete:**
    - jumps behind heavy overlays;
    - legibility of text on drawn label boxes;
    - the scene critic and gate catching low-contrast labels.
26. ☑ **The final gate becomes a confirmation:** preflight runs the same measures the agents already passed, so it
    rarely fails.

## D. Pause and resume (failures outside the platform)

Done 2026-11-22 (CLAUDE.md, **Pause and resume**). Verified with simulated failures (12/12 regressions). Not yet seen
against a real usage limit or outage; the ASR stand-in and the cloud Workflow sleep are not exercised on real
backends. A process that dies mid-stage restarts that stage's agent.

27. ☑ **Checkpoint every stage** (already cached) and make every stage resumable from its last finished step.
28. ☑ **Outside failures recognised:** an API usage limit, an expired key, a provider rate limit or outage. The run
    pauses, records why, and resumes on its own when access returns: scheduled retries with backoff, and a resume
    after a limit's reset time.
29. ☑ **Provider switching where an alternative exists:**
    - stock sources take over for each other (Commons refusing, Europeana's rejected key);
    - local and cloud speech recognition stand in for each other.
    Failing providers are skipped for the rest of the run.

## E. Learning, speed and cost

30. ☐ **Every escalation is logged** with its cause and cost. Anything that escalates twice across films becomes a
    platform fix, a regression test and a lesson for that agent.
31. ☐ **Loop and budget control:**
    - cap the loops that rerun the scene designer;
    - stage budgets sized for agents;
    - the expensive art director bounded in turns;
    - the pre-render frame gate's unexplained cost removed or justified.
32. ☐ **Output size:** masters encoded at a sensible bitrate (film 1 was 155 MB for 88 s).
33. ☐ **The reliability target, measured on the topic suite:** at least 9 in 10 films finished on the first run with
    no human, inside budget and the time target, release gate passed; the rest finished after an automatic pause
    and resume. Also measured: the same topic twice must look different.

## F. Open findings from films 1 and 2 (each mapped to an item above)

- Film 1: stand-in actress under a named person (12, 21) · QA and preflight disagreeing on splits (17, already in
  preflight) · weak b-roll (12) · unreadable labels (13, 25) · pace just below the band (16, 24) · cause stated as
  fact (22) · thumbnail outside the band (18) · frame-gate cost and file size (31, 32) · source rate limits (29).
- Film 2: kit used in 1 of 27 scenes (4, 20) · the old art direction setting film 1's colours (2, 3, 19) ·
  narration rewritten twice (15, 23) · wrong-period and misfit pictures surviving (12, 21) · loop costs (31) · fonts
  loading every weight (19) · the account limit stopping the run (28).
