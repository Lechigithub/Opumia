/**
 * Agent memory that earns its place (build list F20, F21).
 *
 * F20 — lessons are kept only if films get better. Every agent writes lessons to <memoryDir>/<channel>.md
 * ("- LESSON (film): text"). Each lesson is put on probation with the score of the film that taught it; every later
 * film the agent works on is a trial (the whole-film score, film-score.ts). After two trials a lesson is kept if the
 * films it was shown to scored at least as well as the film that taught it, and dropped if they scored clearly worse
 * (3+ points below). Dropped lessons are no longer shown to the agent. State: <memoryDir>/<channel>.lessons.json.
 * Honest limit: a film's score has many causes, so this is a coarse filter against lessons that go with worse films,
 * not proof that a lesson works.
 *
 * F21 — a shared film memory every agent reads: data/films/<channel>.jsonl, one line per planned film (title, central
 * idea, whole-film score, the showrunner's summary, what stayed below the channel). `readMemory` returns an agent's
 * own lessons (filtered) and its log, plus the last films' memory.
 */
import { producedJobs } from "./produced.js";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface LessonState { text: string; film: string; introducedScore: number | null; /** D43: scores are only compared on one channel-profile version */ profileVersion?: string; trials: Array<{ film: string; score: number }>; status: "probation" | "kept" | "dropped" }
type Ledger = Record<string, LessonState>;

const keyOf = (t: string) => createHash("sha1").update(t.trim().toLowerCase()).digest("hex").slice(0, 12);
const LESSON = /^- LESSON \((.*?)\): (.*)$/;

async function ledgerOf(memoryDir: string, channel: string): Promise<Ledger> {
  return readFile(path.join(memoryDir, `${channel}.lessons.json`), "utf8").then((t) => JSON.parse(t) as Ledger, () => ({}));
}
async function saveLedger(memoryDir: string, channel: string, l: Ledger) {
  const f = path.join(memoryDir, `${channel}.lessons.json`);
  await writeFile(`${f}.tmp`, JSON.stringify(l, null, 1) + "\n");
  await rename(`${f}.tmp`, f);
}

/** The agent's memory as shown in its prompt: its log and lessons that are not dropped (probation ones marked), then the shared film memory. */
export async function readMemory(memoryDir: string, channel: string, o: { lines?: number; data?: string } = {}): Promise<string> {
  const md = await readFile(path.join(memoryDir, `${channel}.md`), "utf8").catch(() => "");
  const ledger = await ledgerOf(memoryDir, channel);
  const lines = md.split(/\r?\n/).filter((l) => l.trim()).flatMap((l) => {
    const m = LESSON.exec(l);
    if (!m) return [l];
    const st = ledger[keyOf(m[2]!)];
    if (st?.status === "dropped") return [];
    return [st?.status === "kept" ? `${l} [kept: films improved]` : l];
  });
  const own = lines.slice(-(o.lines ?? 30)).join("\n");
  const shared = o.data ? await recentFilmsText(o.data, channel, 5) : "";
  return [own, shared ? `\n## Our recent films (shared memory)\n${shared}` : ""].filter(Boolean).join("\n");
}

/** After a film is planned: every lesson shown to this film gets a trial; lessons this film taught start on probation. */
export async function judgeLessons(o: { data: string; channel: string; film: string; score: number; profileVersion?: string; agents?: string[] }): Promise<Array<{ agent: string; kept: number; dropped: number; probation: number }>> {
  const root = path.join(o.data, "agents");
  const agents = o.agents ?? (await readdir(root).catch(() => [] as string[]));
  const out: Array<{ agent: string; kept: number; dropped: number; probation: number }> = [];
  for (const a of agents) {
    const dir = path.join(root, a);
    const md = await readFile(path.join(dir, `${o.channel}.md`), "utf8").catch(() => null);
    if (md === null) continue;
    const l = await ledgerOf(dir, o.channel);
    for (const line of md.split(/\r?\n/)) {
      const m = LESSON.exec(line);
      if (!m) continue;
      const k = keyOf(m[2]!);
      const st = l[k] ?? (l[k] = { text: m[2]!.slice(0, 300), film: m[1]!, introducedScore: null, trials: [], status: "probation" });
      if (o.profileVersion && st.profileVersion && st.profileVersion !== o.profileVersion && st.status === "probation") {
        // the measure changed under the lesson: start its trial again on the new profile
        st.introducedScore = null;
        st.trials = [];
      }
      if (o.profileVersion) st.profileVersion = st.profileVersion && st.introducedScore !== null ? st.profileVersion : o.profileVersion;
      if (st.introducedScore === null) {
        // a lesson written during this film (or found for the first time): this film is its baseline
        st.introducedScore = o.score;
        st.film = o.film;
        continue;
      }
      if (st.film === o.film || st.status === "dropped" || st.trials.some((t) => t.film === o.film)) continue;
      st.trials.push({ film: o.film, score: o.score });
      if (st.trials.length >= 2) {
        const mean = st.trials.reduce((x, t) => x + t.score, 0) / st.trials.length;
        st.status = mean >= st.introducedScore ? "kept" : mean <= st.introducedScore - 3 ? "dropped" : "probation";
      }
    }
    await saveLedger(dir, o.channel, l);
    const v = Object.values(l);
    out.push({ agent: a, kept: v.filter((x) => x.status === "kept").length, dropped: v.filter((x) => x.status === "dropped").length, probation: v.filter((x) => x.status === "probation").length });
  }
  return out;
}

export interface FilmMemory { job: string; title: string; at: string; idea: string; score: number; summary: string; belowChannel: string[] }

export async function recordFilm(data: string, channel: string, f: FilmMemory) {
  const dir = path.join(data, "films");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${channel}.jsonl`), JSON.stringify(f) + "\n");
}

export async function recentFilmsText(data: string, channel: string, n = 5): Promise<string> {
  const t = await readFile(path.join(data, "films", `${channel}.jsonl`), "utf8").catch(() => "");
  const made = await producedJobs(data);
  const rows = t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as FilmMemory).filter((r) => made.has(r.job));
  const last = new Map<string, FilmMemory>();
  for (const r of rows) last.set(r.job, r);
  return [...last.values()].slice(-n).map((r) => `- "${r.title}" (${r.at.slice(0, 10)}): score ${r.score}; idea: ${r.idea.slice(0, 160)}; ${r.summary.slice(0, 220)}${r.belowChannel.length ? `; still below the channel: ${r.belowChannel.slice(0, 4).join("; ")}` : ""}`).join("\n");
}
