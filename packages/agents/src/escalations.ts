import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { producedJobs } from "./produced.js";

/**
 * Learning from escalations (build list 3, item 30). Every ladder attempt of a film (out/<job>/ladders.jsonl) is
 * copied into the platform's log (data/escalations.jsonl) with its cause and cost. A check that ESCALATED (needed a
 * stronger rung than the first) in two or more different produced films is a recurring problem, and becomes:
 *  - a PLATFORM FIX to make: data/escalations-recurring.json (open until marked fixed; printed after every film and by
 *    `opumia escalations`);
 *  - a REGRESSION CASE to write: dev/regressions.ts lists every recurring check that has no case yet;
 *  - a LESSON for the agent whose first rung did not prevent it, written to its memory (data/agents/<agent>/<channel>.md)
 *    where it goes through the usual lesson trials (lessons.ts).
 */
export interface EscalationRow { job: string; channel: string; at: string; stage: string; check: string; rung: string; level: number; owner: string; shots: string[]; usd: number; seconds: number; note: string }
export interface Recurring { key: string; stage: string; check: string; films: string[]; firstOwner: string; rungs: string[]; usd: number; firstSeen: string; lastSeen: string; status: "open" | "fixed"; fixedAt?: string; lessonWritten?: boolean }

/** Owner (as the ladders name it) → the agent's memory folder under data/agents/. */
const AGENT_DIR: Record<string, string> = { "scene designer": "scenes", "picture researcher": "sourcing", director: "director", writer: "writer", "art director": "film-designer", colourist: "colourist", "sound designer": "sound", editor: "editor", "voice director": "voice", "packaging agent": "packaging" };

const readJsonl = async <T>(f: string): Promise<T[]> => readFile(f, "utf8").then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T), () => []);

/** Copy a finished job's ladder attempts into data/escalations.jsonl (idempotent per job). */
export async function recordEscalations(o: { data: string; jobDir: string; job: string; channel: string }): Promise<number> {
  const rows = (await readJsonl<{ kind: string; stage: string; at: string; check: string; rung: string; level: number; owner: string; shots: string[]; usd: number; seconds: number; note: string }>(path.join(o.jobDir, "ladders.jsonl"))).filter((r) => r.kind === "attempt");
  const file = path.join(o.data, "escalations.jsonl");
  const old = (await readJsonl<EscalationRow>(file)).filter((r) => r.job !== o.job);
  const add: EscalationRow[] = rows.map((r) => ({ job: o.job, channel: o.channel, at: r.at, stage: r.stage, check: r.check, rung: r.rung, level: r.level, owner: r.owner, shots: r.shots ?? [], usd: r.usd, seconds: r.seconds, note: (r.note ?? "").slice(0, 300) }));
  await mkdir(o.data, { recursive: true });
  await writeFile(`${file}.tmp`, [...old, ...add].map((r) => JSON.stringify(r)).join("\n") + (old.length + add.length ? "\n" : ""));
  await rename(`${file}.tmp`, file);
  return add.length;
}

/** Find the recurring escalations (produced films only), update the recurring list, and write lessons for new ones. */
export async function analyseEscalations(o: { data: string; channel: string; log?: (s: string) => void }): Promise<Recurring[]> {
  const made = await producedJobs(o.data);
  const rows = (await readJsonl<EscalationRow>(path.join(o.data, "escalations.jsonl"))).filter((r) => r.channel === o.channel && made.has(r.job));
  const byKey = new Map<string, EscalationRow[]>();
  for (const r of rows) (byKey.get(`${r.stage}|${r.check}`) ?? byKey.set(`${r.stage}|${r.check}`, []).get(`${r.stage}|${r.check}`)!).push(r);
  const file = path.join(o.data, "escalations-recurring.json");
  const list = await readFile(file, "utf8").then((t) => JSON.parse(t) as Recurring[], () => [] as Recurring[]);
  for (const [key, rs] of byKey) {
    const escalatedIn = [...new Set(rs.filter((r) => r.level >= 1).map((r) => r.job))];
    if (escalatedIn.length < 2) continue;
    const [stage, check] = key.split("|") as [string, string];
    const first = rs.filter((r) => r.level === 0).at(-1);
    const cur = list.find((x) => x.key === key);
    const rec: Recurring = { key, stage, check, films: escalatedIn, firstOwner: first?.owner ?? rs[0]!.owner, rungs: [...new Set(rs.map((r) => r.rung))], usd: Math.round(rs.reduce((t, r) => t + r.usd, 0) * 100) / 100, firstSeen: cur?.firstSeen ?? rs[0]!.at, lastSeen: rs.at(-1)!.at, status: cur?.status ?? "open", ...(cur?.fixedAt ? { fixedAt: cur.fixedAt } : {}), ...(cur?.lessonWritten ? { lessonWritten: true } : {}) };
    // a check marked fixed that escalates again in a film made after the fix is open again
    if (rec.status === "fixed" && rec.fixedAt && rs.some((r) => r.level >= 1 && r.at > rec.fixedAt!)) rec.status = "open";
    if (!rec.lessonWritten && AGENT_DIR[rec.firstOwner]) {
      const dir = path.join(o.data, "agents", AGENT_DIR[rec.firstOwner]!);
      await mkdir(dir, { recursive: true });
      const what = rs.filter((r) => r.level >= 1).slice(-3).map((r) => `"${r.rung}" (${r.note.slice(0, 80)})`).join("; ");
      await appendFile(path.join(dir, `${o.channel}.md`), `- LESSON (escalations): "${check}" at ${stage} kept going past your first fix in ${escalatedIn.length} films (${escalatedIn.join(", ")}); what it took: ${what}. Catch it in your own work before the gate does.\n`);
      rec.lessonWritten = true;
    }
    if (cur) Object.assign(cur, rec);
    else list.push(rec);
  }
  await mkdir(o.data, { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(list, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  const open = list.filter((x) => x.status === "open");
  if (open.length) o.log?.(`  escalations: ${open.length} recurring problem(s) need a platform fix — ${open.map((x) => `${x.check} at ${x.stage} (${x.films.length} films, $${x.usd})`).join("; ")} (data/escalations-recurring.json)`);
  return list;
}

/** Mark a recurring escalation fixed (after the platform fix and its regression case are in). */
export async function markEscalationFixed(data: string, key: string): Promise<boolean> {
  const file = path.join(data, "escalations-recurring.json");
  const list = await readFile(file, "utf8").then((t) => JSON.parse(t) as Recurring[], () => [] as Recurring[]);
  const r = list.find((x) => x.key === key);
  if (!r) return false;
  r.status = "fixed";
  r.fixedAt = new Date().toISOString();
  await writeFile(`${file}.tmp`, JSON.stringify(list, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  return true;
}
