// Build list 5, item 16: the Nokia proof film's placed pictures re-rated by MEANING with the resolver's own review.
// The idle stock the gap analysis named (an empty office, hands on a modern phone) must be labelled idle and must not
// pass on meaning; the story's own pictures (the Lumia box, the handshake on stage, Nokia phones) must be specific.
//   npx tsx apps/cli/src/dev/picture-meaning-test.ts [job]
import { readFileSync } from "node:fs";
import path from "node:path";
import { usageLedger } from "../../../../packages/agents/src/llm.js";
import { reviewFrame, reviewPictures } from "../../../../packages/resolver/src/press.js";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const job = path.join(process.cwd(), "out", process.argv[2] ?? "bl4c-nokia");
const res = JSON.parse(readFileSync(path.join(job, "resolution.json"), "utf8")) as { media: Array<{ shotId: string; role: string; kind: string; localPath: string; ref: string }> };
const sb = JSON.parse(readFileSync(path.join(job, "storyboard.json"), "utf8")) as { shots: Array<{ id: string; startS: number; endS: number; intent: string }> };
const ts = JSON.parse(readFileSync(path.join(job, "timed-script.json"), "utf8")) as { segments: Array<{ words: Array<{ word: string; startS: number }> }> };
const words = ts.segments.flatMap((s) => s.words);
const seen = new Set<string>();
const items: Array<{ shotId: string; frameFile: string; intent: string; line: string; era: string }> = [];
for (const m of res.media.filter((x) => x.role === "primary" && !/_\d$/.test(x.shotId))) {
  if (seen.has(m.localPath)) continue;
  seen.add(m.localPath);
  const sh = sb.shots.find((s) => s.id === m.shotId);
  if (!sh) continue;
  const frame = `${m.localPath}.meaning.jpg`;
  if (!(await reviewFrame(m.localPath, frame, m.kind === "video" ? 1 : 0))) continue;
  items.push({ shotId: m.shotId, frameFile: frame, intent: sh.intent, line: words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" "), era: "2007–2014" });
}
const r = await reviewPictures(items);
for (const [k, it] of items.entries()) console.log(`${it.shotId.padEnd(6)} meaning ${String(r[k]!.fit).padStart(2)}  ${r[k]!.idle ? "IDLE " : "     "}${r[k]!.specific ? "SPECIFIC " : "         "}${r[k]!.shows}  | "${it.line.slice(0, 70)}"`);
const fails: string[] = [];
const byShot = new Map(items.map((it, k) => [it.shotId, r[k]!]));
// the gap analysis: sh004 empty office, sh021 woman's hands on a phone — idle; sh017 Lumia box, sh014 stage — specific
// (an idle picture must not pass: it is labelled idle, or it fails the resolver's meaning bar of 6)
for (const id of ["sh004", "sh021", "sh005"]) if (byShot.get(id) && !byShot.get(id)!.idle && byShot.get(id)!.fit >= 6) fails.push(`${id} should be refused (idle stock or weak meaning)`);
for (const id of ["sh017", "sh014"]) if (byShot.get(id) && !byShot.get(id)!.specific) fails.push(`${id} should be story-specific`);
console.log(`$${usageLedger().reduce((t, x) => t + x.usd, 0).toFixed(4)}`);
console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "PASS meaning review");
process.exit(fails.length ? 1 : 0);
