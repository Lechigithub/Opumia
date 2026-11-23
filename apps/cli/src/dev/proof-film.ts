// Build list 5, item 34: is a produced film accepted as the proof? Every condition the owner set, read from the job:
//  - it finished with no human (one run, exit 0, no pause that needed a resume);
//  - inside cost and time (the length table's per-minute target), no stage over its share, no agent starved;
//  - every agent's craft score in the channel's band (craft.json);
//  - the final-cut judge picks it out no more often than it picks a real stretch (final-judge.json, its calibration);
//  - its taste at or above the channel's lowest tenth.
//   npx tsx apps/cli/src/dev/proof-film.ts out/<job>
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { lengthPlan, loadTaste } from "@opumia/agents";

export async function proofFilm(jobDir: string, data = path.join(process.cwd(), "data")): Promise<{ accepted: boolean; checks: Array<{ what: string; pass: boolean; detail: string }> }> {
  const read = <T>(f: string): T | null => (existsSync(path.join(jobDir, f)) ? (JSON.parse(readFileSync(path.join(jobDir, f), "utf8")) as T) : null);
  const job = read<{ durationS: number; channel: string }>("job.json");
  if (!job) throw new Error(`no job.json in ${jobDir}`);
  const plan = lengthPlan(job.durationS);
  const checks: Array<{ what: string; pass: boolean; detail: string }> = [];
  const add = (what: string, pass: boolean, detail: string) => checks.push({ what, pass, detail });

  const mp4 = readdirSync(jobDir).find((f) => /_(16x9|9x16)\.mp4$/.test(f));
  const timing = read<{ runs: Array<{ seconds: number; filmUsd?: number; overShare?: string[] }> }>("timing.json");
  const runs = timing?.runs ?? [];
  const pauses = existsSync(path.join(jobDir, "pauses.jsonl")) ? readFileSync(path.join(jobDir, "pauses.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
  add("finished with no human", Boolean(mp4) && runs.length === 1 && !existsSync(path.join(jobDir, "paused.json")), `${mp4 ? "film rendered" : "no film"}; ${runs.length} run(s); ${pauses} pause(s) (waits that resumed themselves are allowed)`);
  const usd = runs.at(-1)?.filmUsd ?? (read<{ runs: Array<{ usd: number }> }>("usage.json")?.runs ?? []).reduce((a, r) => a + r.usd, 0);
  const pausedS = existsSync(path.join(jobDir, "pauses.jsonl")) ? readFileSync(path.join(jobDir, "pauses.jsonl"), "utf8").split("\n").filter(Boolean).reduce((a, l) => a + ((JSON.parse(l) as { waitedS?: number }).waitedS ?? 0), 0) : 0;
  const minutes = (runs.reduce((a, r) => a + r.seconds, 0) - pausedS) / 60;
  add("inside cost", usd <= plan.targetUsd + 1e-6, `$${usd.toFixed(2)} against $${plan.targetUsd.toFixed(2)} for ${job.durationS} s`);
  add("inside time", minutes <= plan.targetMinutes, `${minutes.toFixed(1)} min against ${plan.targetMinutes} min (pauses excluded)`);
  const over = runs.flatMap((r) => r.overShare ?? []);
  add("no stage over its share", over.length === 0 && runs.some((r) => r.overShare !== undefined), over.length ? over.join(", ") : "every stage inside its share");
  const al = read<{ starved: number; agents: Array<{ stage: string; starved: boolean }> }>("allotments.json");
  add("no agent starved", Boolean(al) && al!.starved === 0, al ? `${al.starved} of ${al.agents.length} agent runs starved` : "no allotment log");

  const craft = read<{ scores: Array<{ craft: string; score: number }>; inBand: Record<string, boolean>; floors: Record<string, number | null> }>("craft.json");
  const outC = craft ? Object.entries(craft.inBand).filter(([, v]) => !v).map(([k]) => k) : ["(no craft.json)"];
  add("every craft in the channel's band", outC.length === 0, craft ? craft.scores.map((s) => `${s.craft} ${s.score}${craft.floors[s.craft] != null ? `/${craft.floors[s.craft]}` : ""}${craft.inBand[s.craft] ? "" : " ✗"}`).join(", ") : "not scored");

  const fj = read<{ clips: Array<{ picked: boolean }>; calibration: { realPickedAsImitation: number } | null }>("final-judge.json");
  const picked = fj ? fj.clips.filter((c) => c.picked).length / Math.max(1, fj.clips.length) : 1;
  const realRate = fj?.calibration?.realPickedAsImitation ?? 1 / 3;
  add("the final-cut judge cannot pick it out more than a real stretch", Boolean(fj) && picked <= realRate + 1e-6, fj ? `picked out ${Math.round(picked * 100)} % of stretches; a real stretch ${Math.round(realRate * 100)} %` : "not judged");

  const fs = read<{ taste: { median: number } | null }>("film-score.json");
  const tm = await loadTaste(data, job.channel as never, "shot").catch(() => null);
  const p10 = tm?.calibration.real.p10 ?? null;
  add("taste at or above the channel's lowest tenth", fs?.taste != null && p10 !== null && fs.taste.median >= p10, `${fs?.taste?.median ?? "?"} against ${p10 ?? "?"}`);
  return { accepted: checks.every((c) => c.pass), checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await proofFilm(path.resolve(process.argv[2] ?? "out/bl4c-nokia"));
  for (const c of r.checks) console.log(`${c.pass ? "✓" : "✗"} ${c.what}: ${c.detail}`);
  console.log(r.accepted ? "ACCEPTED as the proof film" : "NOT ACCEPTED");
  process.exit(r.accepted ? 0 : 1);
}
