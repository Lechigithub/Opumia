/**
 * Publishing package for a film: thumbnail (real cutouts on the film's colour world), title, description, tags,
 * hashtags and a pinned comment — learned from the reference channel's own packaging (data/exemplars), checked
 * against the film. Writes into the job folder:
 *   thumbnail.jpg  publish.json  youtube-description.txt  youtube-tags.txt  pinned-comment.txt
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkPackage, designThumbnail, isUsable, learnThumbnailGrammar, thumbnailImposter, writePublishingText, type ThumbnailGrammar, type ThumbSlot } from "@opumia/agents";
import type { FactSheet, FilmDesignSystem, LibraryIndex, ResolutionReport, Storyboard, TimedScript } from "@opumia/contracts";
import { renderThumbnailScene } from "@opumia/motion-engine";
import { closeBrowser, visionCheck, wikipediaImages } from "@opumia/resolver";
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
  let usd = 0;
  const exDir = path.join(o.data, "exemplars", o.channel);
  const ex = await readJson<ExemplarIndex>(path.join(exDir, "index.json"));
  if (!ex?.thumbs.length || !ex.packaging?.length) {
    log(`  ! no reference packaging for ${o.channel} (run \`opumia build-exemplars --channel ${o.channel}\`): package skipped`);
    return { thumbnailPath: null, usd };
  }

  // ---- What the channel's thumbnails do (learned once).
  const gFile = path.join(o.data, "thumbnail-grammar", `${o.channel}.json`);
  let grammar = await readJson<ThumbnailGrammar & { count: number }>(gFile);
  const refThumbs = ex.thumbs.map((t) => ({ path: path.join(exDir, t.file), title: t.title, views: t.views })).sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  if (!grammar || grammar.count !== refThumbs.length) {
    log(`  thumbnail grammar: studying ${Math.min(30, refThumbs.length)} reference thumbnails…`);
    const g = await learnThumbnailGrammar({ channel: o.channel, thumbs: refThumbs });
    usd += g.usd;
    grammar = { ...g.grammar, count: refThumbs.length };
    await atomic(gFile, JSON.stringify(grammar, null, 1) + "\n");
  }

  // ---- Real pictures for the thumbnail: the film's verified stills, the main subjects' photos and logos,
  // and library object cutouts that match the story. Photos are cut out from their backgrounds.
  const tdir = path.join(o.publicDir, "thumb");
  await mkdir(tdir, { recursive: true });
  const cands: Array<{ file: string; depicts: string }> = [];
  const seen = new Set<string>();
  for (const m of o.resolution.media) {
    if (m.kind !== "image" || m.origin !== "press" || m.provider === "web" || seen.has(m.ref)) continue;
    seen.add(m.ref);
    cands.push({ file: m.localPath, depicts: (m.depicts ?? m.query).replace(/, referred to as.*$/, "") });
  }
  // The most-named subjects of the film that have no picture yet.
  const counts = new Map<string, { n: number; type: string }>();
  for (const s of o.board.shots) for (const e of s.entities ?? []) if (["person", "company", "product"].includes(e.type)) counts.set(e.name, { n: (counts.get(e.name)?.n ?? 0) + 1, type: e.type });
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3);
  for (const [name, v] of top) {
    if (cands.some((c) => c.depicts.toLowerCase().includes(name.toLowerCase().split(" ").at(-1)!))) continue;
    const found = await wikipediaImages({ name, type: v.type }, path.join(o.jobDir, "downloads", "press"), 2).catch(() => []);
    const ok = found.length ? await visionCheck(found.map((c) => ({ frameFile: c.frameFile, depicts: c.depicts, line: o.facts.summary }))).catch(() => []) : [];
    found.forEach((c, k) => {
      if (ok[k]?.shows && (ok[k]?.quality ?? 0) >= 5 && !seen.has(c.externalId)) (seen.add(c.externalId), cands.push({ file: c.localFile, depicts: c.depicts }));
    });
  }
  await closeBrowser();
  // Library object cutouts whose name or tags appear in the story.
  const storyWords = new Set(`${o.facts.topic} ${o.facts.summary} ${o.script.segments.map((s) => s.text).join(" ")}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
  const objs = o.index.assets
    .filter((a) => isUsable(a) && a.category === "objects" && a.ext === "png")
    .map((a) => ({ a, hit: [...new Set(`${a.title ?? ""} ${a.tags.join(" ")}`.toLowerCase().split(/[^a-z]+/))].filter((w) => w.length > 3 && storyWords.has(w)).length }))
    .filter((x) => x.hit > 0)
    .sort((x, y) => y.hit - x.hit || x.a.id.localeCompare(y.a.id))
    .slice(0, 4);
  for (const x of objs) cands.push({ file: path.join(o.library, x.a.relPath), depicts: `library object: ${x.a.title ?? x.a.relPath}` });

  const slots: ThumbSlot[] = [];
  const slotFiles: Record<string, string> = {};
  for (const c of cands.slice(0, 8)) {
    const k = slots.length;
    const png = /\.png$/i.test(c.file);
    const out = path.join(tdir, `slot_${k}.png`);
    try {
      let aspect = 1;
      let kind: ThumbSlot["kind"] = "cutout";
      if (png) {
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", c.file, "-vf", "scale='min(1400,iw)':-2", "-frames:v", "1", "-update", "1", out]);
        const pr = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]);
        const [w, h] = pr.stdout.trim().split(",").map(Number) as [number, number];
        aspect = w / Math.max(1, h);
      } else {
        const cut = await removeBackground(c.file, out, o.data);
        aspect = cut.width / Math.max(1, cut.height);
        // No clear subject (a building, a landscape): keep the photo whole.
        if (cut.coverage > 0.92 || cut.coverage < 0.06 || cut.confidence < 0.8) {
          await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", c.file, "-vf", "scale='min(1400,iw)':-2", "-frames:v", "1", "-update", "1", out]);
          kind = "photo";
        }
      }
      slots.push({ slot: k, depicts: c.depicts, kind, aspect });
      slotFiles[String(k)] = `thumb/slot_${k}.png`;
    } catch {
      /* unreadable picture: skipped */
    }
  }
  log(`  thumbnail: ${slots.length} real picture(s) ready — ${slots.map((s) => `${s.depicts.slice(0, 28)} (${s.kind})`).join("; ")}`);

  // ---- Text package first (the thumbnail must not repeat the title).
  const text = await writePublishingText({ channel: o.channel, references: ex.packaging, script: o.script, facts: o.facts });
  usd += text.usd;
  log(`  title: "${text.title}" (${text.titleCandidates.length} candidates) · ${text.tags.length} tags · ${text.hashtags.join(" ")}`);

  // ---- Thumbnail: design → render → imposter test against real thumbnails → one revision.
  const concepts = (await readJson<Array<{ job: string; concept: string }>>(path.join(o.data, "thumbnail-concepts.json"))) ?? [];
  const exemplarThumbs = refThumbs.slice(0, 6).map((t) => t.path);
  const realForTest = refThumbs.slice(6, 14).map((t) => t.path);
  const band = ex.thumbs.map((t) => t.look.colourfulness).sort((a, b) => a - b);
  const colourFloor = band[Math.floor(band.length * 0.25)] ?? 60;
  const thumbnailPath = path.join(o.jobDir, "thumbnail.jpg");
  let best: { concept: string; spec: unknown; spotted: boolean; confidence: number; colourfulness: number; tells: string[]; file: string } | null = null;
  let issues: string[] | undefined;
  let previous: string | undefined;
  for (let round = 0; round < 2; round++) {
    const d = await designThumbnail({ channel: o.channel, grammar, exemplars: exemplarThumbs, title: text.title, facts: o.facts, design: o.design, slots, avoid: concepts.filter((c) => c.job !== o.job).slice(-6).map((c) => c.concept), ...(issues ? { issues } : {}), ...(previous ? { previous } : {}) });
    usd += d.usd;
    const file = path.join(o.jobDir, `thumbnail.r${round}.jpg`);
    await renderThumbnailScene({ publicDir: o.publicDir, spec: d.spec, slots: slotFiles, design: d.design, out: file, log: () => {} });
    const look = await measureLook(file, { fps: 1 });
    const test = await thumbnailImposter({ channel: o.channel, candidate: file, real: realForTest.filter((_, i) => i % 2 === round % 2).slice(0, 4), seed: round * 3 + 1 });
    usd += test.usd;
    const tells = [...test.tells, ...(look.colourfulness < colourFloor ? [`too dull: colourfulness ${Math.round(look.colourfulness)} vs the channel's ${Math.round(colourFloor)}+`] : [])];
    log(`  thumbnail r${round + 1}: "${d.concept.slice(0, 90)}" — ${test.spotted ? `picked out as the fake (confidence ${test.confidence.toFixed(2)})` : "passed as real"}; colourfulness ${Math.round(look.colourfulness)} (channel ≥ ${Math.round(colourFloor)})`);
    const cur = { concept: d.concept, spec: d.spec, spotted: test.spotted, confidence: test.spotted ? test.confidence : 0, colourfulness: look.colourfulness, tells, file };
    if (!best || cur.confidence < best.confidence || (cur.confidence === best.confidence && cur.colourfulness > best.colourfulness)) best = cur;
    if (!test.spotted && look.colourfulness >= colourFloor) break;
    issues = tells;
    previous = d.concept;
  }
  if (best) {
    await writeFile(thumbnailPath, await readFile(best.file));
    await atomic(path.join(o.data, "thumbnail-concepts.json"), JSON.stringify([...concepts.filter((c) => c.job !== o.job), { job: o.job, concept: best.concept }].slice(-40), null, 1) + "\n");
  }

  // ---- Does the package promise what the film delivers?
  const specEls = ((best?.spec as { elements?: Array<{ type: string; text?: string }> } | undefined)?.elements ?? []).filter((e) => e.type === "text").map((e) => e.text ?? "");
  const chk = await checkPackage({ title: text.title, thumbnailText: specEls, thumbnailConcept: best?.concept ?? "", hook: text.hook, summary: text.summary, pinnedComment: text.pinnedComment, narration: o.script.segments.map((s) => s.text).join(" ") }).catch(() => ({ ok: true, issues: [] as string[], usd: 0 }));
  usd += chk.usd;
  if (!chk.ok) log(`  ! package check: ${chk.issues.slice(0, 3).join("; ")}`);

  // ---- Files.
  const chapters: Array<{ at: number; title: string }> = [];
  let prev: string | undefined;
  for (const sg of o.script.segments) {
    if (sg.chapter && sg.chapter !== prev) chapters.push({ at: chapters.length ? sg.startS : 0, title: sg.chapter });
    prev = sg.chapter ?? prev;
  }
  const used = new Set(o.script.segments.flatMap((sg) => sg.claims.map((c) => c.sourceUrl)));
  const sources = o.facts.sources.filter((s) => used.has(s.url));
  // Named rights holders only: the broadcaster or publisher of each excerpt (not the platform it was found on).
  const press = [...new Set(o.resolution.media.filter((m) => m.origin === "press" && m.fairUse?.channel).map((m) => m.fairUse!.channel!.replace(/^www\./, "")))].filter((c) => !/^(youtube|wikipedia|web)$/i.test(c));
  const credit = creditLines(o.resolution.media);
  const description = [
    text.hook,
    "",
    text.summary,
    "",
    ...(chapters.length > 1 ? ["Chapters:", ...chapters.map((c) => `${ts(c.at)} ${c.title}`), ""] : []),
    ...(sources.length ? ["Sources:", ...sources.map((s) => `- ${s.title ? `${s.title}: ` : ""}${s.url}`), ""] : []),
    ...(press.length ? [`This video includes brief excerpts and images from ${press.slice(0, 12).join(", ")} for the purposes of commentary, criticism and news reporting (fair use). All rights remain with their owners.`, ""] : []),
    ...(credit.sources.length ? ["Footage, pictures and sound:", ...credit.sources.map((c) => `- ${c}`), ""] : []),
    ...(credit.items.length ? ["Credits:", ...credit.items.map((c) => `- ${c}`), ""] : []),
    text.hashtags.join(" "),
    "",
  ].join("\n").slice(0, 4900);
  await atomic(path.join(o.jobDir, "youtube-description.txt"), description);
  await atomic(path.join(o.jobDir, "youtube-tags.txt"), text.tags.join(", ") + "\n");
  await atomic(path.join(o.jobDir, "pinned-comment.txt"), text.pinnedComment + "\n");
  await atomic(path.join(o.jobDir, "publish.json"), JSON.stringify({ title: text.title, titleCandidates: text.titleCandidates, hook: text.hook, summary: text.summary, tags: text.tags, hashtags: text.hashtags, pinnedComment: text.pinnedComment, thumbnail: best ? { concept: best.concept, passedImposterTest: !best.spotted, spottedConfidence: best.confidence, colourfulness: Math.round(best.colourfulness), tells: best.tells } : null, checks: [...text.checks, ...(chk.ok ? ["package matches the film"] : chk.issues.map((i) => `ISSUE: ${i}`))] }, null, 2) + "\n");
  return { thumbnailPath: best && existsSync(thumbnailPath) ? thumbnailPath : null, usd };
}
