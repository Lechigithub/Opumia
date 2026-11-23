/**
 * Craft inventory: real 3D props — licensed glTF models (Poly Haven, CC0) placed in a scene and rendered by Three.js
 * inside the Remotion frame. Never a generated model. The catalogue is cached for a day; a model is downloaded once
 * (data/.cache/props3d/<id>/) and copied into the film's public folder; every use is credited in props.json.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const UA = { "User-Agent": "opumia-renderer" };
interface PhAsset { name: string; categories: string[]; tags: string[]; authors: Record<string, string> }

async function catalogue(dataDir: string): Promise<Record<string, PhAsset>> {
  const f = path.join(dataDir, ".cache", "polyhaven-models.json");
  const hit = await readFile(f, "utf8").then((t) => JSON.parse(t) as { at: number; assets: Record<string, PhAsset> }, () => null);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.assets;
  const res = await fetch("https://api.polyhaven.com/assets?t=models", { headers: UA });
  if (!res.ok) throw new Error(`Poly Haven catalogue: HTTP ${res.status}`);
  const assets = (await res.json()) as Record<string, PhAsset>;
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify({ at: Date.now(), assets }) + "\n");
  await rename(f + ".tmp", f);
  return assets;
}

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
const singular = (w: string) => w.replace(/(ies)$/, "y").replace(/s$/, "");

/** The best-matching CC0 model for a description ("a vintage office chair", "gold bars", "a courtroom bench"). */
export async function findProp3d(o: { dataDir: string; query: string; avoid?: Set<string> }): Promise<{ id: string; name: string; score: number } | null> {
  const cat = await catalogue(o.dataDir);
  const q = words(o.query).map(singular);
  if (!q.length) return null;
  let best: { id: string; name: string; score: number } | null = null;
  for (const [id, a] of Object.entries(cat)) {
    if (o.avoid?.has(id)) continue;
    const hay = new Set([...words(a.name), ...a.tags.flatMap(words), ...a.categories.flatMap(words)].map(singular));
    const nameW = new Set(words(a.name).map(singular));
    const score = q.reduce((s, w) => s + (nameW.has(w) ? 2 : hay.has(w) ? 1 : 0), 0) / q.length;
    if (score > 0 && (!best || score > best.score)) best = { id, name: a.name, score };
  }
  return best && best.score >= 0.5 ? best : null;
}

/** Download a model's glTF (1k textures) once, copy it into the film's public folder; returns its public path. */
export async function materializeProp3d(o: { dataDir: string; publicDir: string; id: string }): Promise<{ publicPath: string; credit: string }> {
  const cacheDir = path.join(o.dataDir, ".cache", "props3d", o.id);
  const gltfName = `${o.id}.gltf`;
  if (!existsSync(path.join(cacheDir, gltfName))) {
    const res = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(o.id)}`, { headers: UA });
    if (!res.ok) throw new Error(`Poly Haven files ${o.id}: HTTP ${res.status}`);
    const files = (await res.json()) as { gltf?: Record<string, { gltf: { url: string; include?: Record<string, { url: string }> } }> };
    const g = files.gltf?.["1k"]?.gltf ?? Object.values(files.gltf ?? {})[0]?.gltf;
    if (!g) throw new Error(`no glTF for ${o.id}`);
    const get = async (url: string, to: string) => {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`download ${url}: HTTP ${r.status}`);
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, Buffer.from(await r.arrayBuffer()));
    };
    await get(g.url, path.join(cacheDir, gltfName));
    for (const [rel, f] of Object.entries(g.include ?? {})) await get(f.url, path.join(cacheDir, rel));
  }
  const dest = path.join(o.publicDir, "props", o.id);
  if (!existsSync(path.join(dest, gltfName))) {
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(cacheDir, dest, { recursive: true });
  }
  const cat = await catalogue(o.dataDir).catch(() => ({} as Record<string, PhAsset>));
  const authors = Object.keys(cat[o.id]?.authors ?? {}).join(", ");
  return { publicPath: `props/${o.id}/${gltfName}`, credit: `"${cat[o.id]?.name ?? o.id}"${authors ? ` by ${authors}` : ""}, Poly Haven (CC0) — https://polyhaven.com/a/${o.id}` };
}
