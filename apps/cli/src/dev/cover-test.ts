// Owner (2026-11-28): a 9:16 film's cover is its first frame (the shorts/reels feed shows it, nothing to upload); a 16:9
// film keeps a separate thumbnail. The gate must refuse a 9:16 film without its cover as frame one, and the packaging
// agent must keep a cover's words out of the strip the feed covers. Offline: tiny synthetic films, no API.
//   npx tsx apps/cli/src/dev/cover-test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coverSafeZone } from "@opumia/agents";
import { coverCheck } from "../film-agent/gate.js";

const fails: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) fails.push(what); };
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
const dir = mkdtempSync(path.join(os.tmpdir(), "cover-test-"));
try {
  const job = (name: string, aspect: string) => { const j = path.join(dir, name); execFileSync("mkdir", ["-p", j]); writeFileSync(path.join(j, "job.json"), JSON.stringify({ aspect })); return j; };
  const v = job("v", "9:16"), film = path.join(v, "film_9x16.mp4"), cover = path.join(v, "cover_9x16.jpg");
  // a 1 s vertical film of grey frames
  ff("-f", "lavfi", "-i", "color=c=gray:s=1080x1920:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", film);
  const c0 = coverCheck(v);
  expect(c0.length === 1 && !c0[0]!.pass && /no cover_9x16/.test(c0[0]!.detail), `no cover must fail: ${JSON.stringify(c0)}`);
  // a cover that is not frame one (a striped test card, so SSIM can tell it from flat grey)
  ff("-f", "lavfi", "-i", "testsrc2=s=1080x1920", "-frames:v", "1", cover);
  const past = new Date(Date.now() - 60_000); utimesSync(cover, past, past);
  const c1 = coverCheck(v);
  expect(c1.some((c) => c.id === "cover_first_frame" && !c.pass), `a film that does not open on its cover must fail: ${JSON.stringify(c1)}`);
  // the same overlay mix.ts uses: the cover on frame one only
  ff("-f", "lavfi", "-i", "color=c=gray:s=1080x1920:r=24:d=1", "-loop", "1", "-i", cover, "-filter_complex", "[1:v][0:v]scale2ref[c][b];[c]setsar=1[c1];[b][c1]overlay=0:0:enable='eq(n,0)':shortest=1[vo]", "-map", "[vo]", "-c:v", "libx264", "-pix_fmt", "yuv420p", film);
  const c2 = coverCheck(v);
  expect(c2.length === 1 && c2[0]!.pass, `a film opening on its cover must pass: ${JSON.stringify(c2)}`);
  // a cover newer than the film: the mix is stale
  const now = new Date(Date.now() + 60_000); utimesSync(cover, now, now);
  expect(coverCheck(v).some((c) => c.id === "current_mix" && !c.pass), "a cover newer than the film must ask for a new mix");
  // a 16:9 film needs no cover
  expect(coverCheck(job("h", "16:9")).length === 0, "a 16:9 film must not be asked for a cover");
  // words where the shorts feed covers the frame
  expect(coverSafeZone([{ text: "LAST $5,000", x: 0.06, y: 0.07, w: 0.8, h: 0.12 }]).length === 0, "words in the top third are safe");
  expect(coverSafeZone([{ text: "LAST $5,000", x: 0.06, y: 0.74, w: 0.8, h: 0.12 }]).length === 1, "words in the bottom fifth must be flagged");
  expect(coverSafeZone([{ text: "ALL IN", x: 0.5, y: 0.3, w: 0.48, h: 0.1 }]).length === 1, "words under the feed's buttons (right edge) must be flagged");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL\n${fails.map((f) => `- ${f}`).join("\n")}` : "cover: 8 checks pass");
process.exit(fails.length ? 1 : 0);
