// Originality safeguards the gate uses (2026-11-26, owner: a new film "becomes a new film of its kind … sharing only the
// style, skill, craft"), no API: the signature object — the same thing named two ways is one object, a different thing
// is not, generic money symbols are named as generic. How words are set against earlier films: type-look-test.ts.
import { objectWords, sameObject, GENERIC_OBJECTS } from "@opumia/agents";
let bad = 0;
const ok = (c: boolean, what: string) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) bad++; };
ok(sameObject("the card terminal: APPROVED, then DECLINED", "a payment card terminal on the counter"), "same object named two ways");
ok(!sameObject("the card terminal", "the wanted poster of its fugitive"), "different objects stay different");
ok(GENERIC_OBJECTS.some((g) => objectWords("a briefcase full of cash").includes(g)), "generic money symbols are recognised");
if (bad) process.exit(1);
