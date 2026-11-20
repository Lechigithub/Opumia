import type { AssetRecord, LibraryIndex } from "@opumia/contracts";

/**
 * Licence gate shared by the director and the resolver. An asset is usable in output only if:
 *  - it has a licence on record (the 412 unlicensed assets from Sprint 1 are excluded),
 *  - it is not reference-only (Library/moments are third-party channel excerpts),
 *  - it is not a remote-catalog cache (Library/bank is never touched),
 *  - for picture assets: it is not marked generated (zero AI video/imagery).
 */
export function isUsable(a: AssetRecord): boolean {
  if (!a.provenance.license) return false;
  if (a.category === "moments" || a.category === "bank" || a.category === "thumb_cache") return false;
  if (a.provenance.rightsTier === "reference_only") return false;
  if (a.provenance.generated && a.kind !== "audio") return false;
  if (a.probeError) return false;
  return true;
}

export interface LibraryMenu {
  sfxClasses: Array<{ cls: string; use: string; count: number }>;
  overlayGroups: Array<{ group: string; count: number; note: string }>;
  music: Array<{ id: string; title: string; durationS: number; license: string; generated: boolean }>;
  objects: string[];
  eras: string[];
  cinematicSubjects: string[];
}

export function buildMenu(index: LibraryIndex): LibraryMenu {
  const usable = index.assets.filter(isUsable);
  const sfx = new Map<string, { use: string; count: number }>();
  const overlays = new Map<string, { count: number; note: string }>();
  const subjects = new Set<string>();
  const eras = new Set<string>();
  for (const a of usable) {
    if (a.category === "sfx" && typeof a.facets.class === "string") {
      const e = sfx.get(a.facets.class) ?? { use: String(a.facets.intendedUse ?? ""), count: 0 };
      e.count++;
      sfx.set(a.facets.class, e);
    }
    if (a.category === "overlays" && a.kind === "video" && typeof a.facets.group === "string") {
      const e = overlays.get(a.facets.group) ?? { count: 0, note: (a.description ?? "").slice(0, 80) };
      e.count++;
      overlays.set(a.facets.group, e);
    }
    if ((a.category === "cinematic" || a.category === "era") && typeof a.facets.subject === "string") subjects.add(a.facets.subject);
    if (a.category === "era" && typeof a.facets.decade === "string") eras.add(a.facets.decade);
  }
  return {
    sfxClasses: [...sfx.entries()].map(([cls, v]) => ({ cls, ...v })).sort((a, b) => a.cls.localeCompare(b.cls)),
    overlayGroups: [...overlays.entries()].map(([group, v]) => ({ group, ...v })).sort((a, b) => a.group.localeCompare(b.group)),
    music: usable
      .filter((a) => a.category === "music" && a.kind === "audio" && (a.probe?.durationS ?? 0) >= 45)
      .map((a) => ({ id: a.id, title: a.title ?? a.relPath, durationS: Math.round(a.probe?.durationS ?? 0), license: a.provenance.license!, generated: a.provenance.generated }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    objects: usable.filter((a) => a.category === "objects" && a.relPath.endsWith(".png")).map((a) => a.title ?? "").filter(Boolean).sort(),
    eras: [...eras].sort(),
    cinematicSubjects: [...subjects].sort(),
  };
}

/** Deterministic pick: highest quality/score, then stable by id; rotates through `used` to avoid repeats. */
export function pickFrom(assets: AssetRecord[], used: Set<string>): AssetRecord | undefined {
  const sorted = [...assets].sort((a, b) => Number(b.facets.tagScore ?? b.quality ?? 0) - Number(a.facets.tagScore ?? a.quality ?? 0) || a.id.localeCompare(b.id));
  return sorted.find((a) => !used.has(a.id)) ?? sorted[0];
}
