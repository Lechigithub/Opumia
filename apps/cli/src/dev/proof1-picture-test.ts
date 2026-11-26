// Proof film 1's pictures (2026-11-26, Wirecard by the agents), no API: the gate run on that film's own saved plan
// must now catch what the owner was shown —
//  - strangers under lines naming Markus Braun and Jan Marsalek (stand_in_face; the rater had marked them face=false),
//  - seven designed shots back to back (cards_in_a_row),
//  - shots about named people and the company shown by stock (real_subjects);
// and the description check must not flag hands, silhouettes or money.
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { looksLikeAPerson, preflightChecks } from "../preflight.js";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) bad++; };
ok(looksLikeAPerson("Man in suit with lapel badge speaking at a podium to an audience with microphone"), "podium speaker is a person");
ok(looksLikeAPerson("Grey-haired man in suit pulling a suitcase along an airport corridor."), "man with suitcase is a person");
ok(!looksLikeAPerson("Close-up of a person's wrists in steel handcuffs against black background."), "handcuffed wrists are not a face");
ok(!looksLikeAPerson("Silhouette of a man standing in fog under street lamps"), "a silhouette is not a face");
ok(!looksLikeAPerson("Euro banknotes fanned on a table"), "money is not a person");

const job = path.join(process.cwd(), "out", "proof-wirecard-a");
if (!existsSync(path.join(job, "manifest.json"))) { console.log("skip: out/proof-wirecard-a not on this machine"); process.exit(bad ? 1 : 0); }
const rd = (f: string) => JSON.parse(readFileSync(path.join(job, f), "utf8"));
const checks = await preflightChecks({ jobDir: job, board: rd("storyboard.json"), scenes: rd("scenes.json"), resolution: rd("resolution.json"), manifest: rd("manifest.json"), timed: rd("timed-script.json"), exemplars: null, sceneDefects: new Map(), previewFrames: [], recent: { pictures: new Set(), sfx: new Set(), music: new Set() }, people: ["Markus Braun", "Jan Marsalek"] } as never).catch((e: Error) => { console.log(`gate error: ${e.message}`); return []; });
const get = (id: string) => checks.find((c) => c.id === id);
for (const id of ["stand_in_face", "cards_in_a_row", "real_subjects"]) { const c = get(id); console.log(`  ${id}: ${c ? `${c.pass ? "pass" : "FAIL"} value ${c.value} shots ${(c.shots ?? []).join(",")}` : "not run"}`); }
// the channel's practice (owner, 2026-11-26): a stranger may not stand in where the real person was found (Braun: a
// Bloomberg interview was in the pool); where nothing real of them was found (Marsalek, in this film's search), a
// performed reenactment is allowed — and real_subjects still sends those shots back to look for the real person.
const stand = get("stand_in_face")?.shots ?? [];
ok(get("stand_in_face")?.pass === false && stand.some((x) => x.startsWith("sh002")), "the stranger under Braun's line is caught (the real Braun was found)");
ok(!stand.some((x) => x.startsWith("sh012")), "the reenactment under Marsalek's line is allowed (nothing real of him was found)");
ok((get("real_subjects")?.shots ?? []).some((x) => x.startsWith("sh012")), "…and Marsalek's shots are still sent to look for the real person");
ok(get("cards_in_a_row")?.pass === false && Number(get("cards_in_a_row")!.value) >= 7, "the seven cards in a row are caught");
ok(get("real_subjects")?.pass === false, "named subjects shown by stock are caught");
if (bad) process.exit(1);
