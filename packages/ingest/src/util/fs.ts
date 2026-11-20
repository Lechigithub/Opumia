import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";

export const toPosix = (p: string) => p.split(path.sep).join("/");

/** Stable 16-hex id. */
export const stableId = (...parts: string[]) => createHash("sha1").update(parts.join(":")).digest("hex").slice(0, 16);

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface WalkEntry {
  abs: string;
  rel: string; // posix, relative to root
  bytes: number;
  mtimeMs: number;
}

/** Recursive, read-only directory walk. `skipDir` returns true to prune a subtree. Never follows symlinks. */
export async function* walk(root: string, opts: { skipDir?: (rel: string) => boolean; skipFile?: (rel: string) => boolean } = {}, rel = ""): AsyncGenerator<WalkEntry> {
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (opts.skipDir?.(childRel)) continue;
      yield* walk(root, opts, childRel);
    } else if (e.isFile()) {
      if (opts.skipFile?.(childRel)) continue;
      const abs = path.join(root, childRel);
      try {
        const s = await stat(abs);
        yield { abs, rel: childRel, bytes: s.size, mtimeMs: Math.floor(s.mtimeMs) };
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
}

/** Count files + bytes under a directory without materializing a list. */
export async function dirSummary(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for await (const e of walk(root, { skipFile: (r) => r.endsWith(".DS_Store") })) {
    files++;
    bytes += e.bytes;
  }
  return { files, bytes };
}

/** Read JSON without ever writing. Retries a few times in case another process is mid-write. */
export async function readJsonSafe<T = unknown>(p: string, retries = 2): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  for (let i = 0; ; i++) {
    try {
      const txt = await readFile(p, "utf8");
      return { ok: true, value: JSON.parse(txt) as T };
    } catch (err) {
      if (i >= retries) return { ok: false, error: (err as Error).message.slice(0, 200) };
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

/** Guard: refuse to write anywhere inside a protected (read-only) root. */
export function assertWritable(target: string, protectedRoots: string[]) {
  const t = path.resolve(target);
  for (const root of protectedRoots) {
    const r = path.resolve(root);
    if (t === r || t.startsWith(r + path.sep)) throw new Error(`refusing to write inside read-only root: ${t}`);
  }
}

/** Atomic write: temp file in the same dir, fsync, rename. Skips the write when content is unchanged. */
export async function atomicWrite(target: string, data: string, protectedRoots: string[] = []): Promise<"written" | "unchanged"> {
  assertWritable(target, protectedRoots);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    if ((await readFile(target, "utf8")) === data) return "unchanged";
  } catch {
    /* new file */
  }
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return "written";
}

/** Validate with a Zod schema, then write pretty JSON atomically. */
export async function writeValidatedJson<T>(target: string, schema: ZodType<T>, value: unknown, protectedRoots: string[] = []) {
  const parsed = schema.parse(value);
  return atomicWrite(target, JSON.stringify(parsed, null, 2) + "\n", protectedRoots);
}

/**
 * Write JSON, but keep the previous `generatedAt` when nothing else changed, so re-runs on
 * unchanged inputs are byte-identical (true idempotency, no churn).
 */
export async function writeStableJson<T extends { generatedAt: string }>(target: string, schema: ZodType<T>, value: T, protectedRoots: string[] = []) {
  const prev = await readJsonSafe<T>(target, 0);
  if (prev.ok && prev.value && typeof prev.value === "object") {
    const a = JSON.stringify({ ...prev.value, generatedAt: "" });
    const b = JSON.stringify({ ...schema.parse(value), generatedAt: "" });
    if (a === b) return "unchanged" as const;
  }
  return writeValidatedJson(target, schema, value, protectedRoots);
}
