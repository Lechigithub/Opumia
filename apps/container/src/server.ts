/**
 * Renderer container entrypoint (Cloudflare Containers). Runs one pipeline stage per request with the
 * exact same `produce` code as the local CLI:
 *   1. pull data/ (index, profiles, style packs, calibration, overrides) and jobs/<id>/ from R2,
 *   2. run `produce --until <stage>` (earlier stages are cached in the job folder and skipped),
 *   3. push the job folder back to R2 (raw stock downloads and QA scratch frames excluded).
 * Library/Reference files are hydrated on demand by @opumia/ingest's ensureLocal (OPUMIA_REMOTE_URL).
 */
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { r2Get, r2List, r2Put, remoteEnabled } from "@opumia/ingest";
import { produce, STAGES } from "../../cli/src/produce.js";

const ROOT = process.env.OPUMIA_ROOT ?? "/work";
const DATA = process.env.OPUMIA_DATA_DIR ?? path.join(ROOT, "data");
const LIBRARY = process.env.OPUMIA_LIBRARY_DIR ?? path.join(ROOT, "Library");
const REFERENCE = process.env.OPUMIA_REFERENCE_DIR ?? path.join(ROOT, "Reference");
const PORT = Number(process.env.PORT ?? 8080);
const SKIP_UP = /(^|\/)(downloads|qa_frames)\//;

let busy = false;

async function pullPrefix(prefix: string, localDir: string) {
  let n = 0;
  for (const o of await r2List(prefix)) {
    const rel = o.key.slice(prefix.length);
    const dest = path.join(localDir, rel);
    const st = await stat(dest).catch(() => null);
    if (st && st.size === o.size) continue; // already current
    await r2Get(o.key, dest);
    n++;
  }
  return n;
}

async function* walkFiles(dir: string, rel = ""): AsyncGenerator<string> {
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walkFiles(dir, r);
    else if (e.isFile()) yield r;
  }
}

async function pushJob(jobId: string) {
  const local = path.join(ROOT, "out", jobId);
  const remote = new Map((await r2List(`jobs/${jobId}/`)).map((o) => [o.key, o.size]));
  const pushed: string[] = [];
  for await (const rel of walkFiles(local)) {
    if (SKIP_UP.test(rel)) continue;
    const key = `jobs/${jobId}/${rel}`;
    const size = (await stat(path.join(local, rel))).size;
    if (remote.get(key) === size && !rel.endsWith(".json")) continue;
    await r2Put(key, await readFile(path.join(local, rel)));
    pushed.push(rel);
  }
  return pushed;
}

// In the container a long wait would outlive the workflow step's timeout: pauses longer than ~9 minutes are handed to
// the workflow, which sleeps durably (step.sleepUntil) and runs the stage again.
process.env.OPUMIA_MAX_PAUSE_H ??= "0.15";

const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health") return send(200, { ok: true, busy, remote: remoteEnabled() });
  if (req.method !== "POST" || req.url !== "/stage") return send(404, { error: "not found" });
  if (req.headers.authorization !== `Bearer ${process.env.OPUMIA_INTERNAL_TOKEN}`) return send(401, { error: "unauthorized" });
  if (busy) return send(409, { error: "busy" });
  busy = true;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    const b = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { jobId: string; stage: string; topic: string; channel: string; aspect: "9:16" | "16:9"; durationS: number };
    if (!(STAGES as readonly string[]).includes(b.stage)) throw new Error(`unknown stage ${b.stage}`);
    await pullPrefix("data/", DATA);
    await pullPrefix(`jobs/${b.jobId}/`, path.join(ROOT, "out", b.jobId));
    const logs: string[] = [];
    const r = await produce({ root: ROOT, library: LIBRARY, reference: REFERENCE, data: DATA, topic: b.topic, channel: b.channel, aspect: b.aspect, durationS: b.durationS, job: b.jobId, redo: [], until: b.stage as (typeof STAGES)[number], log: (s) => (logs.push(s), console.log(s)) });
    const outputs = await pushJob(b.jobId);
    const finalKey = "finalPath" in r && r.finalPath ? `jobs/${b.jobId}/${path.basename(r.finalPath)}` : undefined;
    send(200, { ok: true, stage: b.stage, outputs, ...("report" in r && r.report ? { verdict: r.report.verdict } : {}), ...(finalKey ? { finalKey } : {}), log: logs.slice(-40) });
  } catch (err) {
    // build list 3, part D: a pause outside the platform is not a failure — the progress is pushed (stages are cached)
    // and the workflow sleeps until access is expected back, then runs the stage again.
    const pe = err as { resumeAt?: string; failure?: { provider: string; kind: string; message: string } };
    if (pe?.resumeAt && pe.failure) {
      const b2 = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { jobId: string };
      await pushJob(b2.jobId).catch(() => null);
      return send(200, { ok: false, paused: { provider: pe.failure.provider, kind: pe.failure.kind, resumeAt: pe.resumeAt, message: pe.failure.message.slice(0, 300) } });
    }
    send(500, { ok: false, error: (err as Error).message.slice(0, 2000) });
  } finally {
    busy = false;
  }
});

server.listen(PORT, () => console.log(`opumia renderer listening on :${PORT} (remote=${remoteEnabled()})`));
