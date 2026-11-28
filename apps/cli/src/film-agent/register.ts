// A finished film joins the platform's memory of our films (2026-11-28 audit: film-agent films were never recorded, so no
// later film could be compared against them). Called when the gate passes:
//   - data/produced.json            the job is a film (readers of "recent films" keep only these)
//   - data/asset-usage.json         the pictures (by source), music beds and sound effects it used (cooldown)
//   - data/world-profile/films/     its type look (tools/world/type_look.py) and pictures/word look (world_check.py)
// data/film-kits.json (fonts, palette, signature object) is written by the gate itself.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markProduced } from "@opumia/agents";
import { ledgers } from "./gate.js";
import { filmPath, frameOf } from "./plan.js";
import { usableAudio } from "./sound-draft.js";

const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
const py = () => process.env.OPUMIA_PY ?? path.join(process.env.HOME ?? "", "lechi_tts", "venv", "bin", "python");

/** A picture's identity across films: the stock page, the photo's page, or a press video and the second it starts at. */
export function pictureRef(c: { url?: string; file?: string }): string | null {
  const u = c.url ?? "";
  const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})(?:.*[?&]t=(\d+))?/.exec(u);
  if (yt) return `youtube:${yt[1]}@${yt[2] ?? 0}`;
  return u ? u.replace(/[?#].*$/, "") : null;
}

export async function registerFilm(o: { root: string; job: string; log?: (s: string) => void }): Promise<void> {
  const log = o.log ?? (() => {});
  const data = path.join(o.root, "data"), name = path.basename(o.job);
  await markProduced(data, name, frameOf(o.job).film);
  // what it used: pictures by source; beds and effects from the mix
  const credits = ledgers<{ url?: string; file?: string; kind?: string }>(o.job, "credits");
  const pictures = [...new Set(credits.filter((c) => !/wikipedia|logo/i.test(`${c.kind ?? ""} ${c.url ?? ""}`)).map(pictureRef).filter((x): x is string => Boolean(x)))].sort();
  const mix = jread<{ beds?: Array<{ file: string }>; cues?: Array<{ file: string }> }>(path.join(o.job, "mix.json"), {});
  const music = [...new Set((mix.beds ?? []).map((b) => b.file))].sort(), sfx = [...new Set((mix.cues ?? []).map((c) => c.file))].sort();
  const f = path.join(data, "asset-usage.json");
  const all = jread<Array<{ job: string }>>(f, []).filter((u) => u.job !== name);
  all.push({ job: name, at: new Date().toISOString(), pictures, sfx, music } as { job: string });
  writeFileSync(`${f}.tmp`, JSON.stringify(all.slice(-80), null, 1) + "\n");
  renameSync(`${f}.tmp`, f);
  // its look, so later films are measured against it (the channel's own film-to-film spread is the bar)
  const film = filmPath(o.job);
  if (existsSync(film)) {
    const t = spawnSync(py(), ["-I", path.join(o.root, "tools/world/type_look.py"), "save", name, film], { cwd: o.root, encoding: "utf8", timeout: 300_000 });
    const w = spawnSync(py(), ["-I", path.join(o.root, "tools/world/world_check.py"), name, film, path.join(o.job, "timed-script.json"), "--json"], { cwd: o.root, encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 24 });
    if (t.status !== 0 || w.status !== 0) log(`  ! the film's look could not be registered (${(t.stderr || w.stderr || "").trim().split("\n").at(-1)})`);
  }
  writeSoundLicences(o.root, o.job);
  log(`  registered ${name}: ${pictures.length} pictures, ${music.length} beds, ${sfx.length} effects on cooldown; type and picture look saved`);
}

/** Pictures the last `n` films of ours used (by source; see pictureRef), except this job's own: on cooldown. */
export function recentPictures(root: string, job: string, n = 12): Set<string> {
  const made = new Set(jread<Array<{ job: string }>>(path.join(root, "data", "produced.json"), []).map((x) => x.job));
  const u = jread<Array<{ job: string; pictures?: string[] }>>(path.join(root, "data", "asset-usage.json"), []);
  return new Set(u.filter((x) => x.job !== path.basename(job) && made.has(x.job)).slice(-n).flatMap((x) => x.pictures ?? []));
}
/** True when a press moment is within 8 s of one a recent film used (youtube:<id>@<s>). */
export function pressMomentUsed(used: Set<string>, id: string, startS: number): string | null {
  for (const r of used) { const m = /^youtube:([\w-]+)@(\d+)$/.exec(r); if (m && m[1] === id && Math.abs(Number(m[2]) - startS) < 8) return r; }
  return null;
}
/** The sound in the mix and what is wrong with it: a bed or effect without a recorded licence. */
export function soundLicences(root: string, job: string): { rows: Array<{ file: string; license: string; attribution?: string; page?: string; generated: boolean }>; unlicensed: string[] } {
  const mix = jread<{ beds?: Array<{ file: string }>; cues?: Array<{ file: string }> }>(path.join(job, "mix.json"), {});
  const usable = usableAudio(root);
  const files = [...new Set([...(mix.beds ?? []), ...(mix.cues ?? [])].map((x) => x.file))];
  const rows = files.flatMap((f) => { const u = usable.get(f.replace(/^Library\//, "")); return u ? [{ file: f, license: u.license, ...(u.attribution ? { attribution: u.attribution } : {}), ...(u.page ? { page: u.page } : {}), generated: u.generated }] : []; });
  return { rows, unlicensed: files.filter((f) => !usable.has(f.replace(/^Library\//, ""))) };
}
/** LICENSES.md gets the film's music and sound effects (credits follow each licence; generated audio is marked). */
export function writeSoundLicences(root: string, job: string): void {
  const f = path.join(job, "LICENSES.md");
  const base = existsSync(f) ? readFileSync(f, "utf8").split("\n## Music and sound effects")[0]!.trimEnd() : "# Licences and sources";
  const { rows } = soundLicences(root, job);
  writeFileSync(f, `${base}\n\n## Music and sound effects\n\n| File | Licence | Credit | Link |\n|---|---|---|---|\n${rows.map((r) => `| ${r.file} | ${r.license}${r.generated ? " (generated audio)" : ""} | ${(r.attribution ?? "").replace(/\|/g, "/")} | ${r.page ?? ""} |`).join("\n")}\n`);
}
