import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  AssetRecord,
  LibraryCategory,
  LibraryIndex,
  type AssetKind,
  type AssetSegment,
  type MediaProbe,
  type Orientation,
} from "@opumia/contracts";
import { z } from "zod";
import { readCsv } from "../util/csv.js";
import { dirSummary, exists, readJsonSafe, stableId, walk, writeStableJson, writeValidatedJson } from "../util/fs.js";
import { ffprobe, hasFfprobe, pool } from "../util/probe.js";

const EXT_KIND: Record<string, AssetKind> = {
  mp4: "video", mov: "video", webm: "video", mkv: "video", m4v: "video",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio", flac: "audio", aac: "audio",
  jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", tif: "image", tiff: "image",
  svg: "vector",
  geojson: "geo",
};

type SidecarRole = z.infer<typeof LibraryIndex>["sidecars"][number]["role"];

/** Subtrees that are sidecars (not assets): recorded by summary, never expanded. Paths relative to Library. */
const SIDECAR_DIRS: Array<{ rel: string; role: SidecarRole }> = [
  { rel: "footage/keys", role: "keyframes" },
  { rel: "footage/index", role: "embedding" },
  { rel: "footage/tags", role: "embedding" },
  { rel: "footage/tags_zeroshot", role: "embedding" },
  { rel: "footage/meta", role: "metadata" },
  { rel: "icons/_src/lucide/package/dist", role: "source_code" },
  { rel: "icons/_src/lucide/package/font", role: "source_code" },
  { rel: "bank/thumbs", role: "cache" },
  { rel: "bank/cache", role: "cache" },
];

const isMetaFile = (rel: string) => /\.(csv|json|jsonl|txt|log|sh|lock|md|html|tfw|tgz|mjs|map|jinja|npy|npz)$/i.test(rel);

const MOMENT_STRIP = /^moments\/.+\.jpg$/;

const PROTECTED_KEYS = new Set(["bank"]); // remote catalog: summarize, never expand

export interface IndexOptions {
  libraryRoot: string;
  dataDir: string;
  probe: boolean;
  concurrency: number;
  log?: (msg: string) => void;
}

type ProbeCacheEntry = { p?: MediaProbe; e?: string };
const ProbeCacheFile = z.object({ schemaVersion: z.literal(1), entries: z.record(z.object({ p: z.any().optional(), e: z.string().optional() })) });

const truthy = (v?: string) => (v === undefined || v === "" ? undefined : /^(yes|true|1|y)$/i.test(v));
const nonEmpty = (v?: string) => (v && v.trim() ? v.trim() : undefined);
const splitList = (v?: string, sep: RegExp = /[;|]/) => (v ? v.split(sep).map((s) => s.trim()).filter(Boolean) : []);

function orientationOf(p?: MediaProbe): Orientation | undefined {
  if (!p?.width || !p.height) return undefined;
  let { width: w, height: h } = p;
  if (p.rotation && Math.abs(p.rotation) % 180 === 90) [w, h] = [h, w];
  const r = w / h;
  return r > 1.05 ? "landscape" : r < 0.95 ? "portrait" : "square";
}

/** Draft asset built from the file walk; enriched by metadata merges below. */
type Draft = Omit<AssetRecord, "schemaVersion" | "provenance" | "tags" | "facets"> & {
  provenance: AssetRecord["provenance"];
  tags: Set<string>;
  facets: Record<string, string | number | boolean | string[]>;
};

function applyRow(d: Draft, row: Record<string, string>, from: string) {
  const pv = d.provenance;
  pv.from = [...new Set([...pv.from, from])];
  pv.license ??= nonEmpty(row.license ?? row.licence);
  pv.attributionRequired ??= truthy(row.attribution_required);
  pv.attributionText ??= nonEmpty(row.attribution_text ?? row.credit);
  pv.author ??= nonEmpty(row.author);
  pv.sourcePageUrl ??= nonEmpty(row.source_page_url ?? row.url);
  pv.directUrl ??= nonEmpty(row.direct_url);
  pv.sha256 ??= nonEmpty(row.sha256 ?? row.source_sha256);
  pv.basis ??= nonEmpty(row.basis ?? row.pd_basis);
  pv.rightsTier ??= nonEmpty(row.rights_tier);
  d.description ??= nonEmpty(row.description ?? row.notes);
  if (row.name) d.title ??= row.name;
  for (const t of splitList(row.tags, /\s+/)) d.tags.add(t);
  for (const key of ["emotions", "actions", "themes"] as const) {
    const xs = splitList(row[key]);
    if (xs.length) d.facets[key] = xs;
    for (const x of xs) d.tags.add(x);
  }
  for (const key of ["era", "decade", "country", "class", "kind", "sound", "origin_country", "faces", "source", "cut", "steps", "range_s", "date"] as const) {
    const v = nonEmpty(row[key]);
    if (v !== undefined) d.facets[key] = v;
  }
  for (const key of ["start_s", "end_s", "duration_s"] as const) {
    const v = Number(row[key]);
    if (row[key] && Number.isFinite(v)) d.facets[key] = v;
  }
  if (row.has_watermark_or_timecode) d.facets.watermark = truthy(row.has_watermark_or_timecode) ?? false;
  const q = Number(row.quality);
  if (row.quality && Number.isFinite(q)) d.quality = Math.max(0, Math.min(5, q));
}

export async function indexLibrary(opts: IndexOptions): Promise<{ index: LibraryIndex; outPath: string; write: "written" | "unchanged"; run: { freshProbes: number; cacheHits: number } }> {
  const { libraryRoot: root, dataDir } = opts;
  const log = opts.log ?? (() => {});
  const lib = (rel: string) => path.join(root, rel);
  if (!(await exists(root))) throw new Error(`Library not found at ${root}`);
  const protectedRoots = [root];

  // ---------- 1. Walk (read-only) ----------
  const drafts = new Map<string, Draft>(); // key: relPath
  const sidecarAgg = new Map<string, { role: SidecarRole; files: number; bytes: number }>();
  const addSidecar = (rel: string, role: SidecarRole, bytes: number) => {
    const s = sidecarAgg.get(rel) ?? { role, files: 0, bytes: 0 };
    s.files++;
    s.bytes += bytes;
    sidecarAgg.set(rel, s);
  };

  const topDirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const top of topDirs) {
    const cat = LibraryCategory.safeParse(top);
    if (!cat.success) {
      log(`  skip unknown folder: ${top}`);
      continue;
    }
    if (PROTECTED_KEYS.has(top)) continue; // handled in remote catalog summary
    for await (const e of walk(root, {
      skipDir: (rel) => {
        const sc = SIDECAR_DIRS.find((s) => s.rel === rel);
        return Boolean(sc);
      },
      skipFile: (rel) => rel.endsWith(".DS_Store"),
    }, top)) {
      const ext = path.extname(e.rel).slice(1).toLowerCase();
      let kind = EXT_KIND[ext];
      // Lucide's package ships its own sprite + many svgs; only icons/*.svg are assets.
      if (kind === "vector" && e.rel.startsWith("icons/_src/") && !e.rel.startsWith("icons/_src/lucide/package/icons/")) kind = undefined;
      if (MOMENT_STRIP.test(e.rel) && (await exists(lib(e.rel.replace(/\.jpg$/, ".mp4"))))) {
        addSidecar(path.posix.dirname(e.rel), "keyframes", e.bytes);
        continue;
      }
      if (e.rel === "maps/relief/SR_HR.npy") kind = "raster_data";
      if (!kind || isMetaFile(e.rel)) {
        if (kind !== "raster_data") {
          const role: SidecarRole = /\.(log)$/.test(e.rel) ? "log" : /\.sh$/.test(e.rel) ? "script" : /\.(mjs|map|tgz)$/.test(e.rel) ? "source_code" : /\.npy$/.test(e.rel) ? "embedding" : "metadata";
          addSidecar(path.posix.dirname(e.rel), role, e.bytes);
          continue;
        }
      }
      drafts.set(e.rel, {
        id: stableId(cat.data, e.rel),
        category: cat.data,
        relPath: e.rel,
        kind: kind!,
        ext,
        bytes: e.bytes,
        mtimeMs: e.mtimeMs,
        provenance: { from: [], generated: false },
        tags: new Set(),
        facets: {},
      });
    }
  }
  for (const s of SIDECAR_DIRS) {
    if (s.rel.startsWith("bank/")) continue;
    if (await exists(lib(s.rel))) {
      const sum = await dirSummary(lib(s.rel));
      sidecarAgg.set(s.rel, { role: s.role, ...sum });
    }
  }
  log(`  walked: ${drafts.size} assets`);

  const get = (rel: string) => drafts.get(rel);

  // ---------- 2. Merge existing provenance / metadata (read-only) ----------
  const csvSources: Array<{ csv: string; base: string; col: string }> = [
    { csv: "music/licenses.csv", base: "music", col: "file" },
    { csv: "sfx/licenses.csv", base: "sfx", col: "file" },
    { csv: "objects/index.csv", base: "objects", col: "file" },
    { csv: "overlays/licenses.csv", base: "overlays", col: "file" },
    { csv: "cinematic/index.csv", base: "cinematic", col: "file" },
    { csv: "era/index.csv", base: "era", col: "file" },
    { csv: "era/restored/provenance.csv", base: "era/restored", col: "restored_file" },
    { csv: "footage/licenses.csv", base: "footage", col: "file" },
  ];
  for (const src of csvSources) {
    const rows = await readCsv(lib(src.csv));
    let hit = 0;
    const perFile = new Map<string, Record<string, string>[]>();
    for (const row of rows) {
      const f = row[src.col];
      if (!f || !get(`${src.base}/${f}`)) continue;
      (perFile.get(f) ?? perFile.set(f, []).get(f)!).push(row);
      hit++;
    }
    for (const [f, fileRows] of perFile) {
      const d = get(`${src.base}/${f}`)!;
      applyRow(d, fileRows[0]!, src.csv);
      // Several rows for one file = several usable sub-ranges: keep each as a segment.
      if (fileRows.length > 1) {
        for (const r of fileRows.slice(1)) applyRow(d, r, src.csv);
        delete d.facets.start_s;
        delete d.facets.end_s;
        d.description = fileRows[0]!.description || d.description;
        d.segments = fileRows
          .filter((r) => r.start_s !== undefined && r.start_s !== "" && Number.isFinite(Number(r.start_s)))
          .map((r, i) => ({
            id: `${d.id}:${i}`,
            inS: Number(r.start_s),
            outS: Number(r.end_s || r.start_s),
            ...(r.description ? { caption: r.description } : {}),
          }))
          .sort((a, b) => a.inS - b.inS);
      }
    }
    log(`  ${src.csv}: ${hit}/${rows.length} rows matched`);
  }

  // era/restored inherits licence from its source clip
  for (const d of drafts.values()) {
    if (!d.relPath.startsWith("era/restored/")) continue;
    d.facets.restored = true;
    const srcRel = `era/${d.relPath.slice("era/restored/".length)}`;
    const src = get(srcRel);
    if (src) {
      d.provenance.license ??= src.provenance.license;
      d.provenance.attributionRequired ??= src.provenance.attributionRequired;
      d.provenance.attributionText ??= src.provenance.attributionText;
      d.provenance.sourcePageUrl ??= src.provenance.sourcePageUrl;
      d.description ??= src.description;
      d.facets.restoredFrom = srcRel;
    }
  }

  // objects/_src originals share the cutout's licence
  for (const d of drafts.values()) {
    const m = /^objects\/_src\/(.+)\.[a-z]+$/.exec(d.relPath);
    if (!m) continue;
    d.facets.role = "source_original";
    const cut = get(`objects/${m[1]}.png`);
    if (cut) {
      d.provenance = { ...cut.provenance, from: [...cut.provenance.from] };
      d.facets.cutout = cut.relPath;
    }
  }

  // music/<name>.json → generation prompt (audio only)
  for (const d of drafts.values()) {
    if (d.category !== "music" || d.kind !== "audio") continue;
    const side = lib(d.relPath.replace(/\.[^.]+$/, ".json"));
    if (!(await exists(side))) continue;
    const j = await readJsonSafe<{ prompt?: string; seconds?: number }>(side, 0);
    if (j.ok && j.value && typeof j.value.prompt === "string") {
      d.provenance.generated = true;
      d.provenance.generationPrompt = j.value.prompt;
      d.provenance.from.push(path.posix.relative("", d.relPath.replace(/\.[^.]+$/, ".json")));
      if (typeof j.value.seconds === "number") d.facets.targetSeconds = j.value.seconds;
    }
  }

  // sfx/catalogue.json → class + intended use + tagger scores
  {
    const j = await readJsonSafe<{ classes?: Record<string, { intended_use?: string; files?: Array<{ file: string; tag_score?: number; peak_dbfs?: number; top_tags?: [string, number][]; licence?: string; author?: string; url?: string; source?: string; credit?: string }> }> }>(lib("sfx/catalogue.json"), 0);
    if (j.ok && j.value.classes) {
      for (const [cls, c] of Object.entries(j.value.classes)) {
        for (const f of c.files ?? []) {
          const d = get(`sfx/${f.file}`);
          if (!d) continue;
          d.facets.class = cls;
          if (c.intended_use) d.facets.intendedUse = c.intended_use;
          if (typeof f.tag_score === "number") d.facets.tagScore = f.tag_score;
          if (typeof f.peak_dbfs === "number") d.facets.peakDbfs = f.peak_dbfs;
          for (const [t] of f.top_tags ?? []) d.tags.add(t);
          d.tags.add(cls);
          d.provenance.license ??= nonEmpty(f.licence);
          d.provenance.author ??= nonEmpty(f.author);
          d.provenance.sourcePageUrl ??= nonEmpty(f.url);
          d.provenance.attributionText ??= nonEmpty(f.credit);
          if (f.source && d.facets.source === undefined) d.facets.source = f.source;
          if (!d.provenance.from.includes("sfx/catalogue.json")) d.provenance.from.push("sfx/catalogue.json");
        }
      }
    }
  }

  // footage: per-film meta + SigLIP shot index → segments
  {
    for (const d of drafts.values()) {
      const m = /^footage\/films\/(.+)\.mp4$/.exec(d.relPath);
      if (!m) continue;
      const j = await readJsonSafe<Record<string, unknown>>(lib(`footage/meta/${m[1]}.json`), 0);
      if (!j.ok) continue;
      const v = j.value;
      const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
      d.title ??= s("title");
      d.provenance.license ??= s("license");
      d.provenance.basis ??= s("basis");
      d.provenance.rightsTier ??= s("tier");
      d.provenance.sourcePageUrl ??= s("page");
      d.provenance.directUrl ??= s("file_url");
      if (typeof v.year === "number") d.facets.year = v.year;
      for (const k of ["feature", "subject", "collection", "source"]) if (s(k)) d.facets[k] = s(k)!;
      d.provenance.from.push(`footage/meta/${m[1]}.json`);
    }
    const shotsPath = lib("footage/index/shots.jsonl");
    if (await exists(shotsPath)) {
      const segs = new Map<string, AssetSegment[]>();
      const txt = await readFile(shotsPath, "utf8");
      let n = 0;
      for (const line of txt.split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { sid: string; file: string; key?: string; in: number; out: number; caption?: string };
          const rel = r.file.replace(/^Library\//, "");
          const seg: AssetSegment = { id: r.sid, inS: Math.max(0, r.in), outS: Math.max(0, r.out) };
          if (r.caption) seg.caption = r.caption;
          if (r.key) seg.keyframe = r.key.replace(/^Library\//, "");
          (segs.get(rel) ?? segs.set(rel, []).get(rel)!).push(seg);
          n++;
        } catch {
          /* tolerate a partial trailing line */
        }
      }
      let matched = 0;
      for (const [rel, list] of segs) {
        const d = get(rel);
        if (!d) continue;
        d.segments = list.sort((a, b) => a.inS - b.inS);
        matched += list.length;
      }
      log(`  footage/index/shots.jsonl: ${matched}/${n} shots attached`);
    }
  }

  // moments/<channel>/index.json → technique clips
  {
    const chans = (await readdir(lib("moments"), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const ch of chans) {
      const j = await readJsonSafe<Record<string, { techniques?: string[]; moments?: Array<{ film: string; t: number; score: number; clip: string; strip?: string }> }>>(lib(`moments/${ch}/index.json`), 0);
      if (!j.ok) continue;
      for (const [tech, entry] of Object.entries(j.value)) {
        for (const mo of entry.moments ?? []) {
          const d = get(mo.clip.replace(/^Library\//, ""));
          if (!d) continue;
          d.facets.channel = ch;
          d.facets.technique = tech;
          d.facets.referenceFilm = mo.film;
          d.facets.referenceT = mo.t;
          d.facets.score = mo.score;
          if (mo.strip) d.facets.strip = mo.strip.replace(/^Library\//, "");
          if (entry.techniques?.length) d.facets.remotionTechniques = entry.techniques;
          d.tags.add(tech);
          d.provenance.rightsTier ??= "reference_only";
          d.provenance.license ??= "Reference only: third-party channel excerpt, never ship in output";
          d.provenance.from.push(`moments/${ch}/index.json`);
        }
      }
    }
  }

  // filename-derived facets
  for (const d of drafts.values()) {
    const base = path.posix.basename(d.relPath).replace(/\.[^.]+$/, "");
    const parts = d.relPath.split("/");
    if (d.category === "icons") {
      const m = /^([a-z_]+)_(\d+)_([0-9a-f]{6})_s([\d.]+)$/.exec(base);
      if (m) Object.assign(d.facets, { icon: m[1]!, colorHex: `#${m[3]}`, scale: Number(m[4]) });
      if (d.relPath.startsWith("icons/_src/lucide/")) Object.assign(d.facets, { set: "lucide", icon: base });
      d.provenance.license ??= d.facets.set === "lucide" ? "ISC (Lucide)" : undefined;
      d.tags.add(String(d.facets.icon ?? base));
    }
    if (d.category === "maps" || d.category === "overlays" || d.category === "cinematic" || d.category === "era") {
      if (parts.length > 2) d.facets.group = parts[1]!;
    }
    if (d.category === "maps") {
      if (base.startsWith("ne_")) d.provenance.license ??= "Public domain (Natural Earth)";
    }
    if ((d.category === "cinematic" || d.category === "era") && base.includes("__")) {
      const subj = base.split("__")[0]!;
      d.facets.subject = subj;
      d.tags.add(subj);
    }
    d.title ??= base.replace(/[_-]+/g, " ").trim();
  }

  // ---------- 3. Existing caches (read-only) ----------
  const caches: LibraryIndex["caches"] = {};
  {
    const j = await readJsonSafe<Record<string, string[]>>(lib("bugspot_cache.json"), 0);
    if (j.ok) {
      // key: "<basename>|<bytes>|<mtimeSeconds>"; exact match first, then basename+bytes (mtime drift after copy).
      const exact = new Map<string, string[]>();
      const loose = new Map<string, string[]>();
      for (const [k, v] of Object.entries(j.value)) {
        const [name, bytes] = k.split("|");
        exact.set(k, v);
        loose.set(`${name}|${bytes}`, v);
      }
      let matched = 0;
      for (const d of drafts.values()) {
        if (d.kind !== "video") continue;
        const name = path.posix.basename(d.relPath);
        const spots = exact.get(`${name}|${d.bytes}|${Math.floor(d.mtimeMs / 1000)}`) ?? loose.get(`${name}|${d.bytes}`);
        if (spots) {
          d.bugSpots = spots.filter((s): s is "tl" | "tr" | "bl" | "br" => ["tl", "tr", "bl", "br"].includes(s));
          matched++;
        }
      }
      caches.bugspot = { relPath: "bugspot_cache.json", entries: exact.size, matched };
    }
  }
  {
    const j = await readJsonSafe<Record<string, string | null>>(lib("wiki_ipa_cache.json"), 0);
    if (j.ok) {
      const lexicon = Object.fromEntries(Object.entries(j.value).filter((e): e is [string, string] => typeof e[1] === "string").sort(([a], [b]) => a.localeCompare(b)));
      caches.wikiIpa = { relPath: "wiki_ipa_cache.json", entries: Object.keys(j.value).length, withIpa: Object.keys(lexicon).length, lexicon };
    }
  }

  // ---------- 4. Remote catalog (bank): summarize only, never write ----------
  const remoteCatalogs: LibraryIndex["remoteCatalogs"] = [];
  if (await exists(lib("bank"))) {
    const bySource: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    let items = 0;
    let readError: string | undefined;
    const j = await readJsonSafe<Record<string, { source?: string; kind?: string }>>(lib("bank/items.json"));
    if (j.ok) {
      for (const v of Object.values(j.value)) {
        items++;
        const s = v.source ?? "unknown";
        const k = v.kind ?? "unknown";
        bySource[s] = (bySource[s] ?? 0) + 1;
        byKind[k] = (byKind[k] ?? 0) + 1;
      }
    } else readError = `items.json unreadable (likely mid-write by its owner): ${j.error}`;
    const count = async (rel: string) => (await readdir(lib(rel)).catch(() => [])).filter((f) => !f.startsWith(".")).length;
    const sortRec = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
    remoteCatalogs.push({
      relPath: "bank/items.json",
      items,
      bySource: sortRec(bySource),
      byKind: sortRec(byKind),
      cachedThumbs: await count("bank/thumbs"),
      cachedQueries: await count("bank/cache"),
      ...(readError ? { readError } : {}),
      providers: Object.keys(bySource).sort(),
    });
    for (const f of ["bank/limits.json", "bank/cooldown.json", "bank/cloud_render_spend.jsonl"]) if (await exists(lib(f))) addSidecar(f, "metadata", 0);
    for (const f of ["bank/items.lock", "bank/limits.lock"]) if (await exists(lib(f))) addSidecar(f, "lock", 0);
    sidecarAgg.set("bank/thumbs", { role: "cache", files: remoteCatalogs[0]!.cachedThumbs, bytes: 0 });
    sidecarAgg.set("bank/cache", { role: "cache", files: remoteCatalogs[0]!.cachedQueries, bytes: 0 });
  }

  // ---------- 5. Probe (incremental, cached in data/.cache) ----------
  const cachePath = path.join(dataDir, ".cache", "probe-cache.json");
  const cacheRead = await readJsonSafe<unknown>(cachePath, 0);
  const cacheParsed = cacheRead.ok ? ProbeCacheFile.safeParse(cacheRead.value) : null;
  const oldCache: Record<string, ProbeCacheEntry> = cacheParsed?.success ? cacheParsed.data.entries : {};
  const newCache: Record<string, ProbeCacheEntry> = {};
  let probed = 0;
  let hits = 0;
  const probeable = [...drafts.values()].filter((d) => d.kind === "video" || d.kind === "audio" || d.kind === "image");
  const canProbe = opts.probe && (await hasFfprobe());
  if (opts.probe && !canProbe) log("  ffprobe not found; skipping probes");
  const todo: Draft[] = [];
  for (const d of probeable) {
    const key = `${d.relPath}|${d.bytes}|${d.mtimeMs}`;
    const c = oldCache[key];
    if (c) {
      newCache[key] = c;
      hits++;
      if (c.p) d.probe = c.p;
      if (c.e) d.probeError = c.e;
    } else if (canProbe) todo.push(d);
  }
  if (todo.length) {
    log(`  probing ${todo.length} files (${hits} cached)…`);
    let lastPct = -1;
    await pool(todo, opts.concurrency, async (d) => {
      const key = `${d.relPath}|${d.bytes}|${d.mtimeMs}`;
      try {
        const p = await ffprobe(lib(d.relPath), d.kind as "video" | "audio" | "image");
        d.probe = p;
        newCache[key] = { p };
      } catch (err) {
        const e = ((err as { stderr?: string }).stderr || (err as Error).message || "probe failed").toString().trim().split("\n")[0]!.slice(0, 200);
        d.probeError = e;
        newCache[key] = { e };
      }
      probed++;
    }, (n) => {
      const pct = Math.floor((n / todo.length) * 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        log(`    ${pct}%`);
      }
    });
  }
  // Persist the memo (sorted keys → deterministic). Stale keys for changed/removed files drop out.
  const sortedCache = Object.fromEntries(Object.entries(newCache).sort(([a], [b]) => a.localeCompare(b)));
  await writeValidatedJson(cachePath, ProbeCacheFile, { schemaVersion: 1, entries: sortedCache }, protectedRoots);

  // ---------- 6. Finalize + validate ----------
  const assets: AssetRecord[] = [...drafts.values()]
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .map((d) => {
      const orientation = orientationOf(d.probe);
      const rec = {
        schemaVersion: 1 as const,
        ...d,
        ...(orientation ? { orientation } : {}),
        tags: [...d.tags].map((t) => t.toLowerCase()).filter((t, i, a) => a.indexOf(t) === i).sort(),
        facets: Object.fromEntries(Object.entries(d.facets).sort(([a], [b]) => a.localeCompare(b))),
        provenance: Object.fromEntries(Object.entries({ ...d.provenance, from: [...new Set(d.provenance.from)].sort() }).filter(([, v]) => v !== undefined)),
      };
      return AssetRecord.parse(rec);
    });

  const count = (key: (a: AssetRecord) => string) => {
    const r: Record<string, number> = {};
    for (const a of assets) r[key(a)] = (r[key(a)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  };

  const index: LibraryIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    libraryRoot: path.relative(process.cwd(), root) || ".",
    stats: {
      assets: assets.length,
      byCategory: count((a) => a.category),
      byKind: count((a) => a.kind),
      probed: assets.filter((a) => a.probe).length,
      probeErrors: assets.filter((a) => a.probeError).length,
      withLicense: assets.filter((a) => a.provenance.license).length,
      generatedAudio: assets.filter((a) => a.provenance.generated).length,
      totalBytes: assets.reduce((s, a) => s + a.bytes, 0),
    },
    caches,
    remoteCatalogs,
    sidecars: [...sidecarAgg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([relPath, s]) => ({ relPath, ...s })),
    assets,
  };

  const outPath = path.join(dataDir, "library-index.json");
  const write = await writeStableJson(outPath, LibraryIndex, index, protectedRoots);
  return { index, outPath, write, run: { freshProbes: probed, cacheHits: hits } };
}
