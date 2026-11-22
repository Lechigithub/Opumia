/**
 * Which jobs are films. Memories of "recent films" (picture/sound cooldown, fingerprints, treatments, looks,
 * blueprints, thumbnail concepts, shared film memory) are written while a job is planned, so test plans and runs that
 * never rendered used to count as films (film 1, 2026-11-22: 43 % of its sound effects were "used by a recent film"
 * that was a test plan). A job becomes a film only when its final file is rendered: data/produced.json. Readers of
 * those memories keep only produced films; what test jobs wrote stays on disk for debugging and is ignored.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const file = (data: string) => path.join(data, "produced.json");

export async function producedJobs(data: string): Promise<Set<string>> {
  return readFile(file(data), "utf8").then((t) => new Set((JSON.parse(t) as Array<{ job: string }>).map((x) => x.job)), () => new Set<string>());
}

export async function markProduced(data: string, job: string, film: string): Promise<void> {
  const all = await readFile(file(data), "utf8").then((t) => JSON.parse(t) as Array<{ job: string; film: string; at: string }>, () => []);
  const next = [...all.filter((x) => x.job !== job), { job, film, at: new Date().toISOString() }];
  await mkdir(data, { recursive: true });
  await writeFile(`${file(data)}.tmp`, JSON.stringify(next, null, 1) + "\n");
  await rename(`${file(data)}.tmp`, file(data));
}
