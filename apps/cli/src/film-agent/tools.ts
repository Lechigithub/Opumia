// film-tools: the commands the film agent runs from its shell (the hand-film tools of 2026-11-25/26, packaged).
// Every command works inside the film's workspace (FILM_JOB) and records what it brings in (credits.json,
// fair-use.json), so the gate can prove every picture's source. No Claude API calls here except where noted.
//   npx tsx apps/cli/src/film-agent/tools.ts <command> … (the runner puts a `film-tools` wrapper on the agent's PATH)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import path from "node:path";
import { frameOf } from "./plan.js";

const ROOT = process.env.OPUMIA_ROOT ?? process.cwd();
// the agents' shell carries no stock or voice keys: film-tools loads them into its own process (the platform's loader)
{ const { loadKeys } = await import("../keys.js"); loadKeys(ROOT); }
const JOB = process.env.FILM_JOB ? path.resolve(process.env.FILM_JOB) : process.cwd();
const CHANNEL = process.env.FILM_CHANNEL ?? "magnates-media";
// a scene builder (parallel film agent) works in scene mode: its downloads, credits and names are its own, so builders
// running at the same time never write the same file
const SCENE = process.env.FILM_SCENE && /^s\d{2}$/.test(process.env.FILM_SCENE) ? process.env.FILM_SCENE : undefined;
const WS = SCENE ? path.join(JOB, "downloads", SCENE) : JOB;
const FR = frameOf(JOB);
const nm = (name: string) => (SCENE && !name.startsWith(`${SCENE}_`) ? `${SCENE}_${name}` : name);
const ledger = (kind: "credits" | "fair-use") => (SCENE ? path.join(JOB, kind, `${SCENE}.json`) : path.join(JOB, `${kind}.json`));
const REF_DIR = path.join(ROOT, "Reference", "MagnatesMedia");
const PY = process.env.OPUMIA_PY ?? path.join(process.env.HOME ?? "", "lechi_tts", "venv", "bin", "python");
const [cmd, ...args] = process.argv.slice(2);
const flag = (k: string) => args.includes(k);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const pos = () => args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && !["--film"].includes(args[i - 1]!)));
const sh = (bin: string, a: string[], o: { env?: Record<string, string>; quiet?: boolean } = {}) => {
  const r = spawnSync(bin, a, { cwd: ROOT, env: { ...process.env, ...(o.env ?? {}) }, encoding: "utf8", maxBuffer: 1 << 28 });
  if (!o.quiet) process.stdout.write((r.stdout ?? "") + (r.status ? (r.stderr ?? "").slice(-3000) : ""));
  return r;
};
const tsx = (script: string, a: string[], env: Record<string, string> = {}) => sh("npx", ["tsx", path.join(ROOT, script), ...a], { env });
const ensure = (d: string) => (mkdirSync(d, { recursive: true }), d);
const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
const credit = (e: { file: string; kind: string; source: string; url?: string; license: string; note?: string }) => {
  const f = ledger("credits");
  mkdirSync(path.dirname(f), { recursive: true });
  const all = jread<Array<typeof e>>(f, []).filter((x) => x.file !== e.file);
  writeFileSync(f, JSON.stringify([...all, e], null, 1));
};
const fairUse = (e: { file: string; kind: "press" | "film"; video: string; title: string; channel: string; inS: number; seconds: number }) => {
  const f = ledger("fair-use");
  mkdirSync(path.dirname(f), { recursive: true });
  const all = jread<Array<typeof e>>(f, []).filter((x) => x.file !== e.file);
  writeFileSync(f, JSON.stringify([...all, e], null, 1));
};
/** The no-repeats register: what the OTHER scenes have already brought in (their ledgers). */
const others = <T>(kind: "credits" | "fair-use"): T[] => {
  const dir = path.join(JOB, kind);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== `${SCENE}.json`).flatMap((f) => jread<T[]>(path.join(dir, f), []).map((x) => ({ ...x, scene: f.replace(/\.json$/, "") }))) : [];
};
/** The referee's held-back films (data/referee/<channel>.json): never shown to an agent, so the referee's test stays
 *  clean. Reference folders are "YYYYMMDD - title", film ids "MM-YYYYMMDD". */
const HELD = new Set((jread<{ holdout?: string[] }>(path.join(ROOT, "data", "referee", `${CHANNEL}.json`), {}).holdout ?? []).map((id) => id.replace(/^[A-Z]+-/, "")));
export const refFilms = (): string[] => (existsSync(REF_DIR) ? readdirSync(REF_DIR).filter((d) => /^\d{8} - /.test(d) && !HELD.has(d.slice(0, 8))).sort() : []);
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim() || 0);

/** What the channel put on screen under lines like this one: its labelled shots, narrowed by shared words (free), then
 *  the nearest in meaning and role (one small Haiku call); a frame of each, on one sheet, and how each was built. */
async function refSimilar(line: string, n: number) {
  if (!line.trim()) { console.log('film-tools ref similar "<a line of your narration>"'); return; }
  const stop = new Set("the a an and or of to in on for with that this was were is are it its his her their they he she we you i at by from as be been but not so then than into about over after before".split(" "));
  const toks = (s: string) => s.toLowerCase().replace(/[^a-z0-9$%€£ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const q = new Set(toks(line));
  const shots: Array<{ film: string; t0: number; t1: number; line: string; picture: string; overlay: string; motion: number; textArea: number; transitionIn: string }> = [];
  const allowed = new Set(refFilms().map((f) => f.slice(0, 8)));
  for (const l of readFileSync(path.join(ROOT, "data", "reference-index", "shots.jsonl"), "utf8").split("\n")) {
    if (!l.includes(`"channel":"${CHANNEL}"`)) continue;
    const s = JSON.parse(l) as (typeof shots)[number] & { channel: string };
    if (allowed.has(s.film.replace(/^[A-Z]+-/, "")) && s.line && s.line.split(" ").length >= 4) shots.push(s);
  }
  const df = new Map<string, number>();
  for (const s of shots) for (const w of new Set(toks(s.line))) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = shots.map((s, i) => ({ i, v: [...new Set(toks(s.line))].reduce((t, w) => t + (q.has(w) ? Math.log(shots.length / (df.get(w) ?? 1)) : 0), 0) })).sort((a, b) => b.v - a.v);
  // the word match narrows; a spread of story roles is kept even when few words match
  const pool = [...scored.slice(0, 45), ...scored.slice(45).filter((_, k) => k % Math.max(1, Math.floor(scored.length / 15)) === 0).slice(0, 15)].map((x) => shots[x.i]!);
  const { nearestByMeaning } = await import("@opumia/agents");
  const pick = await nearestByMeaning(`a documentary narration line: "${line}"`, pool.map((s) => `"${s.line}" → shown as ${s.picture}${s.overlay !== "none" ? ` + ${s.overlay}` : ""}`), Math.min(n, pool.length), "real shot").catch(() => pool.slice(0, n).map((_, k) => k));
  const out = ensure(path.join(WS, "downloads", "ref-similar"));
  const tag = createHashShort(line);
  const frames: string[] = [];
  for (const [k, idx] of pick.entries()) {
    const s = pool[idx]!;
    const folder = refFilms().find((f) => f.startsWith(s.film.replace(/^[A-Z]+-/, "")));
    const mp4 = folder ? readdirSync(path.join(REF_DIR, folder)).find((f) => f.endsWith(".mp4")) : undefined;
    const fr = path.join(out, `${tag}_${k + 1}.jpg`);
    if (folder && mp4 && !existsSync(fr)) spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", ((s.t0 + s.t1) / 2).toFixed(2), "-i", path.join(REF_DIR, folder, mp4), "-frames:v", "1", "-vf", "scale=640:-2", fr]);
    if (existsSync(fr)) frames.push(fr);
    console.log(`${k + 1}. ${folder ?? s.film} at ${s.t0.toFixed(1)}–${s.t1.toFixed(1)} s — "${s.line.slice(0, 140)}"\n   shown as: ${s.picture}${s.overlay !== "none" ? ` + ${s.overlay}` : ", nothing laid over it"}; motion ${Math.round(s.motion)}; words on ${Math.round(s.textArea * 100)} % of the frame; enters by ${s.transitionIn}\n   frame: ${fr}`);
  }
  if (frames.length > 1) {
    const sheet = path.join(out, `${tag}_sheet.jpg`);
    spawnSync("ffmpeg", ["-v", "error", "-y", ...frames.flatMap((f) => ["-i", f]), "-filter_complex", `${frames.map((_, k) => `[${k}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[f${k}]`).join(";")};${frames.map((_, k) => `[f${k}]`).join("")}xstack=inputs=${frames.length}:layout=${frames.map((_, k) => `${(k % 3) * 640}_${Math.floor(k / 3) * 360}`).join("|")}`, "-frames:v", "1", sheet]);
    if (existsSync(sheet)) console.log(`sheet (in the order above, 3 per row): ${sheet}`);
  }
  console.log("Read the sheet; build your scene the way the channel did it, with this film's own material. Watch a moment with film-tools ref watch.");
}
const createHashShort = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);

/** Real examples of a technique from the channel's craft inventory: its definition and the stretches where it is seen. */
function refTechnique(q: string, n: number) {
  const dir = path.join(ROOT, "data", "technique-inventory", CHANNEL);
  const tax = jread<Array<{ id: string; name: string; category: string; definition: string; seeIn?: string }>>(path.join(dir, "taxonomy.json"), []);
  const rows = jread<Array<{ film: string; fromS: number; words: string; sheet: string; seen: Record<string, number> }>>(path.join(dir, "rows.json"), []);
  if (!q.trim()) { console.log(`${tax.length} techniques:\n${tax.map((t) => `${t.id} — ${t.name} (${t.category})`).join("\n")}`); return; }
  const qt = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const best = tax.map((t) => ({ t, v: t.id === q ? 99 : qt.filter((w) => `${t.id} ${t.name} ${t.definition}`.toLowerCase().includes(w)).length })).sort((a, b) => b.v - a.v).filter((x) => x.v > 0).slice(0, 3);
  if (!best.length) { console.log(`no technique matches "${q}" — film-tools ref technique (no words) lists them all`); return; }
  const allowed = new Set(refFilms().map((f) => f.slice(0, 8)));
  for (const { t } of best) {
    const ex = rows.filter((r) => (r.seen[t.id] ?? 0) > 0 && allowed.has(r.film.replace(/^[A-Z]+-/, ""))).sort((a, b) => (b.seen[t.id] ?? 0) - (a.seen[t.id] ?? 0)).slice(0, n);
    console.log(`\n${t.id} — ${t.name} (${t.category})\n  ${t.definition}${t.seeIn ? `\n  look for: ${t.seeIn}` : ""}\n  seen in ${rows.filter((r) => (r.seen[t.id] ?? 0) > 0).length} of ${rows.length} measured stretches of the channel`);
    for (const r of ex) console.log(`  - ${refFilms().find((f) => f.startsWith(r.film.replace(/^[A-Z]+-/, ""))) ?? r.film} at ${r.fromS.toFixed(0)} s: "${r.words.slice(0, 100)}…"\n    sheet: ${r.sheet}  (watch it: film-tools ref watch "${r.film.replace(/^[A-Z]+-/, "")}" ${Math.floor(r.fromS)} ${Math.floor(r.fromS) + 10} --fps 12)`);
  }
}

async function main() {
  switch (cmd) {
    case "help": case undefined: {
      console.log(readFileSync(path.join(ROOT, "apps/cli/src/film-agent/TOOLS.md"), "utf8"));
      return;
    }
    // ---- the reference
    case "ref": {
      const films = refFilms();
      if (args[0] === "list") { films.forEach((f) => console.log(f)); return; }
      if (args[0] === "similar") { await refSimilar(args.slice(1).filter((a, i, xs) => !a.startsWith("--") && xs[i - 1] !== "--n").join(" "), Number(opt("--n") ?? 6)); return; }
      if (args[0] === "technique") { refTechnique(args.slice(1).filter((a, i, xs) => !a.startsWith("--") && xs[i - 1] !== "--n").join(" "), Number(opt("--n") ?? 4)); return; }
      if (args[0] === "watch") {
        const [, q, from = "0", to = "20"] = args;
        const film = films.find((f) => f.toLowerCase().includes(String(q).toLowerCase()));
        if (!film) { console.log(`no reference film matching "${q}" (film-tools ref list)`); return; }
        const mp4 = readdirSync(path.join(REF_DIR, film)).find((f) => f.endsWith(".mp4"))!;
        const out = ensure(path.join(JOB, "watch", `ref-${film.slice(0, 8)}-${from}-${to}`));
        tsx("apps/cli/src/dev/hand/watch.ts", [out, from, to, `ref=${path.join(REF_DIR, film, mp4)}`], { WATCH_FPS: opt("--fps") ?? "6" });
        console.log(`sheets: ${readdirSync(out).filter((f) => f.includes("_v_")).map((f) => path.join(out, f)).join("\n")}`);
        return;
      }
      console.log("film-tools ref list | ref watch <name part> <fromS> <toS> [--fps 6|12] | ref similar \"<a line of your narration>\" [--n 6] | ref technique \"<technique name or words>\" [--n 4]");
      return;
    }
    case "watch": {
      const [file, from = "0", to = "20"] = args;
      const out = ensure(path.join(JOB, "watch", `ours-${from}-${to}`));
      const labels = [`ours=${path.resolve(JOB, file!)}`];
      const r = opt("--ref");
      if (r) {
        const film = refFilms().find((f) => f.toLowerCase().includes(r.toLowerCase()));
        if (film) labels.push(`ref=${path.join(REF_DIR, film, readdirSync(path.join(REF_DIR, film)).find((f) => f.endsWith(".mp4"))!)}@${opt("--ref-from") ?? "0"}`);
      }
      tsx("apps/cli/src/dev/hand/watch.ts", [out, from, to, ...labels], { WATCH_FPS: opt("--fps") ?? "12" });
      console.log(`sheets in ${out}: ${readdirSync(out).filter((f) => f.includes("_v_")).join(", ")}`);
      return;
    }
    // ---- real news and film scenes
    case "press": {
      const q = args.filter((a) => !a.startsWith("--"))[0]!;
      const film = flag("--film");
      const n = Number(opt("--n") ?? 8);
      const { pressTitleOk, isNewsChannel } = await import("@opumia/resolver");
      const people = (opt("--person") ?? "").split(",").filter(Boolean);
      const world = (opt("--world") ?? "").split(",").filter(Boolean);
      const j = JSON.parse(execFileSync("yt-dlp", ["--no-warnings", "--flat-playlist", "-J", `ytsearch${n + 4}:${q}`], { maxBuffer: 1 << 26 }).toString()) as { entries: Array<{ id: string; title: string; channel?: string; uploader?: string; duration?: number }> };
      const out = ensure(path.join(WS, "downloads", "news"));
      let k = 0;
      for (const e of j.entries) {
        const ch = `${e.channel ?? e.uploader ?? ""}`;
        const ok = film ? /\b(movie|film|scene|clip)\b/i.test(e.title) && !/\b(documentary|explained|essay|reaction|trailer|review)\b/i.test(e.title)
          : people.length ? people.some((p) => pressTitleOk(e, { name: p, type: "person" }, world))
          // a newsroom's report may not name the company in its title ("Do You Need a $400 Juicer?"): it passes when
          // the title shares a word with the search; everything else must pass the press filter
          : [q.split(" ").slice(0, 2).join(" "), ...world].some((w) => pressTitleOk(e, { name: w, type: "company" }, world)) || (isNewsChannel(ch) && !/\b(reaction|reacts|meme|parody)\b/i.test(e.title) && q.toLowerCase().split(/\W+/).filter((w) => w.length > 3).some((w) => e.title.toLowerCase().includes(w.replace(/o$/, ""))));
        if (!ok) continue;
        if (++k > n) break;
        // a low-resolution copy of the first minutes, tiled one frame per 2 s, so you can SEE where the moment is
        const lo = path.join(out, `lo_${e.id}.mp4`), sheet = path.join(out, `strip_${e.id}.jpg`);
        if (!existsSync(lo)) sh("yt-dlp", ["-q", "--no-warnings", "-f", "bv*[height<=360][ext=mp4]/bv*[height<=360]", "--download-sections", "*0-240", "-o", lo, `https://www.youtube.com/watch?v=${e.id}`], { quiet: true });
        if (existsSync(lo) && !existsSync(sheet)) sh("ffmpeg", ["-v", "error", "-y", "-i", lo, "-vf", "fps=1/2,scale=200:-1,tile=10x12", "-frames:v", "1", sheet], { quiet: true });
        console.log(`${e.id} | ${isNewsChannel(ch) ? "[news] " : ""}${ch} | ${Math.round(e.duration ?? 0)} s | ${e.title}${existsSync(sheet) ? `\n   strip (tile i = second 2i): ${sheet}` : ""}`);
      }
      if (!k) console.log("nothing passed the press filters — change the words (a news library's words: the company, the person's role, the event), or try --film for performed scenes");
      return;
    }
    case "clip": {
      const [id, start, len, rawName] = args.filter((a) => !a.startsWith("--") && a !== opt("--crop"));
      const name = nm(rawName!);
      const seconds = Math.min(8.5, Number(len));
      // the same moment of one video may not appear in two scenes (another moment of it may)
      const taken = others<{ video: string; inS: number; seconds: number; scene: string }>("fair-use").find((x) => x.video.includes(String(id)) && Number(start) < x.inS + x.seconds && x.inS < Number(start) + seconds);
      if (taken) { console.log(`${taken.scene} already uses ${id} at ${taken.inS}–${(taken.inS + taken.seconds).toFixed(1)} s — choose another moment (or another video): the same picture twice reads as a repeat`); process.exitCode = 1; return; }
      // a moment a recent film of ours showed is on cooldown (another moment of the same video is not)
      { const { recentPictures, pressMomentUsed } = await import("./register.js"); const hit = pressMomentUsed(recentPictures(ROOT, JOB), String(id), Number(start)); if (hit) { console.log(`a recent film of ours showed this moment (${hit}) — choose another moment or another video`); process.exitCode = 1; return; } }
      if (Number(len) > 8.5) console.log("note: clips are at most 8.5 s (the channel's practice) — cut to 8.5");
      const crop = opt("--crop") ?? "crop=iw:ih:0:0";
      const parts = ensure(path.join(WS, "downloads", "news", "parts")), part = path.join(parts, `${name}_${id}_${start}_${seconds}.mp4`); // a new moment is a new download
      const s = Number(start);
      sh("yt-dlp", ["-q", "--no-warnings", "--no-playlist", "-f", "bv*[height<=1080][ext=mp4]/bv*[height<=1080]", "--download-sections", `*${s}-${s + seconds + 1}`, "-o", part, `https://www.youtube.com/watch?v=${id}`]);
      const outF = path.join(ensure(path.join(JOB, "public", "v")), `${name}.mp4`);
      sh("ffmpeg", ["-v", "error", "-y", "-i", part, "-t", String(seconds), "-an", "-vf", `${crop},scale=${FR.w}:${FR.h}:force_original_aspect_ratio=increase,crop=${FR.w}:${FR.h},fps=24,format=yuv420p`, "-c:v", "libx264", "-crf", "16", outF]);
      const meta = spawnSync("yt-dlp", ["--no-warnings", "--print", "%(title)s|%(channel)s", `https://www.youtube.com/watch?v=${id}`], { encoding: "utf8" }).stdout.trim().split("|");
      fairUse({ file: `v/${name}.mp4`, kind: flag("--film") ? "film" : "press", video: `https://www.youtube.com/watch?v=${id}`, title: meta[0] ?? "", channel: meta[1] ?? "", inS: s, seconds });
      credit({ file: `v/${name}.mp4`, kind: flag("--film") ? "film clip" : "press clip", source: meta[1] ?? "YouTube", url: `https://www.youtube.com/watch?v=${id}&t=${s}s`, license: "Fair use (short muted excerpt under commentary)" });
      console.log(existsSync(outF) ? `public/v/${name}.mp4 (${seconds} s, muted, ${FR.w}×${FR.h} 24 fps) — logged in fair-use.json; look at it before you use it` : "clip failed");
      return;
    }
    case "screenshot": {
      const [url, rawName] = args;
      const name = nm(rawName!);
      const { screenshotPage } = await import("@opumia/resolver");
      const f = path.join(ensure(path.join(JOB, "public", "img")), `${name}.jpg`);
      const by = others<{ url?: string; scene: string }>("credits").find((c) => c.url === url);
      if (by) console.log(`note: ${by.scene} already shows this page — show a different part of it, or another outlet's report`);
      const ok = await screenshotPage(url!, f).catch(() => false);
      if (ok) credit({ file: `img/${name}.jpg`, kind: "article screenshot", source: new URL(url!).hostname, url: url!, license: "Fair use (screenshot of the cited source)" });
      console.log(ok ? `public/img/${name}.jpg — crop the headline block with ffmpeg if needed` : "screenshot failed (paywall or blocked) — try another outlet reporting the same fact");
      return;
    }
    case "commons": {
      const q = args.filter((a) => !a.startsWith("--")).join(" ");
      const UA = { "User-Agent": "OpumiaFilm/1.0 (documentary research)" };
      const s = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&srlimit=8&format=json&srsearch=${encodeURIComponent(q)}`, { headers: UA })).json() as { query: { search: Array<{ title: string }> } };
      const out = ensure(path.join(JOB, "public", "img"));
      const recent = (await import("./register.js")).recentPictures(ROOT, JOB);
      for (const hit of s.query.search.slice(0, Number(opt("--n") ?? 5))) {
        await new Promise((r) => setTimeout(r, 1500));
        const d = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1920&format=json&titles=${encodeURIComponent(hit.title)}`, { headers: UA })).json() as { query: { pages: Record<string, { imageinfo?: Array<{ thumburl?: string; url: string; descriptionurl: string; extmetadata?: Record<string, { value: string }> }> }> } };
        const ii = Object.values(d.query.pages)[0]?.imageinfo?.[0];
        if (!ii) continue;
        const by = others<{ url?: string; scene: string }>("credits").find((c) => c.url === ii.descriptionurl);
        if (by) { console.log(`(skipped: ${hit.title} is already in ${by.scene})`); continue; }
        if (recent.has(ii.descriptionurl.replace(/[?#].*$/, ""))) { console.log(`(skipped: ${hit.title} — a recent film of ours used it)`); continue; }
        const name = nm(`commons_${hit.title.slice(5).replace(/[^A-Za-z0-9]+/g, "_").slice(0, 50)}${/\.png/i.test(ii.thumburl ?? ii.url) ? ".png" : ".jpg"}`);
        const f = path.join(out, name);
        if (!existsSync(f)) writeFileSync(f, Buffer.from(await (await fetch(ii.thumburl ?? ii.url, { headers: UA })).arrayBuffer()));
        const lic = ii.extmetadata?.LicenseShortName?.value ?? "see source";
        credit({ file: `img/${name}`, kind: "photo", source: "Wikimedia Commons", url: ii.descriptionurl, license: lic, note: (ii.extmetadata?.Artist?.value ?? "").replace(/<[^>]+>/g, "").slice(0, 100) });
        console.log(`public/img/${name} | ${lic} | ${hit.title}`);
      }
      return;
    }
    case "stock": {
      const qs = args.filter((a) => !a.startsWith("--"));
      tsx("apps/cli/src/dev/hand/stock-look.ts", [ensure(WS), ...qs], flag("--image") ? { KIND: "image" } : {});
      console.log(`sheets: ${path.join(WS, "downloads", "stock-look")}/sheet_*.jpg (4 per row; the .json beside each sheet gives the key at every position)`);
      return;
    }
    case "stock-get": {
      const used = new Map(others<{ file: string; scene: string }>("credits").map((c) => [path.basename(c.file), c.scene]));
      const clash = args.filter((k) => used.has(k));
      if (clash.length) { console.log(`already used by another scene: ${clash.map((k) => `${k} (${used.get(k)})`).join(", ")} — choose other candidates`); process.exitCode = 1; return; }
      {
        // stock a recent film of ours used is on cooldown
        const recent = (await import("./register.js")).recentPictures(ROOT, JOB);
        const before = jread<Record<string, { pageUrl: string }>>(path.join(WS, "downloads", "stock-look", "candidates.json"), {});
        const cool = args.filter((k) => before[k] && recent.has(before[k]!.pageUrl.replace(/[?#].*$/, "")));
        if (cool.length) { console.log(`a recent film of ours used ${cool.join(", ")} — choose other candidates`); process.exitCode = 1; return; }
      }
      tsx("apps/cli/src/dev/hand/stock-get.ts", [ensure(WS), ...args]);
      const cat = jread<Record<string, { provider: string; pageUrl: string; license: string; attributionText?: string }>>(path.join(WS, "downloads", "stock-look", "candidates.json"), {});
      for (const k of args) { const c = cat[k]; if (c) credit({ file: `${path.relative(JOB, path.join(WS, "downloads", "stock"))}/${k}`, kind: "stock", source: c.provider, url: c.pageUrl, license: c.license, note: c.attributionText }); }
      console.log(`downloaded to ${path.relative(JOB, path.join(WS, "downloads", "stock"))}/ — LOOK at each one (ffmpeg a frame) before copying it into public/v/${SCENE ? ` (name it ${SCENE}_<key>.mp4)` : ""}`);
      return;
    }
    case "films": {
      const q = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--n"));
      sh(PY, ["-I", path.join(ROOT, "apps/cli/src/dev/hand/film-search.py"), ensure(path.join(WS, "downloads", "films")), ...q, "--n", opt("--n") ?? "12"]);
      console.log("public-domain feature films (Library/footage). Cut with ffmpeg from the Library file (read-only) into public/v/, then credit it: film-tools credit <file> film \"<film title> (public domain)\"");
      return;
    }
    case "credit": {
      const [file, kind, source, url = ""] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--license"));
      credit({ file: file!, kind: kind!, source: source!, url, license: opt("--license") ?? "see source" });
      console.log(`credited ${file}`);
      return;
    }
    case "cutout": {
      const [inp, outp] = args;
      const { removeBackground } = await import("@opumia/senses");
      const r = await removeBackground(path.resolve(JOB, inp!), path.resolve(JOB, outp!), path.join(ROOT, "data"));
      console.log(`${outp} (subject box ${JSON.stringify((r as { box?: number[] }).box ?? [])})`);
      return;
    }
    case "depth": {
      const [inp, outp] = args;
      sh(PY, ["-I", path.join(ROOT, "tools/depth/depth.py"), path.resolve(JOB, inp!), path.resolve(JOB, outp!)]);
      return;
    }
    // ---- build, look, mix
    case "render": {
      // a scene builder renders its own scene through its own entry (film seconds in, its own stills folder)
      const sc = opt("--scene") ?? SCENE;
      if (sc) {
        const { readPlan, sceneWindow } = await import("./plan.js");
        const plan = readPlan(JOB), i = plan?.scenes.findIndex((x) => x.id === sc) ?? -1;
        if (!plan || i < 0) { console.log(`no scene ${sc} in plan.json`); process.exitCode = 1; return; }
        const len = jread<{ seconds: number }>(path.join(JOB, "src", "length.json"), { seconds: 0 }).seconds;
        const w = sceneWindow(plan, i, len);
        const rest = args.filter((a, k) => a !== "--scene" && args[k - 1] !== "--scene");
        const media = !rest.includes("--stills");
        tsx("packages/motion-engine/src/hand/render-film.ts", [JOB, "--entry", path.join("src", "entries", `${sc}.tsx`), "--offset", String(w.startS), "--stills-dir", path.join("stills", sc), ...(media ? ["--out", `scene_${sc}.mp4`, "--concurrency", "3"] : []), ...rest]);
        console.log(`(${sc} is mounted ${w.startS.toFixed(2)}–${(w.startS + w.frames / 24).toFixed(2)} s; times are film seconds)`);
        return;
      }
      tsx("packages/motion-engine/src/hand/render-film.ts", [JOB, ...args]);
      return;
    }
    case "referee": {
      // the platform's own judge of whether this looks like the channel (proven on held-back channel films)
      const { refereeScore } = await import("../referee/score.js");
      const sc = opt("--scene") ?? SCENE;
      const reference = path.resolve(ROOT, process.env.OPUMIA_REFERENCE_DIR ?? "Reference");
      let v: Awaited<ReturnType<typeof refereeScore>>;
      if (sc && !args.find((a) => a.endsWith(".mp4"))) {
        const dir = path.join(JOB, "stills", sc);
        const stills = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jpg")).map((f) => path.join(dir, f)) : [];
        if (!stills.length) { console.log(`render stills of ${sc} first: film-tools render --stills …`); process.exitCode = 1; return; }
        v = await refereeScore({ root: ROOT, data: path.join(ROOT, "data"), reference, channel: CHANNEL, stills });
        console.log(`${sc}: ${v.score} (every channel film averages ≥ ${v.bar}) — ${v.score >= v.bar ? "reads like the channel" : "does not read like the channel yet: film-tools ref similar shows how the channel puts a line like this on screen"}`);
        return;
      }
      const file = path.resolve(JOB, args.find((a) => a.endsWith(".mp4")) ?? FR.film);
      v = await refereeScore({ root: ROOT, data: path.join(ROOT, "data"), reference, channel: CHANNEL, video: file });
      for (const s of v.stretches) console.log(`  ${s.from.toFixed(0).padStart(4)}–${s.to.toFixed(0).padEnd(4)} s  ${s.score.toFixed(2)}${s.low ? "  LOW — below the channel's weakest tenth" : ""}`);
      console.log(`${v.pass ? "REFEREE PASSED" : "REFEREE FAILED"}: ${v.score} (the channel's films: ≥ ${v.bar}); weakest: ${v.weakest}`);
      process.exitCode = v.pass ? 0 : 2;
      return;
    }
    case "rank": {
      // the referee on candidate footage before it is chosen (recipe lab, 2026-11-26: the same untouched frames ranged
      // 2.4–6.2; no caption or grade rescues footage that does not read like the channel)
      const files = args.filter((a) => !a.startsWith("--")).flatMap((a) => { const p = path.resolve(JOB, a); return existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.(mp4|mov|webm|jpg|jpeg|png)$/i.test(f)).map((f) => path.join(p, f)) : [p]; }).filter((p) => existsSync(p));
      if (!files.length) { console.log("film-tools rank <clip or photo or folder> … — scores each against the channel"); return; }
      const { refereeModel, refereeConfig } = await import("../referee/score.js");
      const reference = path.resolve(ROOT, process.env.OPUMIA_REFERENCE_DIR ?? "Reference");
      const m = await refereeModel({ root: ROOT, data: path.join(ROOT, "data"), reference, channel: CHANNEL });
      const cfg = refereeConfig(path.join(ROOT, "data"), CHANNEL)!;
      const { embedPictures, tasteOf } = await import("@opumia/agents");
      const items = files.flatMap((f) => (/\.(mp4|mov|webm)$/i.test(f) ? [0.25, 0.5, 0.75].map((k) => ({ file: f, t: Math.max(0.2, dur(f) * k), degrade: "corners" })) : [{ file: f, degrade: "corners" }]));
      const vs = await embedPictures({ root: ROOT, data: path.join(ROOT, "data"), items });
      const by = new Map<string, number[]>();
      items.forEach((it, i) => { if (vs[i]) (by.get(it.file) ?? by.set(it.file, []).get(it.file)!).push(tasteOf(m, vs[i]!)); });
      const rows = [...by].map(([f, xs]) => ({ f, s: xs.reduce((a, b) => a + b, 0) / xs.length })).sort((a, b) => b.s - a.s);
      for (const r of rows) console.log(`${r.s.toFixed(2)} ${r.s >= cfg.filmBar ? "reads like the channel" : r.s >= cfg.stretchLow ? "inside the channel's range" : "below the channel's weakest moments"} | ${path.relative(JOB, r.f)}`);
      console.log(`Choose among the pictures that show the line from the top of this list; a caption or grade does not rescue footage below ${cfg.stretchLow}.`);
      return;
    }
    case "scene-check": {
      const sc = args[0] ?? SCENE;
      const { sceneCheck } = await import("./scene-check.js");
      const r = await sceneCheck(JOB, sc!);
      for (const c of r.checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.detail}`);
      console.log(r.pass ? `SCENE ${sc} PASSED` : `SCENE ${sc} FAILED — fix the FAIL lines`);
      process.exitCode = r.pass ? 0 : 2;
      return;
    }
    case "beds": {
      // ranked by the bed head (how like the channel's own beds a bed sounds, voice-blind; build list 6, G3)
      const taste = jread<{ beds?: Array<{ file: string; score: number }> }>(path.join(ROOT, "data", "audio-profile-bed-taste.json"), {});
      const { recentlyUsed, libraryIds, usableAudio } = await import("./sound-draft.js");
      const used = recentlyUsed(ROOT).music, ids = libraryIds(ROOT), usable = usableAudio(ROOT);
      // only beds with a recorded licence, and none a recent film used
      const rows = (taste.beds ?? []).filter((r) => { const rel = r.file.replace(/^Library\//, ""); return usable.has(rel) && !used.has(ids.get(rel) ?? ""); }).slice(0, Number(opt("--n") ?? 20));
      for (const r of rows) console.log(`${r.score.toFixed(3)} | ${r.file} | ${usable.get(r.file.replace(/^Library\//, ""))!.license}`);
      if (!rows.length) console.log("no ranked beds: list Library/music and listen-measure with film-tools sound <file>");
      return;
    }
    case "sfx": {
      const prof = jread<{ sfx: Record<string, { family: string; seconds: number; attackS: number }> }>(path.join(ROOT, "data", "audio-profile.json"), { sfx: {} });
      const idx = jread<{ assets?: Array<{ id: string; relPath: string }> }>(path.join(ROOT, "data", "library-index.json"), {});
      const byId = new Map((idx.assets ?? []).map((r) => [r.id.slice(0, 16), r.relPath]));
      const fam = args[0];
      const { recentlyUsed, usableAudio } = await import("./sound-draft.js");
      const usable = usableAudio(ROOT), used = recentlyUsed(ROOT).sfx;
      // only effects with a recorded licence, and none a recent film used
      for (const [id, v] of Object.entries(prof.sfx)) if ((!fam || v.family === fam) && v.seconds < 8 && byId.get(id) && usable.has(byId.get(id)!) && !used.has(id)) console.log(`${v.family} | attack ${v.attackS.toFixed(2)} s | Library/${byId.get(id)}`);
      return;
    }
    case "mix": {
      tsx("apps/cli/src/film-agent/mix.ts", [JOB, ...args]);
      return;
    }
    // ---- measures and the gate
    case "type-check": {
      sh(PY, ["-I", path.join(ROOT, "tools/world/type_check.py"), path.join(JOB, args[0] ?? FR.film), "--channel", CHANNEL]);
      return;
    }
    case "world-check": {
      sh(PY, ["-I", path.join(ROOT, "tools/world/world_check.py"), path.basename(JOB), path.join(JOB, args[0] ?? FR.film), path.join(JOB, "timed-script.json"), "--no-save"]);
      return;
    }
    case "gate": {
      const { filmGate } = await import("./gate.js");
      const r = await filmGate({ root: ROOT, job: JOB, channel: CHANNEL });
      for (const c of r.checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.detail}`);
      console.log(r.pass ? "GATE PASSED" : "GATE FAILED — fix the FAIL lines and run the gate again");
      process.exitCode = r.pass ? 0 : 2;
      return;
    }
    // ---- memory and spend
    case "lesson": {
      const f = path.join(ensure(path.join(ROOT, "data", "agents", "film-agent")), `${CHANNEL}.md`);
      appendFileSync(f, `- (${path.basename(JOB)}${SCENE ? ` ${SCENE}` : ""}, ${new Date().toISOString().slice(0, 10)}) ${args.join(" ").replace(/\s+/g, " ").slice(0, 500)}\n`);
      console.log("lesson saved");
      return;
    }
    case "spend": {
      const s = jread<{ before?: number; limit?: number; agentSoFar?: number }>(path.join(JOB, "spend.json"), {});
      console.log(`research + script + narration: $${(s.before ?? 0).toFixed(2)}; agent so far ≈ $${(s.agentSoFar ?? 0).toFixed(2)}; film limit $${(s.limit ?? 0).toFixed(2)}`);
      return;
    }
    default:
      console.log(`unknown command "${cmd}" — film-tools help`);
      process.exitCode = 1;
  }
}
void statSync; void dur; void pos;
// every command ends: a headless browser (screenshot, page reads) or a socket left open would keep the process alive
// and block the agent's shell (found live on 2026-11-26: screenshots that saved their image and never exited)
try { await main(); } finally {
  await import("@opumia/resolver").then((r) => r.closeBrowser()).catch(() => {});
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
}
