import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Cloud mode (inside the renderer container): Library/Reference are NOT on local disk. Files are fetched
 * on demand from R2 through the Worker's authenticated proxy into the container's cache dirs, once.
 * Locally (no OPUMIA_REMOTE_URL) these helpers are no-ops, so the read-only rule for Library/Reference holds.
 */
export const remoteEnabled = () => Boolean(process.env.OPUMIA_REMOTE_URL && process.env.OPUMIA_INTERNAL_TOKEN);

const auth = () => ({ authorization: `Bearer ${process.env.OPUMIA_INTERNAL_TOKEN}` });

export async function r2Get(key: string, dest: string): Promise<boolean> {
  const res = await fetch(`${process.env.OPUMIA_REMOTE_URL}/internal/r2/${encodeURIComponent(key)}`, { headers: auth(), signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  await rename(tmp, dest);
  return true;
}

export async function r2Put(key: string, body: Buffer | Uint8Array): Promise<void> {
  const res = await fetch(`${process.env.OPUMIA_REMOTE_URL}/internal/r2/${encodeURIComponent(key)}`, { method: "PUT", headers: auth(), body: new Blob([new Uint8Array(body)]), signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`R2 put ${key}: ${res.status}`);
}

export async function r2List(prefix: string): Promise<Array<{ key: string; size: number; etag: string }>> {
  const res = await fetch(`${process.env.OPUMIA_REMOTE_URL}/internal/r2-list?prefix=${encodeURIComponent(prefix)}`, { headers: auth(), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`R2 list ${prefix}: ${res.status}`);
  return (await res.json()) as Array<{ key: string; size: number; etag: string }>;
}

/**
 * Return a local path for root/rel. In cloud mode a missing file is hydrated from R2 (`<prefix>/<rel>`).
 * R2 layout mirrors the local trees: library/… = Library/…, reference/… = Reference/….
 */
export async function ensureLocal(root: string, rel: string, prefix: "library" | "reference"): Promise<string> {
  const p = path.join(root, rel);
  if (!remoteEnabled()) return p;
  if ((await stat(p).catch(() => null))?.size) return p;
  const ok = await r2Get(`${prefix}/${rel.split(path.sep).join("/")}`, p);
  if (!ok) throw new Error(`missing in R2: ${prefix}/${rel}`);
  return p;
}
