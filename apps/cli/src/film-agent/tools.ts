// film-tools: the commands the film agent runs from its shell (the hand-film tools of 2026-11-25/26, packaged).
// Every command works inside the film's workspace (FILM_JOB) and records what it brings in (credits.json,
// fair-use.json), so the gate can prove every picture's source. No Claude API calls here except where noted.
//   npx tsx apps/cli/src/film-agent/tools.ts <command> … (the runner puts a `film-tools` wrapper on the agent's PATH)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.OPUMIA_ROOT ?? process.cwd();
// the agents' shell carries no stock or voice keys: film-tools loads them into its own process (the platform's loader)
{ const { loadKeys } = await import("../keys.js"); loadKeys(ROOT); }
const JOB = process.env.FILM_JOB ? path.resolve(process.env.FILM_JOB) : process.cwd();
const CHANNEL = process.env.FILM_CHANNEL ?? "magnates-media";
// a scene builder (parallel film agent) works in scene mode: its downloads, credits and names are its own, so builders
// running at the same time never write the same file
const SCENE = process.env.FILM_SCENE && /^s\d{2}$/.test(process.env.FILM_SCENE) ? process.env.FILM_SCENE : undefined;
const WS = SCENE ? path.join(JOB, "downloads", SCENE) : JOB;
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
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim() || 0);

async function main() {
  switch (cmd) {
    case "help": case undefined: {
      console.log(readFileSync(path.join(ROOT, "apps/cli/src/film-agent/TOOLS.md"), "utf8"));
      return;
    }
    // ---- the reference
    case "ref": {
      const films = readdirSync(REF_DIR).filter((d) => /^\d{8} - /.test(d)).sort();
      if (args[0] === "list") { films.forEach((f) => console.log(f)); return; }
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
      console.log("film-tools ref list | ref watch <name part> <fromS> <toS> [--fps 6|12]");
      return;
    }
    case "watch": {
      const [file, from = "0", to = "20"] = args;
      const out = ensure(path.join(JOB, "watch", `ours-${from}-${to}`));
      const labels = [`ours=${path.resolve(JOB, file!)}`];
      const r = opt("--ref");
      if (r) {
        const films = readdirSync(REF_DIR).filter((d) => /^\d{8} - /.test(d));
        const film = films.find((f) => f.toLowerCase().includes(r.toLowerCase()));
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
      if (Number(len) > 8.5) console.log("note: clips are at most 8.5 s (the channel's practice) — cut to 8.5");
      const crop = opt("--crop") ?? "crop=iw:ih:0:0";
      const parts = ensure(path.join(WS, "downloads", "news", "parts")), part = path.join(parts, `${name}_${id}_${start}_${seconds}.mp4`); // a new moment is a new download
      const s = Number(start);
      sh("yt-dlp", ["-q", "--no-warnings", "--no-playlist", "-f", "bv*[height<=1080][ext=mp4]/bv*[height<=1080]", "--download-sections", `*${s}-${s + seconds + 1}`, "-o", part, `https://www.youtube.com/watch?v=${id}`]);
      const outF = path.join(ensure(path.join(JOB, "public", "v")), `${name}.mp4`);
      sh("ffmpeg", ["-v", "error", "-y", "-i", part, "-t", String(seconds), "-an", "-vf", `${crop},scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,format=yuv420p`, "-c:v", "libx264", "-crf", "16", outF]);
      const meta = spawnSync("yt-dlp", ["--no-warnings", "--print", "%(title)s|%(channel)s", `https://www.youtube.com/watch?v=${id}`], { encoding: "utf8" }).stdout.trim().split("|");
      fairUse({ file: `v/${name}.mp4`, kind: flag("--film") ? "film" : "press", video: `https://www.youtube.com/watch?v=${id}`, title: meta[0] ?? "", channel: meta[1] ?? "", inS: s, seconds });
      credit({ file: `v/${name}.mp4`, kind: flag("--film") ? "film clip" : "press clip", source: meta[1] ?? "YouTube", url: `https://www.youtube.com/watch?v=${id}&t=${s}s`, license: "Fair use (short muted excerpt under commentary)" });
      console.log(existsSync(outF) ? `public/v/${name}.mp4 (${seconds} s, muted, 1080p 24 fps) — logged in fair-use.json; look at it before you use it` : "clip failed");
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
      for (const hit of s.query.search.slice(0, Number(opt("--n") ?? 5))) {
        await new Promise((r) => setTimeout(r, 1500));
        const d = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1920&format=json&titles=${encodeURIComponent(hit.title)}`, { headers: UA })).json() as { query: { pages: Record<string, { imageinfo?: Array<{ thumburl?: string; url: string; descriptionurl: string; extmetadata?: Record<string, { value: string }> }> }> } };
        const ii = Object.values(d.query.pages)[0]?.imageinfo?.[0];
        if (!ii) continue;
        const by = others<{ url?: string; scene: string }>("credits").find((c) => c.url === ii.descriptionurl);
        if (by) { console.log(`(skipped: ${hit.title} is already in ${by.scene})`); continue; }
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
      const { recentlyUsed, libraryIds } = await import("./sound-draft.js");
      const used = recentlyUsed(ROOT).music, ids = libraryIds(ROOT);
      const rows = (taste.beds ?? []).slice(0, Number(opt("--n") ?? 20));
      for (const r of rows) console.log(`${r.score.toFixed(3)} | ${r.file}${used.has(ids.get(r.file.replace(/^Library\//, "")) ?? "") ? " (used by a recent film — choose another)" : ""}`);
      if (!rows.length) console.log("no ranked beds: list Library/music and listen-measure with film-tools sound <file>");
      return;
    }
    case "sfx": {
      const prof = jread<{ sfx: Record<string, { family: string; seconds: number; attackS: number }> }>(path.join(ROOT, "data", "audio-profile.json"), { sfx: {} });
      const idx = jread<{ assets?: Array<{ id: string; relPath: string }> }>(path.join(ROOT, "data", "library-index.json"), {});
      const byId = new Map((idx.assets ?? []).map((r) => [r.id.slice(0, 16), r.relPath]));
      const fam = args[0];
      for (const [id, v] of Object.entries(prof.sfx)) if ((!fam || v.family === fam) && v.seconds < 8 && byId.get(id)) console.log(`${v.family} | attack ${v.attackS.toFixed(2)} s | Library/${byId.get(id)}`);
      return;
    }
    case "mix": {
      tsx("apps/cli/src/film-agent/mix.ts", [JOB, ...args]);
      return;
    }
    // ---- measures and the gate
    case "type-check": {
      sh(PY, ["-I", path.join(ROOT, "tools/world/type_check.py"), path.join(JOB, args[0] ?? "film_16x9.mp4"), "--channel", CHANNEL]);
      return;
    }
    case "world-check": {
      sh(PY, ["-I", path.join(ROOT, "tools/world/world_check.py"), path.basename(JOB), path.join(JOB, args[0] ?? "film_16x9.mp4"), path.join(JOB, "timed-script.json"), "--no-save"]);
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
await main();
