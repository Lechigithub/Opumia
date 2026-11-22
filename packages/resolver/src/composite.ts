/**
 * Compositor (build list G23): a cut-out laid over footage should look like it is IN that footage. For every cut-out
 * over a footage backdrop that the designer did not composite by hand, this reads a frame of the footage and sets:
 *  - matchColor   the footage's mean colour, laid over the subject at soft-light (colour matching);
 *  - lightAngle   the direction the footage's light falls (senses:measureDesign plane fit), so the subject is lit
 *                 from the same side — and darker on the side away from it;
 *  - soften       a fraction of a pixel of edge blur: cut edges stop looking cut with scissors;
 *  - contactShadow when the subject stands low in the frame (it rests on something).
 * Deterministic (ffmpeg + plain TS), no model call. Nothing is painted: only the picture's own pixels are tinted,
 * shaded and blurred.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FilmDesignSystem, ResolutionReport, ScenePlan } from "@opumia/contracts";
import { measureDesign, run } from "@opumia/senses";

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

async function meanColour(file: string): Promise<[number, number, number] | null> {
  const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=1:1:flags=area", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer" } as never).catch(() => null);
  const b = r?.stdout as unknown as Buffer | undefined;
  return b && b.length >= 3 ? [b[0]!, b[1]!, b[2]!] : null;
}

export async function compositeScenes(o: { plan: ScenePlan; resolution: ResolutionReport; jobDir: string; design?: FilmDesignSystem; log?: (s: string) => void }): Promise<{ plan: ScenePlan; touched: number }> {
  const dir = path.join(o.jobDir, "composite");
  await mkdir(dir, { recursive: true });
  let touched = 0;
  const scenes = [];
  // Logos and line icons are flat graphics: they are never lit or tinted.
  const flat = (shotId: string, slot: number) => /logo|icon|wordmark|emblem/i.test(o.resolution.media.find((m) => m.shotId === shotId && m.role === "layer" && m.slot === slot)?.depicts ?? "");
  for (const sc0 of o.plan.scenes) {
    const sc = { ...sc0, elements: sc0.elements.map((e) => (e.type === "cutout" && flat(sc0.shotId, e.slot) && !e.matchColor ? { ...e, matchColor: "#808080", matchStrength: 0 } : e)) };
    const cuts = sc.elements.filter((e) => e.type === "cutout");
    const prim = o.resolution.media.find((m) => m.shotId === sc.shotId && m.role === "primary");
    if (cuts.length && sc.backdrop !== "footage" && o.design) {
      // A designed stage has no footage to read: the subject takes the stage's colour and a key light from the top
      // left (the usual studio key), soft edges, and a contact shadow when it stands low.
      const pal = o.design.palette as Record<string, string>;
      const stage = sc.backdrop === "paper" ? pal.paper : pal.surface ?? pal.primary;
      const elements = sc.elements.map((e) => {
        if (e.type !== "cutout" || e.matchColor) return e;
        touched++;
        const out = { ...e } as typeof e;
        if (stage && /^#[0-9a-fA-F]{6}$/.test(stage)) { out.matchColor = stage; out.matchStrength = 0.3; }
        out.lightAngle = 135;
        out.lightStrength = 0.35;
        if (out.soften === undefined) out.soften = 0.5;
        if (out.contactShadow === undefined && e.y + e.w * 0.6 >= 0.8) out.contactShadow = 0.3;
        return out;
      });
      scenes.push({ ...sc, elements });
      continue;
    }
    if (!cuts.length || sc.backdrop !== "footage" || !prim || !existsSync(prim.localPath)) { scenes.push(sc); continue; }
    const frame = path.join(dir, `${sc.shotId}.jpg`);
    if (!existsSync(frame)) {
      const at = prim.kind === "video" ? Math.max(0, (prim.durationS ?? 2) / 2) : 0;
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...(prim.kind === "video" ? ["-ss", at.toFixed(2)] : []), "-i", prim.localPath, "-frames:v", "1", "-vf", "scale=320:-2", frame]).catch(() => null);
    }
    if (!existsSync(frame)) { scenes.push(sc); continue; }
    const mean = await meanColour(frame);
    const d = await measureDesign(frame).catch(() => null);
    const elements = sc.elements.map((e) => {
      if (e.type !== "cutout" || e.matchColor) return e;
      touched++;
      const out = { ...e } as typeof e;
      if (mean) { out.matchColor = `#${hex2(mean[0])}${hex2(mean[1])}${hex2(mean[2])}`; out.matchStrength = 0.45; }
      if (d && d.light >= 0.12) {
        // measureDesign.lightDeg is the direction from bright to dark in screen coordinates (x right, y down);
        // a CSS gradient angle is measured from "to top", clockwise.
        const rad = (d.lightDeg * Math.PI) / 180;
        out.lightAngle = Math.round(((Math.atan2(Math.cos(rad), -Math.sin(rad)) * 180) / Math.PI + 360) % 360);
        out.lightColor = mean ? `#${hex2(mean[0] + (255 - mean[0]) * 0.7)}${hex2(mean[1] + (255 - mean[1]) * 0.7)}${hex2(mean[2] + (255 - mean[2]) * 0.7)}` : "#fff4e0";
        out.lightStrength = Math.round(Math.min(0.55, 0.2 + d.light * 0.5) * 100) / 100;
      }
      if (out.soften === undefined) out.soften = 0.6;
      // resting low in the frame: it stands on something
      if (out.contactShadow === undefined && e.y + e.w * 0.6 >= 0.8) out.contactShadow = 0.35;
      return out;
    });
    scenes.push({ ...sc, elements });
  }
  if (touched) o.log?.(`  compositor: ${touched} cut-out(s) matched to their footage (colour, light, edges, contact)`);
  return { plan: { ...o.plan, scenes }, touched };
}
