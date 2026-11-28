/**
 * Publishing package for a film: thumbnail (real cutouts on the film's colour world), title, description, tags,
 * hashtags and a pinned comment — learned from the reference channel's own packaging (data/exemplars), checked
 * against the film. Writes into the job folder:
 *   thumbnail.jpg  publish.json  youtube-description.txt  youtube-tags.txt  pinned-comment.txt
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Ladders, producedJobs, checkPackage, withoutClaims, ensureQualityBand, ensureThumbBand, ensureThumbCraft, isUsable, packagingAgent, thumbnailImposter, writePublishingText, type PackagingReport } from "@opumia/agents";
import type { FactSheet, FilmDesignSystem, LibraryIndex, ResolutionReport, Storyboard, TimedScript } from "@opumia/contracts";
import { renderThumbnailScene } from "@opumia/motion-engine";
import { closeBrowser, makeThumbnailTools, visionCheck, wikipediaImages, type ThumbCredit, type ThumbPicture } from "@opumia/resolver";
import { measureLook, removeBackground, run } from "@opumia/senses";
import type { ExemplarIndex } from "./exemplars.js";

export interface PublishOptions {
  jobDir: string;
  data: string;
  library: string;
  channel: string;
  job: string;
  facts: FactSheet;
  script: TimedScript;
  design: FilmDesignSystem;
  resolution: ResolutionReport;
  board: Storyboard;
  index: LibraryIndex;
  publicDir: string;
  log: (s: string) => void;
}

const readJson = async <T>(f: string): Promise<T | null> => readFile(f, "utf8").then((t) => JSON.parse(t) as T, () => null);
async function atomic(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}
const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * What each source asks of a published film. `line` is the visible link back to the source (shown once when
 * anything from it is used); `creators` = credit each creator by name where the source asks for it "when possible".
 * Items whose licence REQUIRES attribution (CC BY / BY-SA, Vecteezy) are always credited individually with a link.
 */
const SOURCE_CREDIT: Array<{ host: RegExp; provider: string; line: string; creators: boolean }> = [
  { host: /(^|\.)pexels\.com$/, provider: "pexels", line: "Stock footage and photos provided by Pexels — https://www.pexels.com", creators: true },
  { host: /(^|\.)pixabay\.com$/, provider: "pixabay", line: "Stock footage and photos from Pixabay — https://pixabay.com", creators: true },
  { host: /(^|\.)coverr\.co$/, provider: "coverr", line: "Stock footage from Coverr — https://coverr.co", creators: false },
  { host: /(^|\.)vecteezy\.com$/, provider: "vecteezy", line: "Stock media from Vecteezy — https://www.vecteezy.com", creators: false },
  { host: /(^|\.)wikimedia\.org$/, provider: "commons", line: "Images and footage from Wikimedia Commons — https://commons.wikimedia.org", creators: false },
  { host: /(^|\.)europeana\.eu$/, provider: "europeana", line: "Images from Europeana — https://www.europeana.eu", creators: false },
  { host: /(^|\.)archives\.gov$/, provider: "nara", line: "Archive material from the US National Archives — https://catalog.archives.gov", creators: false },
  { host: /(^|\.)openverse\.org$/, provider: "openverse", line: "Openly licensed images found through Openverse — https://openverse.org", creators: false },
  { host: /(^|\.)archive\.org$/, provider: "archive", line: "Public-domain films from the Internet Archive — https://archive.org", creators: false },
];

/**
 * Credit lines for the description, from what the film really uses (press excerpts are covered by the fair-use
 * notice, not here). Licence-required credits come first and are never dropped for space.
 */
export function creditLines(media: ResolutionReport["media"], maxItems = 24): { sources: string[]; items: string[] } {
  const hostOf = (u?: string) => {
    try {
      return u ? new URL(u).hostname : "";
    } catch {
      return "";
    }
  };
  const used = media.filter((m) => m.origin !== "press");
  const policyOf = (m: (typeof used)[number]) => SOURCE_CREDIT.find((p) => p.provider === m.provider || p.host.test(hostOf(m.sourceUrl)));
  const sources = SOURCE_CREDIT.filter((p) => used.some((m) => policyOf(m) === p)).map((p) => p.line);
  const withLink = (m: (typeof used)[number]) => `${m.attributionText!.replace(/\s*\(optional courtesy credit\)/i, "").replace(/\s+/g, " ").trim()}${m.sourceUrl && !m.attributionText!.includes(m.sourceUrl) ? ` — ${m.sourceUrl}` : ""}`;
  const required = [...new Set(used.filter((m) => m.attributionRequired && m.attributionText).map(withLink))];
  const courtesy = [...new Set(used.filter((m) => !m.attributionRequired && m.attributionText && policyOf(m)?.creators && !/no credit required/i.test(m.attributionText)).map(withLink))].filter((c) => !required.includes(c));
  return { sources, items: [...required, ...courtesy.slice(0, Math.max(0, maxItems - required.length))] };
}

export async function buildPublishingPackage(o: PublishOptions): Promise<{ thumbnailPath: string | null; usd: number }> {
  const log = o.log;
  const exDir = path.join(o.data, "exemplars", o.channel);
  const ex = await readJson<ExemplarIndex>(path.join(exDir, "index.json"));
  if (!ex?.thumbs.length || !ex.packaging?.length) {
    log(`  ! no reference packaging for ${o.channel} (run \`opumia build-exemplars --channel ${o.channel}\`): package skipped`);
    return { thumbnailPath: null, usd: 0 };
  }
  return agentPackage(o, ex, exDir);
}

/**
 * The packaging agent (agents/packaging-agent.ts): title + thumbnail from real pictures, studied, rendered, looked
 * at, measured against the channel's thumbnails and tested blind. Then the description, tags, hashtags and pinned
 * comment are written from its title.
 */
async function agentPackage(o: PublishOptions, ex: ExemplarIndex, exDir: string): Promise<{ thumbnailPath: string | null; usd: number }> {
  const log = o.log;
  const t0 = Date.now();
  const band = await ensureThumbBand({ data: o.data, channel: o.channel, thumbs: ex.thumbs.map((t) => ({ file: path.join(exDir, t.file), title: t.title, views: t.views, colourfulness: t.look.colourfulness, luma: t.look.luma })), log });
  if (!band) {
    // build list 3, L14: no single-prompt package; the band is built from the channel's thumbnails first
    throw new Error("the channel's thumbnail band could not be built (reference thumbnails could not be labelled): run it again once the labeller is reachable");
  }
  const craft = await ensureThumbCraft({ data: o.data, channel: o.channel, band, log }).catch((e: Error) => (log(`  ! thumbnail craft unavailable: ${e.message.slice(0, 120)}`), null));
  const tools = makeThumbnailTools({ jobDir: o.jobDir, dataDir: o.data, libraryRoot: o.library, index: o.index, resolution: o.resolution, facts: o.facts, board: o.board, log });
  await tools.gather();
  log(`  packaging agent: ${tools.pics.length} real picture(s) to start — ${tools.pics.map((p) => p.depicts.slice(0, 26)).join("; ")}`);
  const made = await producedJobs(o.data);
  const concepts = ((await readJson<Array<{ job: string; concept: string; words?: number }>>(path.join(o.data, "thumbnail-concepts.json"))) ?? []).filter((c) => made.has(c.job));
  // build list 5, item 29: how many of our recent thumbnails carried no words (older entries without a count: read from the concept)
  const recent = concepts.filter((c) => c.job !== o.job).slice(-10);
  const recentWordless = { films: recent.length, wordless: recent.filter((c) => (c.words !== undefined ? c.words === 0 : /\bno (text|words)\b|\bwordless\b/i.test(c.concept))).length };
  const before = await import("@opumia/agents").then((m) => m.usageLedger().reduce((t, r) => t + r.usd, 0));
  const qualityBand = await ensureQualityBand({ data: o.data, channel: o.channel, log }).catch(() => null);
  const runAgent = (brief?: string): Promise<PackagingReport> => packagingAgent({
    ...(brief ? { brief } : {}),
    channel: o.channel,
    jobDir: o.jobDir,
    facts: o.facts,
    script: o.script,
    design: o.design,
    band,
    craft,
    quality: qualityBand,
    references: ex.packaging ?? [],
    // The agent only hands back pictures from this same list.
    pictures: { ...tools, brief: (p) => tools.brief(p as ThumbPicture) },
    cover: o.board.aspect === "9:16",
    render: async (r) => {
      // Rendered at twice the size and brought down with a sharp filter (crisper edges and type), then a light
      // unsharp mask and film grain on the real pixels — the channel's thumbnails are sharp and textured.
      const big = r.out.replace(/\.jpg$/, ".2x.png");
      const w = r.w ?? 1280, h = r.h ?? 720;
      await renderThumbnailScene({ publicDir: tools.pubDir, spec: r.spec, slots: r.slots, design: r.design, finish: r.finish, fresh: r.fresh, width: w * 2, height: h * 2, out: big, log: () => {} });
      const amt = (0.4 + r.sharpen * 0.9).toFixed(2);
      const grain = Math.round(r.grain * 14);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", big, "-vf", `scale=${w}:${h}:flags=lanczos,unsharp=5:5:${amt}:5:5:0${grain ? `,noise=alls=${grain}:allf=t` : ""}`, "-q:v", "2", "-frames:v", "1", "-update", "1", r.out]);
      await rm(big, { force: true });
    },
    avoidConcepts: concepts.filter((c) => c.job !== o.job).slice(-8).map((c) => c.concept),
    recentWordless,
    memoryDir: path.join(o.data, "agents", "packaging"),
    log,
  });
  // The packaging ladder (build list 3, item 18): a thumbnail outside the channel's band or below the critic's bar
  // gets another concept, then another hero picture; the best render of every attempt is kept.
  let report = await runAgent();
  const tried: PackagingReport[] = [report];
  {
    type PA = Record<string, never>;
    const why = (r: PackagingReport) => [`concept "${r.thumbnail?.concept ?? "none"}"`, ...(r.thumbnail?.issues ?? []).map((x) => `outside the band: ${x.kind}`), ...(r.thumbnail?.imposter?.spotted ? [`picked out blind: ${r.thumbnail.imposter.tells.slice(0, 3).join("; ")}`] : [])].join("; ");
    const pl = new Ladders<PA>({ jobDir: o.jobDir, stage: "packaging", log, table: { thumbnail: [
      { name: "another concept", owner: "packaging agent", maxUsd: 0.4, run: async () => { report = await runAgent(`Make a DIFFERENT concept (not a variation). Last time: ${why(report)}`); tried.push(report); return `"${report.thumbnail?.concept ?? "none"}" — ${report.pass ? "accepted" : "not accepted"}`; } },
      { name: "another hero picture", owner: "packaging agent", maxUsd: 0.4, run: async () => { report = await runAgent(`Build the thumbnail around a DIFFERENT hero picture than before (find_picture, find_expression, film_footage), and a different concept. Last time: ${why(report)}`); tried.push(report); return `"${report.thumbnail?.concept ?? "none"}" — ${report.pass ? "accepted" : "not accepted"}`; } },
    ] } });
    for (let k = 0; k < 2 && !report.pass; k++) {
      const done = await pl.step([{ check: "thumbnail", shots: [], what: "thumbnail not accepted", measured: why(report).slice(0, 200), band: "inside the channel's band, past the critic and the blind test" }], {});
      if (!done.length) break;
    }
    await pl.close(report.pass ? [] : [{ check: "thumbnail", shots: [], what: "thumbnail not accepted", measured: "", band: "" }]);
    // none accepted: the attempt with the fewest problems is kept
    if (!report.pass) report = [...tried].sort((x, y) => (x.thumbnail?.issues.length ?? 99) + (x.thumbnail?.imposter?.spotted ? 2 : 0) - ((y.thumbnail?.issues.length ?? 99) + (y.thumbnail?.imposter?.spotted ? 2 : 0)))[0]!;
  }
  await closeBrowser();
  let usd = (await import("@opumia/agents").then((m) => m.usageLedger().reduce((t, r) => t + r.usd, 0))) - before;
  const th = report.thumbnail;
  const thumbnailPath = path.join(o.jobDir, "thumbnail.jpg");
  // a 9:16 film's cover: mix.ts makes it the film's first frame, the gate checks it is there
  const cv = report.cover ?? null;
  if (cv) await writeFile(path.join(o.jobDir, "cover_9x16.jpg"), await readFile(cv.file));
  else if (o.board.aspect === "9:16") log("  ! packaging: no 9:16 cover was made — the gate will refuse the film until cover_9x16.jpg exists");
  if (th) {
    await writeFile(thumbnailPath, await readFile(th.file));
    await atomic(path.join(o.data, "thumbnail-concepts.json"), JSON.stringify([...concepts.filter((c) => c.job !== o.job), { job: o.job, concept: th.concept, words: th.words ?? 0 }].slice(-40), null, 1) + "\n");
  }
  log(`  packaging: ${report.pass ? "accepted" : "NOT accepted (best render kept)"} — "${report.title}"; ${report.renders} render(s); thumbnail ${th ? (th.imposter ? (th.imposter.spotted ? `picked out blind (${th.imposter.confidence.toFixed(2)})` : "passed blind") : "not tested blind") : "none"}${th?.issues.length ? `; outside the band: ${th.issues.map((x) => x.kind).join(", ")}` : ""}`);

  const thumbText = ((th?.spec as { elements?: Array<{ type: string; text?: string }> } | undefined)?.elements ?? []).filter((e) => e.type === "text").map((e) => e.text ?? "");
  let text = await writePublishingText({ channel: o.channel, references: ex.packaging ?? [], script: o.script, facts: o.facts, title: report.title });
  usd += text.usd;
  const check = (t: typeof text) => checkPackage({ title: t.title, thumbnailText: thumbText, thumbnailConcept: th?.concept ?? "", hook: t.hook, summary: t.summary, pinnedComment: t.pinnedComment, narration: o.script.segments.map((s) => s.text).join(" ") }).catch(() => ({ ok: true, issues: [] as string[], quotes: [] as string[], usd: 0 }));
  let chk = await check(text);
  usd += chk.usd;
  // One rewrite when the description, tags or comment promise what the film does not deliver.
  if (!chk.ok) {
    log(`  package check: ${chk.issues.slice(0, 2).join("; ")} — rewriting the text once`);
    const again = await writePublishingText({ channel: o.channel, references: ex.packaging ?? [], script: o.script, facts: o.facts, title: report.title, fix: chk.issues });
    usd += again.usd;
    const chk2 = await check(again);
    usd += chk2.usd;
    if (chk2.issues.length <= chk.issues.length) {
      text = again;
      chk = chk2;
    }
    if (!chk.ok) {
      // H28: still promising what the film does not say — remove the sentences that carry those claims.
      const h = withoutClaims(text.hook, chk.quotes), sm = withoutClaims(text.summary, chk.quotes), pc = withoutClaims(text.pinnedComment, chk.quotes);
      if (h.removed + sm.removed + pc.removed) {
        text = { ...text, hook: h.text || text.hook, summary: sm.text, pinnedComment: pc.text || text.pinnedComment, checks: [...text.checks, `${h.removed + sm.removed + pc.removed} sentence(s) removed: claims the narration does not make`] };
        const chk3 = await check(text);
        usd += chk3.usd;
        chk = chk3;
      }
      if (!chk.ok) log(`  ! package check still: ${chk.issues.slice(0, 3).join("; ")}`);
    }
  }
  const thumbCredits = [...new Set([...(th?.slots ?? []), ...(cv?.slots ?? [])])].map((k) => tools.pics[k]?.credit).filter((c): c is ThumbCredit => Boolean(c));
  await writeFiles(o, text, thumbCredits);
  await atomic(
    path.join(o.jobDir, "publish.json"),
    JSON.stringify(
      {
        title: text.title,
        titleCandidates: report.titles,
        hook: text.hook,
        summary: text.summary,
        tags: text.tags,
        hashtags: text.hashtags,
        pinnedComment: text.pinnedComment,
        // build list 5, item 4: packaging's craft measures (words on the thumbnail, what the title promises, realness)
        craft: report.craft ?? null,
        thumbnail: th ? { concept: th.concept, render: th.id, words: th.words ?? null, ...(th.noWordsBecause ? { noWordsBecause: th.noWordsBecause } : {}), renders: report.renders, passedImposterTest: th.imposter ? !th.imposter.spotted : null, spottedConfidence: th.imposter?.confidence ?? null, tells: th.imposter?.tells ?? [], outsideBand: th.issues, colourfulness: Math.round(th.colourfulness), pictures: th.slots.map((k) => ({ slot: k, depicts: tools.pics[k]?.depicts, ...tools.pics[k]?.credit })), generatedImagery: false } : null,
        cover: cv ? { concept: cv.concept, render: cv.id, words: cv.words ?? null, outsideBand: cv.issues, colourfulness: Math.round(cv.colourfulness), pictures: cv.slots.map((k) => ({ slot: k, depicts: tools.pics[k]?.depicts, ...tools.pics[k]?.credit })), generatedImagery: false } : null,
        agent: { accepted: report.pass, ...report.agent, seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round(usd * 1000) / 1000 },
        checks: [...text.checks, ...(chk.ok ? ["package matches the film"] : chk.issues.map((i) => `ISSUE: ${i}`))],
      },
      null,
      2,
    ) + "\n",
  );
  return { thumbnailPath: th && existsSync(thumbnailPath) ? thumbnailPath : null, usd };
}

/** Description, tags and pinned comment files (shared by both paths). */
async function writeFiles(o: PublishOptions, text: { hook: string; summary: string; tags: string[]; hashtags: string[]; pinnedComment: string }, thumbCredits: ThumbCredit[]) {
  const chapters: Array<{ at: number; title: string }> = [];
  let prev: string | undefined;
  for (const sg of o.script.segments) {
    if (sg.chapter && sg.chapter !== prev) chapters.push({ at: chapters.length ? sg.startS : 0, title: sg.chapter });
    prev = sg.chapter ?? prev;
  }
  const used = new Set(o.script.segments.flatMap((sg) => sg.claims.map((c) => c.sourceUrl)));
  const sources = o.facts.sources.filter((s) => used.has(s.url));
  const fairUseHolders = [...o.resolution.media.filter((m) => m.origin === "press" && m.fairUse?.channel).map((m) => m.fairUse!.channel!.replace(/^www\./, "")), ...thumbCredits.filter((c) => c.origin === "press" && c.fairUse).map((c) => (c.fairUse!.match(/\(([^)]+)\)$/)?.[1] ?? "").replace(/^www\./, ""))];
  const press = [...new Set(fairUseHolders)].filter((c) => c && !/^(youtube|wikipedia|web)$/i.test(c));
  const credit = creditLines(o.resolution.media);
  // Thumbnail pictures whose licence asks for a credit (CC BY, BY-SA…) are credited like the film's.
  const thumbItems = [...new Set(thumbCredits.filter((c) => c.origin !== "press" && c.attributionRequired && c.attributionText).map((c) => `Thumbnail: ${c.attributionText!.replace(/\s*\(optional courtesy credit\)/i, "")}${c.sourceUrl ? ` — ${c.sourceUrl}` : ""}`))];
  const items = [...credit.items, ...thumbItems];
  const description = [
    text.hook,
    "",
    text.summary,
    "",
    ...(chapters.length > 1 ? ["Chapters:", ...chapters.map((c) => `${ts(c.at)} ${c.title}`), ""] : []),
    ...(sources.length ? ["Sources:", ...sources.map((s) => `- ${s.title ? `${s.title}: ` : ""}${s.url}`), ""] : []),
    ...(press.length ? [`This video includes brief excerpts and images from ${press.slice(0, 12).join(", ")} for the purposes of commentary, criticism and news reporting (fair use). All rights remain with their owners.`, ""] : []),
    ...(credit.sources.length ? ["Footage, pictures and sound:", ...credit.sources.map((c) => `- ${c}`), ""] : []),
    ...(items.length ? ["Credits:", ...items.map((c) => `- ${c}`), ""] : []),
    text.hashtags.join(" "),
    "",
  ].join("\n").slice(0, 4900);
  await atomic(path.join(o.jobDir, "youtube-description.txt"), description);
  await atomic(path.join(o.jobDir, "youtube-tags.txt"), text.tags.join(", ") + "\n");
  await atomic(path.join(o.jobDir, "pinned-comment.txt"), text.pinnedComment + "\n");
}
