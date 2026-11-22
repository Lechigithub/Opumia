/**
 * Edit-rhythm and sound-against-picture library (build list D15, D16): real passages of the channel's films as edit
 * decision lists — every shot with its length, what was on screen, how it was cut in, where the cut sat against the
 * voice, the hits on it, music cues and drop-outs — retrievable by what is being said and where in the film.
 * The editor, sound and music agents study the passage nearest to what they are cutting, not averages.
 */
import type { ChannelId } from "@opumia/contracts";
import type { ReferenceShot } from "@opumia/ingest";
import { segmentOfShot, type Segment } from "./channel-profile.js";
import { loadReferenceIndex } from "./reference-index.js";
import { nearestByMeaning } from "./retrieve.js";

export interface Passage { film: string; title: string; t0: number; t1: number; segment: Segment; shots: ReferenceShot[]; text: string }

const f1 = (x: number) => x.toFixed(1);

/** A stretch of a real film as an edit decision list. */
export function edl(shots: ReferenceShot[], title = ""): string {
  if (!shots.length) return "";
  const t0 = shots[0]!.t0;
  const lines = shots.map((s) => {
    const marks = [
      s.transitionIn && s.transitionIn !== "cut" && s.transitionIn !== "start" ? s.transitionIn : "",
      s.cutInPause ? "cut in a pause" : `cut ${s.cutToWord.toFixed(2)} s from a word`,
      s.hitOnCut ? `HIT on cut: ${s.hitOnCut}` : "",
      s.hitInShot ? `hit inside: ${s.hitInShot}` : "",
      s.musicDrop ? "music drops out" : "",
      s.cueChange ? "music cue changes" : "",
    ].filter(Boolean).join("; ");
    return `  +${f1(s.t0 - t0).padStart(5)}s  ${f1(s.t1 - s.t0).padStart(4)}s  ${`${s.picture}${s.overlay === "text_slam" ? "+text" : ""}`.padEnd(20)} ${marks}${s.text ? ` · on screen: "${s.text.slice(0, 60)}"` : ""}${s.line ? ` · said: "${s.line.slice(0, 90)}"` : ""}`;
  });
  return `${title ? `"${title}" ` : ""}${f1(t0)}–${f1(shots.at(-1)!.t1)} s (${shots.length} shots)\n${lines.join("\n")}`;
}

/** Real passages nearest in meaning (and, if given, in film position) to what is being cut. */
export async function findPassages(o: { data: string; channel: ChannelId; said: string; segment?: Segment; seconds?: number; k?: number }): Promise<Passage[]> {
  const ix = await loadReferenceIndex(o.data);
  if (!ix) return [];
  const span = o.seconds ?? 20;
  const films = new Map(ix.manifest.films.map((f) => [f.id, f]));
  const byFilm = new Map<string, ReferenceShot[]>();
  for (const s of ix.shots) if (s.channel === o.channel) (byFilm.get(s.film) ?? byFilm.set(s.film, []).get(s.film)!).push(s);
  // candidate windows: one every ~span seconds of every film, in the asked segment
  const cands: Passage[] = [];
  for (const [film, shots] of byFilm) {
    const f = films.get(film)!;
    let i = 0;
    while (i < shots.length) {
      const start = shots[i]!;
      const win: ReferenceShot[] = [];
      let j = i;
      while (j < shots.length && shots[j]!.t1 - start.t0 <= span) win.push(shots[j++]!);
      if (!win.length) win.push(shots[j++]!);
      const seg = segmentOfShot(start, f);
      if (!o.segment || seg === o.segment) cands.push({ film, title: f.title, t0: start.t0, t1: win.at(-1)!.t1, segment: seg, shots: win, text: win.map((s) => s.line).join(" ") });
      i = Math.max(j, i + 1);
    }
  }
  // cheap prefilter by shared words, then rank by meaning
  const q = new Set(o.said.toLowerCase().split(/[^a-z0-9$%]+/).filter((w) => w.length > 3));
  const pre = cands.map((c, i) => ({ i, s: c.text.toLowerCase().split(/[^a-z0-9$%]+/).filter((w) => q.has(w)).length + (i % 97) / 1e4 })).sort((a, b) => b.s - a.s).slice(0, 120).map((x) => cands[x.i]!);
  const idx = await nearestByMeaning(`narration being cut: "${o.said.slice(0, 600)}"`, pre.map((c) => c.text.slice(0, 220)), o.k ?? 3, "real narration passage");
  return idx.map((i) => pre[i]!).filter(Boolean);
}
