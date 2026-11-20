import { readFile } from "node:fs/promises";
import path from "node:path";
import { geoBounds, geoContains, geoNaturalEarth1, geoPath, type GeoPermissibleObjects } from "d3-geo";

interface Feature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: GeoPermissibleObjects;
}

let cache: Feature[] | null = null;
async function countries(libraryRoot: string): Promise<Feature[]> {
  if (cache) return cache;
  // Natural Earth 1:50m admin-0 countries (public domain), read-only from the Library.
  const j = JSON.parse(await readFile(path.join(libraryRoot, "maps", "ne_50m_admin_0_countries.geojson"), "utf8")) as { features: Feature[] };
  cache = j.features;
  return cache;
}

export interface MapPoint {
  name: string;
  lon: number;
  lat: number;
}

const CANVAS = { w: 4000, h: 2100 };

/** Pre-project country outlines + points so the Remotion map scene is pure SVG (fast, deterministic). */
export async function projectMap(libraryRoot: string, pts: MapPoint[]) {
  const feats = await countries(libraryRoot);
  const proj = geoNaturalEarth1().fitSize([CANVAS.w, CANVAS.h], { type: "Sphere" } as GeoPermissibleObjects);
  const gp = geoPath(proj).digits(1);
  const valid = pts.filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  const points = valid.map((p) => {
    const xy = proj([p.lon, p.lat]) ?? [CANVAS.w / 2, CANVAS.h / 2];
    return { name: p.name, x: Math.round(xy[0] * 10) / 10, y: Math.round(xy[1] * 10) / 10 };
  });
  // Tight box around the points (min 600×400 canvas units), wide box ~3× for the flyover start.
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : CANVAS.w / 2;
  const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : CANVAS.h / 2;
  const tw = Math.max(600, (xs.length ? Math.max(...xs) - Math.min(...xs) : 0) * 1.6);
  const th = Math.max(400, (ys.length ? Math.max(...ys) - Math.min(...ys) : 0) * 1.6);
  const to: [number, number, number, number] = [cx - tw / 2, cy - th / 2, tw, th];
  const from: [number, number, number, number] = [cx - tw * 1.6, cy - th * 1.6, tw * 3.2, th * 3.2];
  // Only countries near the view (keeps props small).
  const pad = 0.6;
  const view = { x0: from[0] - from[2] * pad, y0: from[1] - from[3] * pad, x1: from[0] + from[2] * (1 + pad), y1: from[1] + from[3] * (1 + pad) };
  const paths: Array<{ d: string; focus: boolean }> = [];
  for (const f of feats) {
    const [[x0, y0], [x1, y1]] = gp.bounds(f.geometry);
    if (x1 < view.x0 || x0 > view.x1 || y1 < view.y0 || y0 > view.y1) continue;
    const d = gp(f.geometry);
    if (!d) continue;
    const focus = valid.some((p) => geoContains(f.geometry, [p.lon, p.lat]));
    paths.push({ d, focus });
  }
  void geoBounds;
  return { paths, points, canvas: CANVAS, from, to };
}
