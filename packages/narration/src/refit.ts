import { execFile } from "node:child_process";
import { rename, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { TimedScript } from "@opumia/contracts";
import { SR } from "./passage.js";

const run = promisify(execFile);

/**
 * The voice ladder's first rung (build list 3, item 15): a narration a little too long or too short is fitted by
 * changing only the PAUSES between sentences — inside the silence, never the words, never the speed. Each pause is
 * scaled by `scale` (kept between 0.12 s and its own length + 0.6 s): a shorter pause is cut in its middle with a
 * crossfade; a longer one is filled with its own room sound. Word times follow. No model and no new take.
 */
export async function refitPauses(t: TimedScript, scale: number, outPath: string): Promise<{ script: TimedScript; before: number; after: number; pauses: number }> {
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", t.voice.audioPath, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { encoding: "buffer", maxBuffer: 1 << 30 });
  const buf = stdout as unknown as Buffer;
  const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const flat = t.segments.flatMap((sg, si) => sg.words.map((w, wi) => ({ si, wi, w })));
  const XF = Math.round(0.02 * SR);
  const MARGIN = 0.03;
  const out: Float32Array[] = [];
  let cursor = 0; // samples of the source copied so far
  let shift = 0; // seconds added (negative: removed) before the current point
  const shifts: number[] = new Array(flat.length).fill(0);
  let pauses = 0;
  for (let k = 0; k + 1 < flat.length; k++) {
    const a = flat[k]!, b = flat[k + 1]!;
    shifts[k] = shift;
    const sentenceEnd = /[.?!]["”')\]]*$/.test(a.w.word) || a.si !== b.si;
    const gap = b.w.startS - a.w.endS;
    if (!sentenceEnd || gap < 0.12) continue;
    const want = Math.min(gap + 0.6, Math.max(0.12, gap * scale));
    const s0 = Math.round((a.w.endS + MARGIN) * SR), s1 = Math.round((b.w.startS - MARGIN) * SR);
    const body = s1 - s0;
    const newBody = Math.max(2 * XF, Math.round((want - 2 * MARGIN) * SR));
    if (body <= 2 * XF || Math.abs(newBody - body) < 0.01 * SR) continue;
    pauses++;
    out.push(audio.subarray(cursor, s0));
    if (newBody < body) {
      // keep the two ends of the pause, crossfaded where they meet
      const half = Math.floor(newBody / 2), rest = newBody - half, t0 = s1 - rest;
      const joined = new Float32Array(newBody);
      joined.set(audio.subarray(s0, s0 + half), 0);
      for (let i = 0; i < rest; i++) {
        let v = audio[t0 + i]!;
        if (i < XF) { const g = i / XF; v = audio[s0 + half + i]! * (1 - g) + v * g; }
        joined[half + i] = v;
      }
      out.push(joined);
    } else {
      // longer: the pause's own room, looped
      const room = audio.subarray(s0, s1);
      const filled = new Float32Array(newBody);
      for (let i = 0; i < newBody; i++) filled[i] = room[i % room.length]!;
      out.push(filled);
    }
    cursor = s1;
    shift += (newBody - body) / SR;
  }
  shifts[flat.length - 1] = shift;
  out.push(audio.subarray(cursor));
  const total = out.reduce((n, x) => n + x.length, 0);
  const pcm = new Float32Array(total);
  let o = 0;
  for (const x of out) (pcm.set(x, o), (o += x.length));
  const raw = `${outPath}.f32`;
  await writeFile(raw, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", raw, "-c:a", "libmp3lame", "-b:a", "192k", `${outPath}.tmp.mp3`], { timeout: 300_000 });
  await rename(`${outPath}.tmp.mp3`, outPath);
  await unlink(raw).catch(() => {});
  // word k moves by every pause change before it
  const moveOf = new Map(flat.map((f, k) => [`${f.si}:${f.wi}`, shifts[k]!]));
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const segments = t.segments.map((sg, si) => {
    const words = sg.words.map((w, wi) => ({ ...w, startS: r(w.startS + moveOf.get(`${si}:${wi}`)!), endS: r(w.endS + moveOf.get(`${si}:${wi}`)!) }));
    return { ...sg, words, startS: r(words[0]?.startS ?? sg.startS + (moveOf.get(`${si}:0`) ?? 0)), endS: r(words.at(-1)?.endS ?? sg.endS) };
  });
  const durationS = r(total / SR);
  return { script: TimedScript.parse({ ...t, segments, voice: { ...t.voice, audioPath: outPath }, durationS }), before: t.durationS, after: durationS, pauses };
}
