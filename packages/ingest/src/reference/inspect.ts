import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ReferenceStatus, type CorpusStatus } from "@opumia/contracts";
import { readCsv } from "../util/csv.js";
import { exists, readJsonSafe, writeStableJson } from "../util/fs.js";
import { CHANNELS, type ChannelConfig } from "./channels.js";

/** One reference video discovered on disk. */
export interface RefVideo {
  channel: ChannelConfig;
  ytId: string;
  /** Absolute folder containing the video's files. */
  dir: string;
  /** Path relative to Reference/. */
  relDir: string;
  infoPath: string | null;
  title: string;
  durationS: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  views: number | null;
  uploadDate: string | null;
  chapters: number;
  videoFile: string | null;
  transcriptFile: string | null;
  shotFile: string | null;
  soundFile: string | null;
  /** Lives under <channel>/_spares/. */
  spare?: boolean;
  /** Big Company: two-digit film number used by Analysis Data files. */
  filmNo?: string;
}

interface InfoJson {
  id?: string;
  title?: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  view_count?: number;
  upload_date?: string;
  chapters?: unknown[];
}

const visibleDirs = async (p: string) =>
  (await readdir(p, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

/** Parse "youtube <id>" lines; tolerant of blank lines and bare ids. */
export async function readDoneFile(p: string): Promise<{ lines: number; ids: string[] }> {
  const txt = await readFile(p, "utf8").catch(() => "");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const ids = lines.map((l) => l.trim().split(/\s+/).pop()!).filter(Boolean);
  return { lines: lines.length, ids: [...new Set(ids)] };
}

const ytIdFromUrl = (u: string) => /[?&]v=([\w-]{11})/.exec(u)?.[1] ?? /youtu\.be\/([\w-]{11})/.exec(u)?.[1] ?? null;

/** yt-dlp writes a channel-level info.json (id "UC…", _type playlist) next to the videos. */
const isChannelInfo = (info: (InfoJson & { _type?: string }) | null, file: string) =>
  info?._type === "playlist" || /^UC[\w-]{22}$/.test(info?.id ?? file.replace(/\.info\.json$/, ""));

async function loadInfo(p: string): Promise<InfoJson | null> {
  const j = await readJsonSafe<InfoJson>(p, 0);
  return j.ok ? j.value : null;
}

export async function discoverVideos(refRoot: string, ch: ChannelConfig): Promise<RefVideo[]> {
  const base = path.join(refRoot, ch.dir);
  const out: RefVideo[] = [];
  if (ch.layout === "standard") {
    // Video folders live at <channel>/<folder>, plus spares at <channel>/_spares/<folder>.
    const names = [
      ...(await visibleDirs(base)).filter((n) => n !== "_spares"),
      ...(await visibleDirs(path.join(base, "_spares"))).map((n) => `_spares/${n}`),
    ];
    for (const name of names) {
      const dir = path.join(base, name);
      const files = await readdir(dir).catch(() => [] as string[]);
      const infoName = files.find((f) => f.endsWith(".info.json"));
      if (!infoName) continue;
      const info = await loadInfo(path.join(dir, infoName));
      if (isChannelInfo(info, infoName)) continue; // yt-dlp channel/playlist metadata, not a video
      const ytId = info?.id ?? infoName.replace(/\.info\.json$/, "");
      const has = (f: string) => (files.includes(f) ? path.join(dir, f) : null);
      out.push({
        channel: ch,
        ytId,
        dir,
        relDir: `${ch.dir}/${name}`,
        infoPath: path.join(dir, infoName),
        title: info?.title ?? path.posix.basename(name).replace(/^\d{8} - /, ""),
        durationS: info?.duration ?? null,
        fps: info?.fps ?? null,
        width: info?.width ?? null,
        height: info?.height ?? null,
        views: info?.view_count ?? null,
        uploadDate: info?.upload_date ?? (/^(\d{8})/.exec(path.posix.basename(name))?.[1] ?? null),
        chapters: Array.isArray(info?.chapters) ? info!.chapters!.length : 0,
        videoFile: has(`${ytId}.mp4`) ?? (files.find((f) => f.endsWith(".mp4")) ? path.join(dir, files.find((f) => f.endsWith(".mp4"))!) : null),
        transcriptFile: has("pretrain.json"),
        shotFile: has("pretrain.json"),
        soundFile: has("sound.json"),
        ...(name.startsWith("_spares/") ? { spare: true } : {}),
      });
    }
  } else {
    const vids = path.join(base, "Videos");
    const ad = path.join(base, "Analysis Data");
    // video_index.csv is the canonical list; rank NN ↔ folder "NN - title".
    const byRank = new Map((await readCsv(path.join(base, "video_index.csv"))).map((r) => [String(r.rank ?? "").padStart(2, "0"), r]));
    for (const name of await visibleDirs(vids)) {
      const dir = path.join(vids, name);
      const files = await readdir(dir).catch(() => [] as string[]);
      const infoName = files.find((f) => f.endsWith(".info.json"));
      const filmNo = /^(\d{2})/.exec(name)?.[1] ?? "";
      const row = byRank.get(filmNo);
      if (!infoName && !files.some((f) => f.endsWith(".mp4"))) continue;
      const info = infoName ? await loadInfo(path.join(dir, infoName)) : null;
      const fallbackId = row?.url ? ytIdFromUrl(row.url) : null;
      const mp4 = files.find((f) => f.endsWith(".mp4"));
      const words = path.join(ad, "words", `${filmNo}_words.json`);
      const srt = files.find((f) => f.endsWith(".srt"));
      const feats = path.join(ad, "feats", `${filmNo}_feats.json`);
      const audio = path.join(ad, "audio", `${filmNo}_audio.txt`);
      out.push({
        channel: ch,
        ytId: info?.id ?? fallbackId ?? name,
        dir,
        relDir: `${ch.dir}/Videos/${name}`,
        infoPath: infoName ? path.join(dir, infoName) : null,
        title: info?.title ?? row?.title ?? name.replace(/^\d{2} - /, ""),
        durationS: info?.duration ?? (row?.duration_min ? Number(row.duration_min) * 60 : null),
        fps: info?.fps ?? null,
        width: info?.width ?? null,
        height: info?.height ?? null,
        views: info?.view_count ?? (row?.views ? Number(row.views) : null),
        uploadDate: info?.upload_date ?? null,
        chapters: Array.isArray(info?.chapters) ? info!.chapters!.length : 0,
        videoFile: mp4 ? path.join(dir, mp4) : null,
        transcriptFile: (await exists(words)) ? words : srt ? path.join(dir, srt) : null,
        shotFile: (await exists(feats)) ? feats : null,
        soundFile: (await exists(audio)) ? audio : null,
        filmNo,
      });
    }
  }
  return out;
}

export interface InspectResult {
  status: ReferenceStatus;
  videos: Map<string, RefVideo[]>;
}

export async function inspectReference(refRoot: string): Promise<InspectResult> {
  const videos = new Map<string, RefVideo[]>();
  const owner = new Map<string, string>(); // ytId → channel id
  for (const ch of CHANNELS) {
    const vs = await discoverVideos(refRoot, ch);
    videos.set(ch.id, vs);
    for (const v of vs) owner.set(v.ytId, ch.id);
  }

  const doneFiles: ReferenceStatus["doneFiles"] = [];
  const allDone = (await readdir(refRoot).catch(() => [] as string[])).filter((f) => /^done.*\.txt$/.test(f)).sort();
  const doneCache = new Map<string, { lines: number; ids: string[] }>();
  for (const f of allDone) {
    const d = await readDoneFile(path.join(refRoot, f));
    doneCache.set(f, d);
    const channels: Record<string, number> = {};
    for (const id of d.ids) {
      const c = owner.get(id) ?? "unknown";
      channels[c] = (channels[c] ?? 0) + 1;
    }
    doneFiles.push({ file: f, lines: d.lines, ids: d.ids.length, channels });
  }

  const channels: Record<string, CorpusStatus> = {};
  for (const ch of CHANNELS) {
    const vs = videos.get(ch.id) ?? [];
    const onDisk = new Set(vs.map((v) => v.ytId));
    let listed: string[] = [];
    let doneFile: string | null = ch.doneFile;
    if (ch.doneFile) listed = doneCache.get(ch.doneFile)?.ids ?? (await readDoneFile(path.join(refRoot, ch.doneFile))).ids;
    else {
      // Big Company: no done file; its canonical list is video_index.csv.
      const idx = path.join(refRoot, ch.dir, "video_index.csv");
      if (await exists(idx)) {
        doneFile = `${ch.dir}/video_index.csv`;
        listed = (await readCsv(idx)).map((r) => ytIdFromUrl(r.url ?? "")).filter((x): x is string => Boolean(x));
      }
    }
    const listedSet = new Set(listed);
    const foreignIds = listed.filter((id) => !onDisk.has(id) && owner.has(id)).map((id) => ({ id, channel: owner.get(id)! }));
    const missingOnDisk = listed.filter((id) => !onDisk.has(id) && !owner.has(id)).sort();
    const notInDoneFile = [...onDisk].filter((id) => !listedSet.has(id)).sort();
    const doneAndOnDisk = listed.filter((id) => onDisk.has(id)).length;
    channels[ch.id] = {
      doneFile,
      doneIds: listed.length - foreignIds.length,
      onDisk: onDisk.size,
      doneAndOnDisk,
      missingOnDisk,
      notInDoneFile,
      foreignIds: foreignIds.sort((a, b) => a.id.localeCompare(b.id)),
      withVideoFile: vs.filter((v) => v.videoFile).length,
      withTranscript: vs.filter((v) => v.transcriptFile).length,
      withShotAnalysis: vs.filter((v) => v.shotFile).length,
      withSoundAnalysis: vs.filter((v) => v.soundFile).length,
      complete: listed.length > 0 && missingOnDisk.length === 0 && notInDoneFile.length === 0,
    };
  }

  const status = ReferenceStatus.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    referenceRoot: path.relative(process.cwd(), refRoot) || ".",
    doneFiles,
    channels,
  });
  return { status, videos };
}

export async function writeReferenceStatus(refRoot: string, dataDir: string) {
  const r = await inspectReference(refRoot);
  const out = path.join(dataDir, "reference-status.json");
  const write = await writeStableJson(out, ReferenceStatus, r.status, [refRoot]);
  return { ...r, outPath: out, write };
}
