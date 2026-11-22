/**
 * The research agent: it plans the story's must-have facts, searches, reads pages itself, and records each
 * claim only once the claim's evidence has been found on a page that could actually be read — retrying a fact
 * on another source when one fails.
 *
 *  skill    packages/agents/skills/research.md
 *  tools    web_search (run by the API), read_page (live page, else the Internet Archive's copy),
 *           plan_story, record_claim (verified in code + a strict Haiku check), sheet_status, finish
 *  memory   <memoryDir>/hosts.json — which sites could be read and which refused, learned on every run and
 *           shown before the next; <memoryDir>/notes.md — a log of every sheet and the agent's own lessons
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FactClaim, FactSheet } from "@opumia/contracts";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { agentLoop, MODELS, plain, structured, type AgentTool } from "./llm.js";
import { readPage } from "./web.js";

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/[^a-z0-9$%.,\s]/g, " ").replace(/\s+/g, " ").trim();
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

const Check = z.object({ verdict: z.enum(["supported", "partially_supported", "unsupported"]), why: z.string() });
const KIND = z.enum(["number", "date", "event", "quote", "context"]);

export interface ResearchResult {
  summary: string;
  angle: string;
  claims: FactClaim[];
  sources: FactSheet["sources"];
  gaps: string[];
  agent: { turns: number; calls: Record<string, number>; usd: number; pagesRead: number; fromArchive: number; rejected: number };
}

export interface ResearchAgentOptions {
  topic: string;
  format: string;
  want: number;
  memoryDir?: string;
  /** Reads a page through a real browser when the plain request and the archive both fail. */
  browserRead?: (url: string) => Promise<string | null>;
  /** The spoken words of a video (captions), for interviews and talks. */
  videoTranscript?: (url: string) => Promise<{ title: string; channel: string; text: string } | null>;
  /**
   * Quick mode: another agent (the writer) asks for specific facts. No story plan and no depth targets — find
   * and verify what was asked, then finish. Claim ids continue after `idStart`.
   */
  questions?: string[];
  idStart?: number;
  log?: (s: string) => void;
}

export async function researchAgent(o: ResearchAgentOptions): Promise<ResearchResult> {
  const quick = Boolean(o.questions?.length);
  const log = o.log ?? (() => {});
  // The writer needs room to choose: the sheet aims at twice the bare minimum a script could be written from.
  const want = Math.max(o.want * 2, 20);
  const skill = await readFile(new URL("../skills/research.md", import.meta.url), "utf8");
  const hostsFile = o.memoryDir ? path.join(o.memoryDir, "hosts.json") : null;
  const hosts: Record<string, { read: number; archive: number; failed: number }> = hostsFile ? await readFile(hostsFile, "utf8").then((t) => JSON.parse(t) as Record<string, { read: number; archive: number; failed: number }>, () => ({})) : {};
  const notes = o.memoryDir ? await readFile(path.join(o.memoryDir, "notes.md"), "utf8").catch(() => "") : "";
  // F22: subjects researched for earlier films. Their verified facts (with source and exact evidence) are leads:
  // the agent may record them again with record_claim, which re-reads the page and checks them like any claim.
  const STOP = new Set(["the", "and", "how", "why", "what", "with", "from", "that", "this", "still", "into", "rise", "fall", "story", "company", "invented"]);
  const kw = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));
  const mine = kw(o.topic);
  const subjects = o.memoryDir && !quick ? await readFile(path.join(o.memoryDir, "subjects.jsonl"), "utf8").then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { topic: string; claims: Array<{ text: string; kind: string; sourceUrl: string; evidence: string }> }), () => []) : [];
  const leads = subjects.filter((x) => x.topic !== o.topic && [...kw(x.topic)].filter((w) => mine.has(w)).length >= 1).flatMap((x) => x.claims.map((c) => ({ ...c, from: x.topic }))).slice(0, 40);

  // ---- pages (each read once per run; the outcome per site is remembered across runs)
  const pages = new Map<string, Promise<{ text: string; via: "live" | "archive" | "browser" } | null>>();
  const page = (url: string) => {
    if (!pages.has(url))
      pages.set(
        url,
        (/youtube\.com|youtu\.be/i.test(url) && o.videoTranscript
          ? o.videoTranscript(url).then((v) => (v ? { text: `${v.title} — ${v.channel} (spoken words of the video)\n${v.text}`.slice(0, 120_000), via: "live" as const } : null), () => null)
          : readPage(url, 80_000, o.browserRead)
        ).then((p) => {
          const h = hostOf(url);
          if (h) {
            const e = (hosts[h] ??= { read: 0, archive: 0, failed: 0 });
            if (!p) e.failed++;
            else if (p.via === "archive") e.archive++;
            else e.read++;
          }
          return p;
        }),
      );
    return pages.get(url)!;
  };

  // ---- the sheet
  const claims: FactClaim[] = [];
  let plan: { angle: string; mustHave: string[] } | null = null;
  let finished: { summary: string; angle: string; covered: Array<{ mustHave: number; claimId: string }>; gaps: string[] } | null = null;
  let rejected = 0;
  const usable = () => claims.filter((c) => c.verdict === "supported" || c.verdict === "partially_supported");
  // H30: source quality. 3 primary (courts, regulators, governments, filings, the company's own reports, the
  // person's own words on video), 2 reputable press and reference works, 1 everything else (blogs, user posts).
  const tierOf = (url: string): 1 | 2 | 3 => {
    const h = hostOf(url);
    const u = url.toLowerCase();
    if (/\.(gov|mil)(\.[a-z]{2})?$|\.gov\.|courtlistener|justia|supremecourt|uscourts|sec\.gov|europa\.eu|parliament|congress\.gov|federalregister|companieshouse|annualreports|investor\.|investors\.|ir\./.test(h) || /\.pdf($|\?)/.test(u) || /youtube\.com|youtu\.be/.test(h)) return 3;
    if (/reuters|apnews|bloomberg|nytimes|wsj|ft\.com|economist|washingtonpost|theguardian|bbc\.|cnbc|cnn\.|npr\.org|latimes|forbes|fortune|businessinsider|time\.com|theatlantic|newyorker|wired|arstechnica|theverge|techcrunch|axios|politico|britannica|nature\.com|science\.org|\.edu$|\.ac\.[a-z]{2}$|wikipedia\.org|history\.com|smithsonian|pbs\.org|nbcnews|abcnews|cbsnews|usatoday|independent\.co|telegraph\.co|spiegel|lemonde|nikkei|scmp/.test(h)) return 2;
    // newspapers by name (local and national press: The Irish Times, the Rochester Beacon, the Denver Post …)
    if (/(^|\.)([a-z-]*(times|post|herald|tribune|journal|gazette|chronicle|beacon|guardian|observer|telegraph|independent|courier|examiner|inquirer|dispatch|register|star|sun|mirror|express|news|press|today))\.[a-z.]+$/.test(h) && !/medium|substack|blogspot|wordpress|reddit|quora/.test(h)) return 2;
    return 1;
  };
  const CONTESTED = /\b(wanted|feared|believed|hated|knew|lied|fraud|cheat|covered up|hid|deceiv|motive|intended|planned to|refused to|ignored|blamed|accus|alleg)/i;
  const status = () => {
    const u = usable();
    const count = (k: string) => u.filter((c) => c.kind === k).length;
    const srcs = new Set(u.map((c) => hostOf(c.sourceUrl)));
    const need: string[] = [];
    if (u.length < want) need.push(`${want - u.length} more verified fact(s) (have ${u.length}; a sheet the writer can choose from has ${want})`);
    if (count("quote") < 3) need.push(`${3 - count("quote")} more word-for-word quotation(s) by a named person`);
    if (count("number") < 5) need.push(`${5 - count("number")} more figure(s) — above all contrasts against a rival or peer at the same moment, and then-versus-later`);
    if (count("event") + count("date") < 8) need.push(`${8 - count("event") - count("date")} more dated events (scenes with when, where and who was there)`);
    if (srcs.size < 5) need.push(`facts from ${5 - srcs.size} more independent source(s)`);
    const top = [...srcs].map((h) => ({ h, n: u.filter((c) => hostOf(c.sourceUrl) === h).length })).sort((a, b) => b.n - a.n)[0];
    if (top && u.length >= 8 && top.n / u.length > 0.45) need.push(`less reliance on ${top.h} (${top.n} of ${u.length} facts) — bring facts from other sources, ideally primary ones`);
    // H30: the sheet stands on good sources; contested claims need a good one or two independent ones.
    const strong = u.filter((c) => tierOf(c.sourceUrl) >= 2);
    if (u.length >= 8 && strong.length / u.length < 0.5) need.push(`more facts from primary or reputable sources (${strong.length} of ${u.length} now; at least half) — filings, court records, the company's reports, the person's own words, established newspapers`);
    const weakContested = u.filter((c) => tierOf(c.sourceUrl) === 1 && CONTESTED.test(c.text) && !u.some((d) => d.id !== c.id && hostOf(d.sourceUrl) !== hostOf(c.sourceUrl) && norm(d.text).split(" ").filter((w) => w.length > 4 && norm(c.text).includes(w)).length >= 3));
    if (weakContested.length) need.push(`contested claims resting on one weak source — confirm on a primary or reputable source, or a second independent one: ${weakContested.slice(0, 4).map((c) => `[${c.id}] ${c.text.slice(0, 70)} (${hostOf(c.sourceUrl)})`).join("; ")}`);
    if (!plan) need.push("a plan (call plan_story)");
    if (quick) need.length = 0;
    return { need, text: `VERIFIED so far: ${u.length} fact(s) — ${count("event")} events, ${count("date")} dates, ${count("number")} figures, ${count("quote")} quotations, ${count("context")} context — from ${srcs.size} source(s).\n${plan ? `MUST-HAVES:\n${plan.mustHave.map((m, i) => `  ${i}. ${m}`).join("\n")}` : "No plan yet."}\n${need.length ? `STILL NEEDED:\n${need.map((n) => `  - ${n}`).join("\n")}` : "The film has enough to stand on. Make sure every must-have is verified, then finish."}\nCLAIMS:\n${u.map((c) => `  [${c.id}] (${c.kind}) ${c.text} — ${hostOf(c.sourceUrl)} [${["", "weak", "reputable", "primary"][tierOf(c.sourceUrl)]}]`).join("\n") || "  none"}` };
  };

  const tools: AgentTool[] = [
    {
      name: "plan_story",
      description: "State the story angle and the must-have facts: the handful this story cannot be told without (the decisive scene, the key contrast, the ending fact). Call it once, early; you are held to these when you finish.",
      schema: z.object({ angle: z.string(), mustHave: z.array(z.string()).min(3).max(8) }),
      run: (async (i: { angle: string; mustHave: string[] }) => {
        plan = i;
        return `Plan recorded: ${i.mustHave.length} must-have fact(s).`;
      }) as AgentTool["run"],
    },
    {
      name: "read_page",
      description: "Read a source as text: a web page (live, or the Internet Archive's copy, or through a browser when the site refuses), a PDF (filings, court documents, reports), or a YouTube video (its spoken words — an interview or a talk is often where a quotation really comes from). Returns the start of the page; pass `find` (a name, a figure, a phrase) to also get the passages around every match — use it to locate the exact sentence you will quote as evidence.",
      schema: z.object({ url: z.string(), find: z.string().describe("optional: text to locate on the page, or empty") }),
      run: (async (i: { url: string; find: string }) => {
        if (!/^https?:\/\//.test(i.url)) throw new Error("not a URL");
        const p = await page(i.url);
        if (!p) return `UNREADABLE: ${hostOf(i.url)} could not be read live or from the archive. Use another source for this fact.`;
        const out = [`${hostOf(i.url)} (${p.via === "archive" ? "archived copy" : p.via === "browser" ? "read in a browser" : "live"}, ${p.text.length} characters)`, p.text.slice(0, 5000)];
        const q = i.find.trim().toLowerCase();
        if (q.length >= 3) {
          const lower = p.text.toLowerCase();
          const hits: string[] = [];
          for (let at = lower.indexOf(q); at >= 0 && hits.length < 6; at = lower.indexOf(q, at + q.length)) hits.push(p.text.slice(Math.max(0, at - 500), at + 700).replace(/\s+/g, " "));
          out.push(hits.length ? `PASSAGES AROUND "${i.find}":\n${hits.map((h, k) => `(${k + 1}) …${h}…`).join("\n")}` : `"${i.find}" does not appear on this page.`);
        }
        return out.join("\n\n");
      }) as AgentTool["run"],
    },
    {
      name: "record_claim",
      description: "Record one fact with its source. `evidence` must be the exact sentence from that page that supports it (copy it from read_page). The page is read and the claim checked against it; you get back whether it was verified. If the page is unreadable or the claim is not supported, find the fact on another source and record it again.",
      schema: z.object({ text: z.string().describe("exactly one fact, stated plainly"), kind: KIND, sourceUrl: z.string(), sourceTitle: z.string(), evidence: z.string().describe("the exact supporting sentence from the page") }),
      run: (async (i: { text: string; kind: z.infer<typeof KIND>; sourceUrl: string; sourceTitle: string; evidence: string }) => {
        if (!/^https?:\/\//.test(i.sourceUrl)) throw new Error("sourceUrl is not a URL");
        const words = (t: string) => new Set(norm(t).split(" ").filter((w) => w.length > 3));
        const mine = words(i.text);
        const dup = usable().find((c) => {
          const theirs = words(c.text);
          const shared = [...mine].filter((w) => theirs.has(w)).length;
          return norm(c.text) === norm(i.text) || shared / Math.max(1, Math.min(mine.size, theirs.size)) > 0.8;
        });
        if (dup) return `already verified as [${dup.id}] — "${dup.text.slice(0, 100)}". Record a different fact.`;
        if (i.kind === "quote" && !/["“][^"”]{8,}["”]/.test(i.text)) return "NOT RECORDED — a quotation must carry the speaker's exact words in quotation marks. If the page only reports what was said, record it as an event instead.";
        const p = await page(i.sourceUrl);
        if (!p) {
          rejected++;
          return `NOT VERIFIED — ${hostOf(i.sourceUrl)} could not be read (live or archive). Find this fact on another source.`;
        }
        const np = norm(p.text);
        const ev = norm(i.evidence);
        if (ev.length < 12 || !np.includes(ev.slice(0, 110))) {
          rejected++;
          return "NOT VERIFIED — that evidence sentence is not on the page word for word. Use read_page with `find` to locate the exact sentence, or use another source.";
        }
        if (i.kind === "quote") {
          const q = /["“]([^"”]{8,})["”]/.exec(i.text)?.[1];
          if (q && !np.includes(norm(q).slice(0, 110))) {
            rejected++;
            return "NOT VERIFIED — the quoted words are not on the page word for word.";
          }
        }
        const at = np.indexOf(ev.slice(0, 110));
        const context = np.slice(Math.max(0, at - 400), at + ev.length + 400);
        const chk = await structured({ stage: "research.verify", model: MODELS.haiku, system: [plain("You are a strict fact-checker. Decide whether the PASSAGE supports the CLAIM: supported (the passage states it; every figure, date and name matches), partially_supported (it states part of it, or a rounded or close figure), unsupported (absent, contradicted, or about something else). Judge only from the passage.")], user: `CLAIM: ${i.text}\n\nPASSAGE (from ${hostOf(i.sourceUrl)}):\n${context}`, schema: Check, effort: "low", maxTokens: 400 }).catch(() => null);
        const verdict = chk?.data.verdict ?? "partially_supported";
        if (verdict === "unsupported") {
          rejected++;
          return `NOT VERIFIED — the passage does not support the claim: ${chk?.data.why.slice(0, 200)}. Correct the claim to what the page says, or use another source.`;
        }
        const id = `c${String(claims.length + 1 + (o.idStart ?? 0)).padStart(2, "0")}`;
        claims.push({ id, text: i.text.trim(), kind: i.kind, sourceUrl: i.sourceUrl, ...(i.sourceTitle.trim() ? { sourceTitle: i.sourceTitle.trim() } : {}), evidence: i.evidence.trim().slice(0, 300), verdict, checkedBy: MODELS.haiku });
        // Enough is enough: once the sheet has what the film needs, the researcher is told to stop collecting.
        const enough = status().need.length === 0;
        return `VERIFIED [${id}] (${verdict}${p.via === "archive" ? ", from the archived copy" : ""}).${enough ? " The sheet now has what the film needs — record only what a must-have still lacks, then finish." : ""}`;
      }) as AgentTool["run"],
    },
    {
      name: "sheet_status",
      description: "See the fact sheet so far: what is verified, by kind and source, your must-haves, and what the film still needs.",
      schema: z.object({}),
      run: async () => status().text,
    },
    {
      name: "finish",
      description: "Finish the fact sheet. Give a two-sentence summary, the story angle, which verified claim covers each must-have, and any must-have you could not verify anywhere (gaps). Accepted only when the film has enough to stand on and every must-have is either covered or declared a gap.",
      schema: z.object({ summary: z.string(), angle: z.string(), covered: z.array(z.object({ mustHave: z.number(), claimId: z.string() })), gaps: z.array(z.string()) }),
      run: (async (i: { summary: string; angle: string; covered: Array<{ mustHave: number; claimId: string }>; gaps: string[] }) => {
        if (quick) {
          finished = i;
          return "ACCEPTED.";
        }
        const stt = status();
        const ids = new Set(usable().map((c) => c.id));
        const bad = i.covered.filter((c) => !ids.has(c.claimId)).map((c) => c.claimId);
        const uncovered = (plan?.mustHave ?? []).map((m, k) => ({ m, k })).filter(({ k }) => !i.covered.some((c) => c.mustHave === k && ids.has(c.claimId)));
        const undeclared = uncovered.filter(({ m }) => !i.gaps.some((g) => norm(g).split(" ").filter((w) => w.length > 4 && norm(m).includes(w)).length >= 2));
        const problems = [...stt.need, ...(bad.length ? [`these claim ids are not verified claims: ${bad.join(", ")}`] : []), ...undeclared.map(({ m }) => `must-have not covered and not declared a gap: "${m}"`), ...(uncovered.length > Math.floor((plan?.mustHave.length ?? 0) / 2) ? ["more than half of the must-haves are unverified — keep researching (other sources, the archive) before giving up on them"] : [])];
        if (problems.length) return `NOT FINISHED:\n${problems.map((x) => `- ${x}`).join("\n")}`;
        finished = i;
        return "ACCEPTED. The fact sheet is complete.";
      }) as AgentTool["run"],
    },
  ];

  tools.push({
    name: "note_lesson",
    description: "Save one short lesson for your future self (which kinds of source carried the best facts, what kept failing verification).",
    schema: z.object({ lesson: z.string().max(400) }),
    run: (async (i: { lesson: string }) => {
      if (!o.memoryDir) return "no memory configured";
      await mkdir(o.memoryDir, { recursive: true });
      await appendFile(path.join(o.memoryDir, "notes.md"), `- LESSON (${o.topic.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
      return "saved";
    }) as AgentTool["run"],
  });
  const known = Object.entries(hosts);
  const refused = known.filter(([, v]) => v.failed >= 2 && v.read + v.archive === 0).map(([h]) => h);
  const good = known.filter(([, v]) => v.read + v.archive >= 2).sort((a, b) => b[1].read + b[1].archive - (a[1].read + a[1].archive)).map(([h]) => h);
  const system = [
    plain(
      `${skill}\n\n## This film\n${o.format}. A script can be written from ${o.want} facts, but a writer needs room to choose: build a sheet of at least ${want} verified facts — people and what they wanted, dated scenes, contrasts, at least three word-for-word quotations and five figures — from at least five independent sources, no single source carrying most of it.${refused.length ? `\n\n## Sites that could not be read on earlier films (do not rely on them)\n${refused.slice(0, 40).join(", ")}` : ""}${good.length ? `\n\n## Sites that were readable on earlier films\n${good.slice(0, 40).join(", ")}` : ""}${notes.trim() ? `\n\n## Your notes from earlier films\n${tail(notes, 20)}` : ""}`,
    ),
  ];
  if (!quick) log(`  research: one researcher with tools — search, read, verify each claim on a readable page (${MODELS.sonnet})…`);
  const run = await agentLoop({
    stage: "research.agent",
    model: MODELS.sonnet,
    system,
    user: quick
      ? `The film is: ${o.topic}\n\nThe writer needs these specific facts verified. For each, find a readable source, record it with record_claim (one fact per claim, exact evidence), then call finish (summary and angle may be one line; covered may be empty; list in gaps anything you could not verify). Do not research anything else.\n${o.questions!.map((q) => `- ${q}`).join("\n")}`
      : `Research this film: ${o.topic}${leads.length ? `\n\nLEADS from earlier films on overlapping subjects — facts verified then, with their source and exact evidence. Use the ones this story needs: record them with record_claim like any claim (the page is re-read and checked again). They are leads, not a fact sheet:\n${leads.map((c) => `- (${c.kind}) ${c.text} — ${c.sourceUrl} — evidence: "${c.evidence.slice(0, 160)}" [from "${c.from.slice(0, 50)}"]`).join("\n")}` : ""}\n\nStart with a few searches to learn the story, then plan_story, then read and record.`,
    tools,
    serverTools: [{ type: "web_search_20260209", name: "web_search", max_uses: quick ? 6 : 20 } as Anthropic.Beta.BetaToolUnion],
    effort: quick ? "low" : "medium",
    maxTurns: quick ? 12 : 50,
    maxTokens: 16000,
    done: () => finished !== null,
    nudge: "The fact sheet is not finished. Call sheet_status, fill what is still needed, then finish.",
    log,
  });
  const u = usable();
  const fin = finished as { summary: string; angle: string; covered: Array<{ mustHave: number; claimId: string }>; gaps: string[] } | null;
  const thePlan = plan as { angle: string; mustHave: string[] } | null;
  const allPages = await Promise.all([...pages.entries()].map(async ([url, p]) => ({ url, p: await p })));
  const fromArchive = allPages.filter((x) => x.p?.via === "archive").length;
  if (!quick) log(`  research: ${fin ? "fact sheet complete" : "NOT FINISHED"} after ${run.turns} turn(s) — ${u.length} verified fact(s) (${rejected} attempt(s) rejected and retried), ${allPages.filter((x) => x.p).length}/${allPages.length} page(s) readable (${fromArchive} from the archive), $${run.usd.toFixed(2)}${fin?.gaps.length ? ` — gaps: ${fin.gaps.map((g) => g.slice(0, 60)).join("; ")}` : ""}`);
  if (!quick && u.filter((c) => c.verdict === "supported").length < Math.min(5, o.want)) throw new Error(`research: only ${u.length} verified claims — not enough to write a factual script`);
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    if (hostsFile) {
      await writeFile(`${hostsFile}.tmp`, JSON.stringify(Object.fromEntries(Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n");
      await rename(`${hostsFile}.tmp`, hostsFile);
    }
    if (!quick && claims.length) await appendFile(path.join(o.memoryDir, "subjects.jsonl"), JSON.stringify({ topic: o.topic, at: new Date().toISOString(), claims: claims.filter((c) => c.verdict === "supported").map((c) => ({ text: c.text, kind: c.kind, sourceUrl: c.sourceUrl, evidence: c.evidence })) }) + "\n");
    if (!quick) await appendFile(path.join(o.memoryDir, "notes.md"), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.topic.slice(0, 60)}": ${fin ? "complete" : "not finished"}, ${u.length} verified, ${rejected} rejected, must-haves ${fin ? fin.covered.length : 0}/${thePlan?.mustHave.length ?? 0} covered${fin?.gaps.length ? `, gaps: ${fin.gaps.join("; ").slice(0, 200)}` : ""}\n`);
  }
  const srcUrls = [...new Set(claims.map((c) => c.sourceUrl))];
  return {
    summary: fin?.summary ?? `${o.topic}.`,
    angle: fin?.angle ?? thePlan?.angle ?? "",
    claims,
    sources: srcUrls.map((url) => ({ url, ...(claims.find((c) => c.sourceUrl === url)?.sourceTitle ? { title: claims.find((c) => c.sourceUrl === url)!.sourceTitle! } : {}), reachable: true })),
    gaps: fin?.gaps ?? (thePlan ? thePlan.mustHave.filter((_, k) => !fin) : []),
    agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4, pagesRead: allPages.filter((x) => x.p).length, fromArchive, rejected },
  };
}
