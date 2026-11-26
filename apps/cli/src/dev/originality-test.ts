// Originality safeguards (2026-11-26, owner: "if you create a new film from scratch the film becomes a new film of its
// kind … sharing only the style, skill, craft"), no API:
//  - a composite's @craft imports are read as that shot's devices;
//  - two openings built from the same channel techniques are caught; openings that share only footage are not;
//  - the signature object: the same thing named two ways is one object; a different thing is not; generic money
//    symbols are named as generic.
import { craftOfComposites, openingShare, objectWords, sameObject, GENERIC_OBJECTS } from "@opumia/agents";
let bad = 0;
const ok = (c: boolean, what: string) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) bad++; };

const craft = craftOfComposites({ Open: { shotId: "s1" }, Wall: { shotId: "s2" } }, { Open: 'import { GlitchIn, CameraPath } from "@craft";', Wall: 'import { ScreenWall as SW, rnd } from "@craft";' });
ok(JSON.stringify(craft) === JSON.stringify({ s1: ["GlitchIn"], s2: ["ScreenWall"] }), `composite devices read from @craft imports: ${JSON.stringify(craft)}`);

const plan = (shots: Array<[number, number, string, string[]]>) => ({ board: { shots: shots.map(([a, b], i) => ({ id: `s${i}`, startS: a, endS: b })) }, scenes: { scenes: shots.map(([, , w], i) => ({ shotId: `s${i}`, backdrop: w, elements: [] })) }, resolution: { media: [] }, craft: Object.fromEntries(shots.map(([, , , c], i) => [`s${i}`, c])) });
// openingShare compares against job folders; write the earlier film to a temp folder
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
const earlierDir = await mkdtemp(path.join(os.tmpdir(), "orig-"));
const earlier = plan([[0, 2, "footage", ["GlitchIn"]], [2, 6, "footage", []], [6, 12, "footage", ["ScreenWall"]], [12, 20, "footage", []]]);
await writeFile(path.join(earlierDir, "storyboard.json"), JSON.stringify(earlier.board)); await writeFile(path.join(earlierDir, "scenes.json"), JSON.stringify(earlier.scenes)); await writeFile(path.join(earlierDir, "resolution.json"), JSON.stringify(earlier.resolution));
await mkdir(path.join(earlierDir, "design", "film", "composites"), { recursive: true });
await writeFile(path.join(earlierDir, "design", "film", "composites.json"), JSON.stringify({ A: { shotId: "s0" }, B: { shotId: "s2" } }));
await writeFile(path.join(earlierDir, "design", "film", "composites", "A.tsx"), 'import { GlitchIn } from "@craft";'); await writeFile(path.join(earlierDir, "design", "film", "composites", "B.tsx"), 'import { ScreenWall } from "@craft";');
const same = await openingShare(plan([[0, 3, "footage", ["GlitchIn"]], [3, 9, "footage", ["ScreenWall"]], [9, 20, "footage", []]]) as never, [earlierDir]);
const own = await openingShare(plan([[0, 4, "footage", []], [4, 9, "footage", ["SignatureObject"]], [9, 20, "footage", ["PressHeadline"]]]) as never, [earlierDir]);
ok((same[0]?.shared.length ?? 0) >= 2 && (same[0]?.jaccard ?? 0) >= 0.5, `same techniques in the opening caught: ${JSON.stringify(same[0])}`);
ok((own[0]?.shared.length ?? 0) < 2, `an opening of its own passes: ${JSON.stringify(own[0])}`);

ok(sameObject("the card terminal: APPROVED, then DECLINED", "a payment card terminal on the counter"), "same object named two ways");
ok(!sameObject("the card terminal", "the wanted poster of its fugitive"), "different objects stay different");
ok(GENERIC_OBJECTS.some((g) => objectWords("a briefcase full of cash").includes(g)), "generic money symbols are recognised");
if (bad) process.exit(1);
