// The film agent's gate: the hard rules, checked in code before a film counts as done (no model calls).
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { sameObject, objectWords, GENERIC_OBJECTS } from "@opumia/agents";
import { filmMedia, drawnObject } from "./plan.js";

/** The film's ledger plus every scene builder's own (credits/<scene>.json, fair-use/<scene>.json). */
export function ledgers<T>(job: string, kind: "credits" | "fair-use"): T[] {
  const all = [...jread<T[]>(path.join(job, `${kind}.json`), [])];
  const dir = path.join(job, kind);
  // each scene's ledger entries carry their scene (the repeat checks compare scenes)
  if (existsSync(dir)) for (const f of readdirSync(dir).sort()) if (f.endsWith(".json")) all.push(...jread<T[]>(path.join(dir, f), []).map((x) => ({ ...x, scene: f.replace(/\.json$/, "") })));
  return all;
}
export interface GateCheck { id: string; pass: boolean; detail: string }
const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
const AI = /\b(ai[- ]generated|generative|midjourney|dall-?e|stable diffusion|firefly|higgsfield|sora|runway|imagen|flux)\b/i;
const OWN = /\bmagnates ?media\b/i;
const LIFT = /\b(how money works|logically answered|modern mba|moon|big company|business casual|company man|coldfusion|cold fusion|wendover|polymatter|johnny harris|vox)\b/i;

export async function filmGate(o: { root: string; job: string; channel: string; record?: boolean }): Promise<{ pass: boolean; checks: GateCheck[] }> {
  const checks: GateCheck[] = [];
  const add = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });
  const film = path.join(o.job, "film_16x9.mp4");
  const timed = jread<{ durationS?: number }>(path.join(o.job, "timed-script.json"), {});
  if (!existsSync(film)) { add("film", false, "no film_16x9.mp4 — render (film-tools render) and mix (film-tools mix)"); return { pass: false, checks }; }
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate", "-of", "json", film], { encoding: "utf8" }).stdout;
  const pj = JSON.parse(probe) as { format: { duration: string }; streams: Array<{ width?: number; height?: number; r_frame_rate?: string }> };
  const d = Number(pj.format.duration), v = pj.streams.find((s) => s.width);
  add("film", d >= (timed.durationS ?? 0) - 0.5 && v?.width === 1920 && v?.height === 1080 && v?.r_frame_rate === "24/1", `${d.toFixed(1)} s (narration ${(timed.durationS ?? 0).toFixed(1)} s), ${v?.width}×${v?.height} at ${v?.r_frame_rate} (needs the whole narration, 1920×1080, 24 fps)`);
  const ld = spawnSync("ffmpeg", ["-hide_banner", "-i", film, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const I = Number(/^\s+I:\s+(-?[\d.]+) LUFS/m.exec(ld)?.[1] ?? -99), P = Number(/^\s+Peak:\s+(-?[\d.]+) dBFS/m.exec(ld)?.[1] ?? 0);
  // the mix must be of the current picture (a rebuilt scene re-renders picture.mp4; the film is only new once mixed again)
  const pic = path.join(o.job, "picture.mp4");
  if (existsSync(pic)) { const stale = statSync(pic).mtimeMs > statSync(film).mtimeMs + 1000; add("current_mix", !stale, stale ? "picture.mp4 is newer than film_16x9.mp4 — run film-tools mix" : "the film is the mix of the current picture"); }
  add("loudness", I >= -13.5 && I <= -11.5 && P <= -1.4, `${I} LUFS (−12.5 ± 1), peak ${P} dB (≤ −1.5) — film-tools mix sets both`);

  // type: words set like the channel's (boxes, one size, capitals); words on frames is advisory (signage counts)
  const py = process.env.OPUMIA_PY ?? path.join(process.env.HOME ?? "", "lechi_tts", "venv", "bin", "python");
  const tc = spawnSync(py, ["-I", path.join(o.root, "tools/world/type_check.py"), film, "--json", "--channel", o.channel], { cwd: o.root, encoding: "utf8", maxBuffer: 1 << 24 }).stdout;
  const tj = (() => { try { return JSON.parse(tc.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "{}") as { verdict?: Record<string, { value: number; limit: number; pass: boolean }> }; } catch { return {}; } })();
  const tv = tj.verdict ?? {};
  const typeFails = ["smallBoxed", "sizeSpread", "caps"].filter((k) => tv[k] && !tv[k]!.pass);
  add("type", Object.keys(tv).length > 0 && typeFails.length === 0, Object.entries(tv).map(([k, x]) => `${k} ${x.value} (${x.pass ? "ok" : "OUTSIDE"} ${x.limit})`).join(", ") || "type check did not run");

  // fair use at the channel's practice
  // only the clips the film draws count (a builder may cut several and use one)
  const onScreen = filmMedia(o.job);
  const fu = ledgers<{ file: string; kind: string; video: string; channel: string; seconds: number }>(o.job, "fair-use").filter((x) => !onScreen.size || onScreen.has(x.file) || [...onScreen].some((m) => m.replace(/_(cut|crop\w*|depth|mask)(\.\w+)$/, "$2") === x.file));
  const long = fu.filter((x) => x.seconds > 8.5), share = fu.reduce((t, x) => t + x.seconds, 0) / Math.max(1, d);
  const lifted = fu.filter((x) => OWN.test(x.channel) || LIFT.test(x.channel));
  add("fair_use", !long.length && share <= 0.27 && !lifted.length, `${fu.length} clip(s), ${Math.round(share * 100)} % of runtime (≤ 27 %), ${long.length} over 8.5 s${lifted.length ? `, ${lifted.length} from a channel never lifted from (${lifted.map((x) => x.channel).join(", ")})` : ""}`);

  // every picture placed has a source
  const credits = ledgers<{ file: string; kind: string; source: string; url?: string; license: string; note?: string }>(o.job, "credits");
  const known = new Set(credits.map((c) => path.basename(c.file)));
  const media: string[] = [];
  for (const sub of ["v", "img"]) { const dir = path.join(o.job, "public", sub); if (existsSync(dir)) for (const f of readdirSync(dir)) if (/\.(mp4|mov|webm|jpg|jpeg|png|webp)$/i.test(f) && !/_depth\.|_cut\.|_crop|_mask/.test(f)) media.push(`${sub}/${f}`); }
  const unknown = media.filter((m) => !known.has(path.basename(m)) && !credits.some((c) => m.includes(path.basename(c.file).replace(/\.\w+$/, ""))));
  add("sources", unknown.length === 0, unknown.length ? `${unknown.length} picture(s) in public/ without a credit: ${unknown.slice(0, 8).join(", ")} — film-tools credit <file> <kind> <source> <url> (derived files: name them *_cut, *_crop, *_depth)` : `${media.length} picture(s), all credited`);

  // no generated pixels; never the channel's own material
  const cands: Record<string, { aiGenerated?: boolean }> = { ...jread<Record<string, { aiGenerated?: boolean }>>(path.join(o.job, "downloads", "stock-look", "candidates.json"), {}) };
  const dl = path.join(o.job, "downloads");
  if (existsSync(dl)) for (const d of readdirSync(dl)) if (/^s\d{2}$/.test(d)) Object.assign(cands, jread<Record<string, { aiGenerated?: boolean }>>(path.join(dl, d, "downloads", "stock-look", "candidates.json"), {}));
  const aiStock = credits.filter((c) => c.kind === "stock" && cands[path.basename(c.file).replace(/\.\w+$/, "")]?.aiGenerated);
  // a picture in public/ named after an AI-flagged stock key counts too
  for (const m of media) { const k = Object.keys(cands).find((key) => cands[key]?.aiGenerated && m.includes(key.replace(/\.\w+$/, ""))); if (k) aiStock.push({ file: m, kind: "stock", source: k, license: "" }); }
  const aiText = credits.filter((c) => AI.test(`${c.source} ${c.note ?? ""} ${c.license}`));
  const own = credits.filter((c) => OWN.test(`${c.source} ${c.url ?? ""} ${c.note ?? ""}`));
  add("no_ai", !aiStock.length && !aiText.length, aiStock.length || aiText.length ? `generated imagery: ${[...aiStock, ...aiText].map((c) => c.file).join(", ")}` : "no generated imagery among the credited sources");
  add("not_the_channels_own", !own.length, own.length ? `MagnatesMedia material: ${own.map((c) => c.file).join(", ")}` : "nothing from MagnatesMedia");

  // originality: the signature object is this film's own
  const world = ["WORLD.md", "SCENES.md"].map((f) => path.join(o.job, f)).filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
  const so = /signature object\s*[:\-—]\s*(.+)/i.exec(world)?.[1]?.trim() ?? "";
  const kits = jread<Array<{ job: string; signatureObject?: string }>>(path.join(o.root, "data", "film-kits.json"), []);
  const clash = kits.find((k) => k.job !== path.basename(o.job) && k.signatureObject && sameObject(so, k.signatureObject));
  const generic = GENERIC_OBJECTS.find((g) => objectWords(so).includes(g.replace(/s$/, "")));
  const drawn = so ? drawnObject(so) : null;
  add("signature_object", Boolean(so) && !clash && !generic && !drawn, !so ? 'name it in SCENES.md: "Signature object: …"' : clash ? `"${so}" is ${clash.job}'s — choose a thing THIS story owns` : generic ? `"${generic}" is a generic money symbol` : drawn ? drawn : `"${so.slice(0, 80)}" — its own`);
  // the referee (proven on held-back channel films it never saw): the film must read like the channel
  try {
    const { refereeConfig, refereeScore } = await import("../referee/score.js");
    if (refereeConfig(path.join(o.root, "data"), o.channel)) {
      const v = await refereeScore({ root: o.root, data: path.join(o.root, "data"), reference: path.resolve(o.root, process.env.OPUMIA_REFERENCE_DIR ?? "Reference"), channel: o.channel, video: film });
      add("referee", v.pass, `${v.score} against the channel (every held-back channel film ≥ ${v.bar}); weakest: ${v.weakest} — film-tools referee for every stretch, film-tools ref similar for how the channel shows those lines`);
    } else add("referee", true, "the referee has not been built (npx tsx apps/cli/src/dev/referee-build.ts) — not checked");
  } catch (e) { add("referee", false, `the referee could not score the film: ${(e as Error).message.slice(0, 160)}`); }
  add("review", existsSync(path.join(o.job, "REVIEW.md")), existsSync(path.join(o.job, "REVIEW.md")) ? "REVIEW.md written" : "write REVIEW.md: what worked, what failed, the root cause, what you would do first next time");

  const pass = checks.every((c) => c.pass);
  if (pass && o.record !== false && so) {
    const f = path.join(o.root, "data", "film-kits.json");
    const all = kits.filter((k) => k.job !== path.basename(o.job));
    // the same fields the art director reads from earlier films (typefaces, colours, concept, devices)
    const plan = jread<{ world?: string; palette?: Record<string, string>; fonts?: { display?: string; body?: string } }>(path.join(o.job, "plan.json"), {});
    const fonts = [plan.fonts?.display, plan.fonts?.body].filter((x): x is string => Boolean(x)).map((x) => x.split(",")[0]!.replace(/["']/g, "").trim());
    writeFileSync(`${f}.tmp`, JSON.stringify([...all, { job: path.basename(o.job), devices: [], fonts, palette: Object.values(plan.palette ?? {}), tokens: plan.palette ?? {}, concept: (plan.world ?? "").slice(0, 300), transition: "", signatureObject: so, agent: "film-agent", at: new Date().toISOString() }], null, 1) + "\n");
    renameSync(`${f}.tmp`, f);
  }
  return { pass, checks };
}
