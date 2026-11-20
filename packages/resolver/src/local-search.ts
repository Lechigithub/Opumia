import type { AssetRecord, LibraryIndex } from "@opumia/contracts";
import { isUsable } from "@opumia/agents";

export interface LocalDoc {
  key: string; // assetId or assetId#segmentId
  asset: AssetRecord;
  kind: "video" | "image";
  text: string;
  inS: number;
  outS: number | null;
  decade: number | null; // e.g. 1920
}

const STOP = new Set("a an the of in on at to for and or with from by is are was were be as it its this that these those into over under shot footage video photo image documentary".split(" "));
export const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));

const decadeOf = (a: AssetRecord): number | null => {
  const d = a.facets.decade ?? a.facets.era;
  if (typeof d === "string") {
    const m = /(\d{4})s/.exec(d);
    if (m) return Number(m[1]);
    if (/modern/i.test(d)) return 2010;
  }
  if (typeof a.facets.year === "number") return Math.floor(a.facets.year / 10) * 10;
  const m = /\b(18|19|20)(\d)\d\b/.exec(a.relPath);
  return m ? Number(`${m[1]}${m[2]}0`) : null;
};

/** Build searchable docs from usable picture assets (segments of PD films become their own docs). */
export function buildDocs(index: LibraryIndex): LocalDoc[] {
  const docs: LocalDoc[] = [];
  for (const a of index.assets) {
    if (!isUsable(a)) continue;
    if (!["footage", "cinematic", "era", "objects"].includes(a.category)) continue;
    if (a.kind !== "video" && a.kind !== "image") continue;
    if (a.category === "objects" && !a.relPath.endsWith(".png")) continue;
    const base = [a.title, a.description, a.tags.join(" "), a.facets.subject, a.facets.feature, Array.isArray(a.facets.themes) ? a.facets.themes.join(" ") : ""].filter(Boolean).join(" ");
    const decade = decadeOf(a);
    if (a.segments?.length && a.category === "footage") {
      for (const s of a.segments) {
        if (!s.caption || s.outS - s.inS < 1.2) continue;
        if (/credits|title card|intertitle|text on screen/i.test(s.caption)) continue;
        docs.push({ key: `${a.id}#${s.id}`, asset: a, kind: "video", text: `${s.caption} ${a.facets.subject ?? ""}`, inS: s.inS, outS: s.outS, decade });
      }
      continue;
    }
    const inS = typeof a.facets.start_s === "number" ? a.facets.start_s : 0;
    const outS = typeof a.facets.end_s === "number" ? a.facets.end_s : (a.probe?.durationS ?? null);
    docs.push({ key: a.id, asset: a, kind: a.kind, text: base, inS, outS, decade });
  }
  return docs;
}

/** Plain BM25 over the docs. */
export class Bm25 {
  private df = new Map<string, number>();
  private tf: Array<Map<string, number>> = [];
  private len: number[] = [];
  private avg = 1;
  constructor(readonly docs: LocalDoc[]) {
    for (const d of docs) {
      const m = new Map<string, number>();
      const toks = tokenize(d.text);
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
    }
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
  }
  search(query: string, opts: { kind?: "video" | "image" | "any"; decade?: number | null; limit: number; exclude?: Set<string> }) {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const out: Array<{ doc: LocalDoc; score: number }> = [];
    for (let i = 0; i < N; i++) {
      const d = this.docs[i]!;
      if (opts.kind && opts.kind !== "any" && d.kind !== opts.kind) continue;
      if (opts.exclude?.has(d.key)) continue;
      let s = 0;
      for (const t of q) {
        const f = this.tf[i]!.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        s += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (this.len[i]! / this.avg)));
      }
      if (s <= 0) continue;
      if (opts.decade && d.decade) s *= Math.abs(d.decade - opts.decade) <= 10 ? 1.35 : Math.abs(d.decade - opts.decade) >= 40 ? 0.6 : 1;
      if (d.asset.quality) s *= 0.85 + d.asset.quality * 0.05;
      out.push({ doc: d, score: s });
    }
    return out.sort((a, b) => b.score - a.score || a.doc.key.localeCompare(b.doc.key)).slice(0, opts.limit);
  }
}
