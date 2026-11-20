import type { ResolvedMedia, StoryboardShot } from "@opumia/contracts";
import { compactOf, displayOf, spokenMatch, type SpokenNumber } from "./parity.js";

/**
 * Asset-aware scene composer. Runs after the resolver, before layers are built: every designed layout is checked
 * against what REALLY resolved for its beat, and swapped for a layout the assets can carry — never a placeholder.
 * Then the scene grammar is enforced: the same layout never appears twice within `minRepeatGapS`.
 *
 *  hero_face  + portrait (image)        → HeroFaceSplit with the portrait
 *  hero_face  − portrait                → name text slam over the sharp footage (no monogram, no empty panel)
 *  cutout_collage − picture             → title text slam over the borrowed plate
 *  money_figure (repeat ≤ gap)          → spoken-figure text slam; slam repeat → plain footage
 *  chart ↔ versus (repeat ≤ gap)        → the other comparison layout when the values allow, else footage
 *  any other repeat ≤ gap               → plain footage
 */
export interface ComposeResult {
  shots: StoryboardShot[];
  notes: string[];
}

type Designed = Extract<StoryboardShot["source"], { kind: "designed" }>;

export function composeScenes(o: { shots: StoryboardShot[]; byShot: Map<string, ResolvedMedia[]>; spoken: SpokenNumber[]; minRepeatGapS?: number }): ComposeResult {
  const gap = o.minRepeatGapS ?? 45;
  const notes: string[] = [];
  const shots = o.shots.map((s) => ({ ...s, source: { ...s.source } as StoryboardShot["source"] }));
  const primary = (s: StoryboardShot) => (o.byShot.get(s.id) ?? []).find((m) => m.role === "primary");
  const toFootage = (s: StoryboardShot, why: string) => {
    const bg = s.source.kind === "designed" ? ((s.source.props.background as { query?: string } | undefined)?.query ?? s.intent) : s.intent;
    s.source = { kind: "query", query: bg, mustBe: "any" };
    delete s.factIds;
    notes.push(`${s.id}: ${why} → footage`);
  };
  const slam = (s: StoryboardShot, text: string, sub: string | undefined, why: string) => {
    s.source = { kind: "designed", designed: "big_word", props: { text, ...(sub ? { sub } : {}), background: (s.source as Designed).props?.background ?? {} }, assetIds: [] };
    notes.push(`${s.id}: ${why} → text slam "${text}"`);
  };

  // 1) Asset fit.
  for (const s of shots) {
    if (s.source.kind !== "designed") continue;
    const p = s.source.props;
    const pm = primary(s);
    if (s.source.designed === "hero_face" && pm?.kind !== "image") slam(s, (() => { const n = String(p.name ?? "").replace(/\s*\(.*?\)\s*/g, " ").trim().split(/\s+/); return (n.length <= 4 ? n : n.slice(-2)).join(" "); })(), typeof p.title === "string" ? p.title : undefined, "no portrait resolved");
    else if (s.source.designed === "cutout_collage" && !pm) slam(s, String(p.title ?? "").split(/\s+/).slice(0, 2).join(" ") || s.intent.split(/\s+/).slice(0, 2).join(" "), undefined, "no subject picture");
  }

  // 2) Scene grammar: no layout twice within the gap; slams must also differ in text.
  const lastAt = new Map<string, number>();
  const slamTexts = new Set<string>();
  for (const s of shots) {
    if (s.source.kind !== "designed") continue;
    const kind = s.source.designed;
    const p = s.source.props;
    // Composed scenes are unique by construction (designed per line); the grammar gap does not apply.
    if (kind === "scene") continue;
    if (kind === "big_word") {
      const t = String(p.text ?? "").toLowerCase().trim();
      if (slamTexts.has(t)) {
        toFootage(s, `duplicate slam "${t}"`);
        continue;
      }
      slamTexts.add(t);
    }
    const prev = lastAt.get(kind);
    if (prev !== undefined && s.startS - prev < gap && kind !== "name_label") {
      if (kind === "money_figure") {
        const hit = spokenMatch(o.spoken, Number(p.value), p.prefix ? String(p.prefix) : p.suffix === "%" ? "%" : "", s.startS - 1.5, s.endS + 1, s.startS);
        const text = hit ? displayOf(hit) : compactOf(Number(p.value), p.prefix ? String(p.prefix) : "");
        if (!slamTexts.has(text.toLowerCase()) && (lastAt.get("big_word") ?? -Infinity) < s.startS - gap) {
          slam(s, text, typeof p.label === "string" ? p.label : undefined, `counter repeated within ${gap} s`);
          slamTexts.add(text.toLowerCase());
          lastAt.set("big_word", s.startS);
          continue;
        }
      } else if (kind === "chart" && Array.isArray(p.values) && p.values.length === 2 && (lastAt.get("versus") ?? -Infinity) < s.startS - gap) {
        const labels = (p.labels as string[] | undefined) ?? ["", ""];
        s.source = { kind: "designed", designed: "versus", props: { title: p.title, left: { label: labels[0], value: compactOf(Number(p.values[0]), String(p.unit ?? "")) }, right: { label: labels[1], value: compactOf(Number(p.values[1]), String(p.unit ?? "")) }, background: p.background }, assetIds: [] };
        notes.push(`${s.id}: chart repeated within ${gap} s → versus`);
        lastAt.set("versus", s.startS);
        continue;
      }
      toFootage(s, `${kind} repeated within ${gap} s`);
      continue;
    }
    lastAt.set(kind, s.startS);
  }
  return { shots, notes };
}
