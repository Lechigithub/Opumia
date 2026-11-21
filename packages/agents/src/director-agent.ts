/**
 * The director agent: it cuts the recorded narration into shots and decides what each shows — after reading how
 * the channel shows lines like these, and after checking that the footage it asks for actually exists.
 *
 *  skill    packages/agents/skills/director.md
 *  tools    see_how_channel_shows (the channel's real shots with the lines spoken over them), probe_footage
 *           (does a picture like this exist? — searched and rated by eye, nothing downloaded), measure_plan
 *           (pace against the channel, graphics bound to verified facts, footage found), submit_plan, note_lesson
 *  memory   <memoryDir>/<channel>.md — its own lessons and a log of every film
 *  hand-over  the candidates its probes found go to sourcing, which starts from them instead of searching blind
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FactSheet, LibraryIndex, Storyboard, TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { directStoryboard, DirectorPlanSchema, PROPS_SPEC, type DirectorPlan } from "./director.js";
import { buildMenu } from "./library-menu.js";
import { agentLoop, cached, MODELS, plain, type AgentTool } from "./llm.js";
import { bindFactProps, formatFactTable, numericFacts } from "./numeric-facts.js";
import type { StylePack } from "./style-pack.js";

export interface ProbeAnswer { key: string; found: number; fit: number; shows: string; candidates: unknown[] }
export interface DirectorReport {
  pass: boolean;
  rounds: Array<{ issues: string[]; shots: number; cutsPerMin: number; medianS: number; probed: number; found: number }>;
  remaining: Array<{ kind: string; detail: string }>;
  agent: { turns: number; calls: Record<string, number>; usd: number };
}
export interface DirectorAgentOptions {
  pack: StylePack;
  script: TimedScript;
  facts: FactSheet;
  index: LibraryIndex;
  /** resolver/scene-tools.ts:makeFootageProbe */
  probe: (items: Array<{ key: string; want: string; kind: "video" | "image"; line: string; when?: string }>) => Promise<ProbeAnswer[]>;
  memoryDir?: string;
  avoidQueries?: string[];
  onReport?: (r: DirectorReport) => void;
  log?: (s: string) => void;
}

const DATA = new Set(["chart", "map", "document", "versus", "money_figure", "timeline"]);
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
const normQ = (q: string) => q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);

/** Returns the storyboard and, per shot id, the candidates the director's probes found. */
export async function directStoryboardAgent(o: DirectorAgentOptions): Promise<{ storyboard: Storyboard; probes: Map<string, unknown[]> }> {
  const log = o.log ?? (() => {});
  const words = o.script.segments.flatMap((s) => s.words.map((w) => ({ ...w, seg: s.id })));
  const short = o.script.durationS <= 90;
  const pacing = o.pack.profile.pacing;
  const cuts = { lo: (pacing.cutsPerMin?.p25 ?? 12) * 0.85, mid: pacing.cutsPerMin?.p50 ?? 17, hi: (pacing.cutsPerMin?.p75 ?? 21) * 1.15 };
  const maxShot = short ? 5.5 : 7;
  const nf = numericFacts(o.facts);
  const menu = buildMenu(o.index);
  const skill = await readFile(new URL("../skills/director.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readFile(path.join(o.memoryDir, `${o.pack.channelId}.md`), "utf8").catch(() => "") : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const people = (o.facts.story?.characters ?? []).map((c) => c.name.split(/\s+/).at(-1)!.replace(/[^\p{L}]/gu, "")).filter((n) => n.length >= 3);
  const lineFrom = (a: number, b: number) => words.slice(a, b).map((w) => w.word).join(" ");

  // ---- probes: what the sources hold for each described picture, keyed by its query
  const probed = new Map<string, ProbeAnswer>();
  const rounds: DirectorReport["rounds"] = [];
  let lastIssues: Array<{ kind: string; detail: string }> = [{ kind: "no_plan", detail: "no plan was submitted" }];
  let accepted: DirectorPlan | null = null;
  let lastPlan: DirectorPlan | null = null;
  let noteSaved = false;
  let grace = 1;

  const measure = (plan: DirectorPlan) => {
    lastPlan = plan;
    const shots = [...plan.shots].sort((a, b) => a.startWord - b.startWord);
    const issues: Array<{ kind: string; detail: string }> = [];
    const bad = shots.filter((s, i) => s.startWord < 0 || s.startWord >= words.length || (i > 0 && s.startWord <= shots[i - 1]!.startWord));
    if (bad.length || shots[0]?.startWord !== 0) issues.push({ kind: "bad_cut_points", detail: `start words must begin at 0, increase strictly and stay under ${words.length}${bad.length ? `; wrong: ${bad.slice(0, 6).map((s) => s.startWord).join(", ")}` : ""}.` });
    const valid = shots.filter((s) => s.startWord >= 0 && s.startWord < words.length);
    const durs = valid.map((s, i) => (valid[i + 1] ? words[valid[i + 1]!.startWord]!.startS : o.script.durationS) - (i === 0 ? 0 : words[s.startWord]!.startS));
    const cpm = (valid.length / Math.max(1, o.script.durationS)) * 60;
    if (cpm < cuts.lo || cpm > cuts.hi) issues.push({ kind: "pace", detail: `${valid.length} shots in ${Math.round(o.script.durationS)} s is ${cpm.toFixed(1)} cuts a minute; the channel cuts ${cuts.lo.toFixed(0)}–${cuts.hi.toFixed(0)} (typically ${cuts.mid.toFixed(0)}). ${cpm < cuts.lo ? "Cut more often: split the long shots on their sentence starts and weight words." : "Cut less often."}` });
    const long = valid.map((s, i) => ({ s, d: durs[i]! })).filter((x) => x.d > maxShot);
    if (long.length) issues.push({ kind: "shot_too_long", detail: `${long.length} shot(s) run over ${maxShot} s (${long.slice(0, 5).map((x) => `word ${x.s.startWord}: ${x.d.toFixed(1)} s`).join(", ")}). The channel never sits that long on one picture: cut inside them.` });
    const tiny = valid.map((s, i) => ({ s, d: durs[i]! })).filter((x) => x.d < 0.8);
    if (tiny.length) issues.push({ kind: "shot_too_short", detail: `${tiny.length} shot(s) are under 0.8 s (${tiny.slice(0, 5).map((x) => `word ${x.s.startWord}`).join(", ")}).` });
    // Graphics must bind every number to a verified fact.
    const unbound = valid.filter((s) => s.visual === "designed" && DATA.has(s.designedKind)).filter((s) => {
      try {
        return !bindFactProps(s.designedKind, JSON.parse(s.designedProps || "{}") as Record<string, unknown>, nf);
      } catch {
        return true;
      }
    });
    if (unbound.length) issues.push({ kind: "graphic_not_bound", detail: `${unbound.length} data graphic(s) do not bind to the numeric fact table (${unbound.slice(0, 5).map((s) => `word ${s.startWord} ${s.designedKind}`).join(", ")}): reference fact ids exactly as the table gives them, or show footage instead.` });
    // A line naming a person needs that person as an entity.
    const unnamed = valid.filter((s, i) => {
      const line = lineFrom(s.startWord, valid[i + 1]?.startWord ?? words.length);
      return people.some((p) => new RegExp(`\\b${p}\\b`).test(line)) && !s.entities.some((e) => e.type === "person") && s.lineLink === "literal";
    });
    if (unnamed.length) issues.push({ kind: "person_without_entity", detail: `${unnamed.length} shot(s) sit under a line that names a person, marked literal, without that person in entities (${unnamed.slice(0, 5).map((s) => `word ${s.startWord}`).join(", ")}).` });
    // Footage: every picture asked for should have been looked for, and found.
    const footage = valid.filter((s) => !(s.visual === "designed" && DATA.has(s.designedKind)) && !s.entities.length);
    const seen = new Map<string, number>();
    for (const s of footage) seen.set(normQ(s.query), (seen.get(normQ(s.query)) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([q]) => q);
    if (repeated.length) issues.push({ kind: "same_picture_twice", detail: `asked for the same picture more than once: ${repeated.slice(0, 5).map((q) => `"${q}"`).join(", ")}. Every shot shows something different.` });
    const notProbed = footage.filter((s) => !probed.has(normQ(s.query)));
    if (notProbed.length > Math.floor(footage.length * 0.15)) issues.push({ kind: "footage_not_checked", detail: `${notProbed.length} of ${footage.length} footage shots were never checked with probe_footage (${notProbed.slice(0, 6).map((s) => `word ${s.startWord} "${s.query.slice(0, 40)}"`).join(", ")}). Check them, and replace what does not exist.` });
    const missing = footage.filter((s) => (probed.get(normQ(s.query))?.fit ?? 10) < 6);
    const allow = Math.floor(footage.length * 0.1);
    if (missing.length > allow) issues.push({ kind: "footage_not_found", detail: `${missing.length} shot(s) ask for a picture no source holds (${missing.slice(0, 8).map((s) => `word ${s.startWord} "${s.query.slice(0, 40)}" — best ${probed.get(normQ(s.query))?.fit}/10: ${probed.get(normQ(s.query))?.shows.slice(0, 50)}`).join("; ")}). Ask for something else that tells the same line and probe it; at most ${allow} may stay unfound.` });
    const found = footage.filter((s) => (probed.get(normQ(s.query))?.fit ?? 0) >= 6).length;
    rounds.push({ issues: issues.map((x) => x.kind), shots: valid.length, cutsPerMin: Math.round(cpm * 10) / 10, medianS: Math.round(median(durs) * 100) / 100, probed: footage.length - notProbed.length, found });
    lastIssues = issues;
    const header = `PLAN: ${valid.length} shots, ${cpm.toFixed(1)} cuts a minute (channel ${cuts.lo.toFixed(0)}–${cuts.hi.toFixed(0)}), median shot ${median(durs).toFixed(1)} s; ${valid.filter((s) => s.entities.length).length} show a named real subject, ${valid.filter((s) => s.visual === "designed" && DATA.has(s.designedKind)).length} data graphic(s), ${footage.length} footage shot(s) of which ${found} were found in the sources.`;
    return { ok: issues.length === 0, report: issues.length ? `${header}\n\nNOT YET — ${issues.length} thing(s) to fix:\n${issues.map((x, i) => `${i + 1}. [${x.kind}] ${x.detail}`).join("\n")}` : `${header}\n\nPASSES.` };
  };

  const tools: AgentTool[] = [
    {
      name: "see_how_channel_shows",
      description: "Read what the real channel put on screen over lines like the one you are facing. Search by a word in the narration or in the picture (\"bankrupt\", \"logo\", \"factory\", \"chart\"), or by the kind of line: literal, mood, data, metaphor. Returns up to 12 real shots: the line spoken, the kind of shot, what was shown.",
      schema: z.object({ query: z.string() }),
      run: (async (i: { query: string }) => {
        const q = i.query.toLowerCase().trim();
        const rows = o.pack.grammar.filter((r) => r.link === q || `${r.line} ${r.kind} ${r.layout} ${r.shows ?? ""}`.toLowerCase().includes(q));
        if (!rows.length) return `no labelled shot matches "${i.query}". Try a single common word, or one of: literal, mood, data, metaphor.`;
        const step = Math.max(1, Math.floor(rows.length / 12));
        return rows.filter((_, k) => k % step === 0).slice(0, 12).map((r) => `"${r.line.slice(0, 110)}" → ${r.designed ? r.kind : "clean footage"}: ${r.designed ? r.layout : (r.shows ?? r.layout)}${r.t0 !== undefined && r.t1 !== undefined ? ` (${(r.t1 - r.t0).toFixed(1)} s)` : ""}`).join("\n");
      }) as AgentTool["run"],
    },
    {
      name: "probe_footage",
      description: "Check whether pictures you want exist before you commit to them. For each item the stock and archive sources are searched and the candidates rated by eye against the line; you get the best fit out of 10 and what it shows. Up to 14 items per call. `want` is the footage query you would put on the shot; `startWord` is the shot's start word (so the line is known); `when` is the year or decade the line is set in, or empty.",
      schema: z.object({ items: z.array(z.object({ startWord: z.number(), want: z.string(), kind: z.enum(["video", "image"]), when: z.string() })).min(1).max(14) }),
      run: (async (i: { items: Array<{ startWord: number; want: string; kind: "video" | "image"; when: string }> }) => {
        const fresh = i.items.filter((x) => !probed.has(normQ(x.want)));
        if (fresh.length) {
          const res = await o.probe(fresh.map((x) => ({ key: normQ(x.want), want: x.want, kind: x.kind, line: lineFrom(Math.max(0, x.startWord), Math.min(words.length, x.startWord + 18)), ...(x.when.trim() ? { when: x.when.trim() } : {}) })));
          for (const r of res) probed.set(r.key, r);
        }
        return i.items.map((x) => {
          const r = probed.get(normQ(x.want));
          return r ? `"${x.want}" → ${r.fit >= 6 ? "FOUND" : "NOT FOUND"} (best ${r.fit}/10 of ${r.found} looked at): ${r.shows.slice(0, 110)}` : `"${x.want}" → not checked`;
        }).join("\n");
      }) as AgentTool["run"],
    },
    {
      name: "measure_plan",
      description: "Measure your shot list: pace against the channel's, shot lengths, graphics bound to verified facts, named people marked as entities, and whether the footage you ask for was checked and found.",
      schema: DirectorPlanSchema,
      run: (async (i: DirectorPlan) => measure(i).report) as AgentTool["run"],
    },
    {
      name: "submit_plan",
      description: "Submit the shot list. It is measured once more; accepted when it passes, otherwise you get back what is still wrong.",
      schema: DirectorPlanSchema,
      run: (async (i: DirectorPlan) => {
        const r = measure(i);
        if (r.ok) accepted = i;
        return r.ok ? `ACCEPTED.\n${r.report}\nIf this film taught you something, call note_lesson once; then stop.` : r.report;
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one short lesson for your future self (what was findable, what was not, what the measurement kept catching).",
      schema: z.object({ lesson: z.string().max(400) }),
      run: (async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.pack.channelId}.md`), `- LESSON (${o.script.title.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      }) as AgentTool["run"],
    },
  ];

  const system = [
    cached(o.pack.text),
    plain(
      `${skill}\n\n## This channel's pace (measured)\n${cuts.lo.toFixed(0)}–${cuts.hi.toFixed(0)} cuts a minute, typically ${cuts.mid.toFixed(0)}; median shot about ${(pacing.shotMedianS?.p50 ?? 2).toFixed(1)} s. No shot under 0.8 s or over ${maxShot} s.\n\n## The plan you write\nAspect ${o.script.aspect}. Each shot: startWord (global word index it starts on), intent (what the viewer should understand), lineLink, visual (reenactment = staged footage with anonymous people; broll; photo; designed), query (the footage to find — also the footage behind a graphic), era, entities (real named people, companies, products, places the shot must literally show; year 0 if unknown), designedKind + designedProps for a data graphic (else "none" and "{}"), camera, transitionIn, focusX (0.5 unless the subject sits to one side). Leave overlay empty and sfx as an empty list: sound is designed later on what the viewer sees.\nmusicId: one bed from the music menu.\n\n${PROPS_SPEC}${o.avoidQueries?.length ? `\n\nQueries that failed in earlier films (do not reuse these phrasings): ${o.avoidQueries.slice(0, 30).join("; ")}` : ""}${notes.trim() ? `\n\n## Your own notes from earlier films\n${tail(notes, 30)}` : ""}${owner.trim() ? `\n\n## The owner's notes on your work (take these seriously)\n${tail(owner, 30)}` : ""}`,
    ),
  ];
  const user = `Direct this film.\n\nMUSIC MENU: ${menu.music.slice(0, 40).map((m) => `${m.id} "${m.title}" ${m.durationS}s`).join("; ")}\n\nNUMERIC FACT TABLE (verified):\n${formatFactTable(nf) || "(none — no counters, charts or versus cards)"}\n\nNARRATION:\n${o.script.segments.map((s) => `[${s.id} ${s.role}${s.chapter ? ` | chapter "${s.chapter}"` : ""}] ${s.text}`).join("\n")}\n\nWORDS (index:word@seconds):\n${words.map((w, k) => `${k}:${w.word}@${w.startS.toFixed(2)}`).join(" ")}\n\nStart by reading how the channel shows lines like these.`;

  log(`  director: one director with tools — ${words.length} words, ${Math.round(o.script.durationS)} s, about ${Math.round((o.script.durationS / 60) * cuts.mid)} shots at the channel's pace (${MODELS.sonnet})…`);
  const run = await agentLoop({ stage: "director.agent", model: MODELS.sonnet, system, user, tools, effort: "medium", maxTurns: 24, maxTokens: 32000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "The shot list is not accepted yet. Measure it, fix what it shows, and submit.", log });
  const plan = (accepted ?? lastPlan) as DirectorPlan | null;
  if (!plan) throw new Error("director: no shot list was produced");
  const pass = accepted !== null;
  const report: DirectorReport = { pass, rounds, remaining: pass ? [] : lastIssues, agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  o.onReport?.(report);
  const last = rounds.at(-1);
  log(`  director: ${pass ? "shot list accepted" : "NOT ACCEPTED"} after ${run.turns} turn(s) — ${last?.shots ?? 0} shots, ${last?.cutsPerMin ?? 0} cuts/min, ${last?.found ?? 0} footage shot(s) confirmed in the sources (${probed.size} pictures probed), read the channel ${run.calls.see_how_channel_shows ?? 0}×, $${run.usd.toFixed(2)}${pass ? "" : ` — still: ${lastIssues.map((x) => x.kind).join(", ")}`}`);
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.pack.channelId}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.script.title.slice(0, 60)}": ${pass ? "accepted" : "not accepted"} after ${rounds.length} measurement(s); caught along the way: ${[...new Set(rounds.flatMap((r) => r.issues))].join(", ") || "nothing"}; ${last?.shots ?? 0} shots, ${last?.found ?? 0} footage shots confirmed; not found: ${[...probed.values()].filter((p) => p.fit < 6).map((p) => `"${p.key.slice(0, 30)}"`).slice(0, 8).join(", ") || "none"}\n`);
  }
  const storyboard = await directStoryboard({ pack: o.pack, script: o.script, facts: o.facts, index: o.index, raw: plan, log });
  // Hand-over: the candidates each probe found, keyed by the shot that asked for them.
  const probes = new Map<string, unknown[]>();
  for (const s of plan.shots) {
    const hit = probed.get(normQ(s.query));
    const t = s.startWord === 0 ? 0 : words[s.startWord]?.startS;
    const sh = t === undefined ? undefined : storyboard.shots.find((x) => Math.abs(x.startS - t) < 0.02);
    if (sh && hit?.candidates.length) probes.set(sh.id, hit.candidates);
  }
  return { storyboard, probes };
}
