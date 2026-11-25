import React from "react";
import { AbsoluteFill, Easing, Freeze, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { PALETTE } from "../types";
import { Element, KitStage } from "./Composed";
import { World, type WorldSpec } from "./Worlds";

/**
 * A continuous camera journey (owner, 2026-11-24): "the reference holds and moves continuously from scene to scene with
 * no cut … words also transition into scenes smoothly and never feel rushed". Real pictures and clips are panels in a
 * 3D space; the camera travels from one to the next with real perspective and never stops moving.
 *
 * v2 (owner: "the flights look like a slide, too little movement, low creativity"): a flight is one of four moves —
 * a slide to a neighbour, a push THROUGH the current picture into the next one behind it, a whip (fast, motion-blurred)
 * or a rise; the camera blurs with its own speed; behind everything a blurred, enlarged copy of the current picture
 * fills the frame, so no flight ever shows an empty table; while it holds, the camera keeps pushing, sliding and
 * turning; each panel can carry a cut-out (or words) on a layer in front of it, at its own depth, so the layers move
 * against each other (parallax), with text set between the picture and its subject; and a panel can be graded
 * black-and-white, duotone, double-exposed with a second picture, or defocused behind its sharp subject.
 */
type El = Parameters<typeof Element>[0]["el"];
export interface Stop {
  at: number; x: number; y: number; depth: number; ry: number; rz: number; size: number;
  slot?: number; trim?: number; look: string; world?: WorldSpec; stage?: boolean; frame: string; elements: El[];
  move?: string; fore?: El[]; foreDepth?: number; blendSlot?: number; blendTrim?: number; dof?: number; drift?: [number, number, number, number];
}
export interface JourneySpec { stops: Stop[]; travel: number; push: number; ground: string }

const LOOK: Record<string, string> = {
  natural: "contrast(1.06) saturate(1.12)",
  mono: "grayscale(1) contrast(1.35) brightness(0.92)",
  contrast: "contrast(1.3) saturate(1.2)",
  cool: "contrast(1.1) saturate(0.9) hue-rotate(-8deg) brightness(0.98)",
  warm: "contrast(1.1) saturate(1.3) sepia(0.18)",
  faded: "contrast(0.95) saturate(0.75) brightness(1.05)",
  bright: "brightness(1.75) contrast(1.08) saturate(1.15)",
  duotone: "grayscale(1) contrast(1.3) brightness(1.05)",
};
const smooth = Easing.bezier(0.45, 0, 0.2, 1);
const whipEase = Easing.bezier(0.7, 0, 0.3, 1);
const FLY: Record<string, number> = { whip: 0.45, push: 1.15, rise: 1.0, slide: 1.0 };

/** Where the camera is at time t (s). Holding: it keeps moving (push in, slide, turn). Flying: an eased move to the next. */
function cameraAt(stops: Stop[], t: number, travel: number, push: number) {
  const pos = (s: Stop) => ({ x: s.x, y: s.y, z: s.depth + Math.log(Math.max(0.3, s.size)) * 0.9, ry: s.ry, rz: s.rz });
  const hold = (s: Stop, i: number, dt: number) => {
    const [dx, dy, dz, dr] = s.drift ?? [i % 2 ? -0.03 : 0.03, i % 3 === 1 ? 0.012 : -0.008, push, i % 2 ? 0.35 : -0.35];
    return { dx: dx * dt, dy: dy * dt, dz: dz * dt, dr: dr * dt };
  };
  let i = 0;
  while (i + 1 < stops.length && t >= stops[i + 1]!.at) i++;
  const s = stops[i]!;
  const a = pos(s);
  const next = stops[i + 1];
  const gap = next ? next.at - s.at : Infinity;
  const fly = next ? Math.min(FLY[next.move ?? "slide"] ?? travel, travel * (next.move === "whip" ? 0.5 : 1.15), gap * 0.7) : 0;
  const leave = next ? next.at - fly : Infinity;
  const h = hold(s, i, Math.min(t, leave) - s.at);
  const from = { x: a.x + h.dx, y: a.y + h.dy, z: a.z + h.dz, ry: a.ry, rz: a.rz + h.dr };
  if (!next || t < leave) return { ...from, cur: i, k: 0, move: "hold" };
  const raw = (t - leave) / Math.max(0.01, fly);
  const k = (next.move === "whip" ? whipEase : smooth)(Math.min(1, raw));
  const b = pos(next);
  return { x: from.x + (b.x - from.x) * k, y: from.y + (b.y - from.y) * k, z: from.z + (b.z - from.z) * k, ry: from.ry + (b.ry - from.ry) * k, rz: from.rz + (b.rz - from.rz) * k, cur: k > 0.5 ? i + 1 : i, k, move: next.move ?? "slide" };
}

/** A clip that shows its `trim` moment when the camera arrives; it plays from up to 2.5 s before and holds its first
 *  frame before that, so a panel is never black while the camera approaches it. */
const Clip: React.FC<{ src: string; at: number; trim: number; filter: string; style?: React.CSSProperties }> = ({ src, at, trim, filter, style: extra }) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const lead = Math.min(at, trim, 2.5);
  const from = Math.round((at - lead) * fps), start = Math.round((trim - lead) * fps);
  const style: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter, ...extra };
  return f < from ? <Freeze frame={start}><OffthreadVideo src={staticFile(src)} muted style={style} /></Freeze> : (
    <Sequence from={from} layout="none"><OffthreadVideo src={staticFile(src)} muted startFrom={start} style={style} /></Sequence>
  );
};

/** The picture of a panel (no words): its world, stage, picture or clip, graded, optionally double-exposed. */
const Content: React.FC<{ s: Stop; slots: Record<string, string>; extraFilter?: string }> = ({ s, slots, extraFilter = "" }) => {
  const src = s.slot !== undefined ? slots[String(s.slot)] : undefined;
  const blend = s.blendSlot !== undefined ? slots[String(s.blendSlot)] : undefined;
  const isVid = (x?: string) => Boolean(x && /\.(mp4|mov|webm)$/i.test(x));
  const filt = `${LOOK[s.look] ?? LOOK.natural} ${extraFilter}`.trim();
  const pic = (x: string, f: string, trim: number, style?: React.CSSProperties) => isVid(x) ? <Clip src={x} at={s.at} trim={trim} filter={f} style={style} /> : <Img src={staticFile(x)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: f, ...style }} />;
  return (
    <>
      {s.world ? <World world={s.world} slots={slots} /> : s.stage ? <KitStage /> : null}
      {src && !s.world ? pic(src, filt, s.trim ?? 0) : null}
      {s.look === "duotone" ? <AbsoluteFill style={{ background: PALETTE.primary, mixBlendMode: "color", opacity: 0.75 }} /> : null}
      {s.look === "duotone" ? <AbsoluteFill style={{ background: PALETTE.accent, mixBlendMode: "soft-light", opacity: 0.35 }} /> : null}
      {blend ? <AbsoluteFill style={{ mixBlendMode: "screen", opacity: 0.6 }}>{pic(blend, "grayscale(0.3) contrast(1.2) brightness(0.9)", s.blendTrim ?? 0)}</AbsoluteFill> : null}
    </>
  );
};

const Panel: React.FC<{ s: Stop; slots: Record<string, string> }> = ({ s, slots }) => {
  const { width, height } = useVideoConfig();
  const pad = s.frame === "print" ? width * 0.014 : 0;
  const dof = Math.round((s.dof ?? 0) * width * 0.008);
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: s.frame === "print" ? "#f3f1ec" : "#000", padding: pad, boxShadow: s.frame !== "none" ? "0 40px 90px rgba(0,0,0,0.75)" : "0 30px 80px rgba(0,0,0,0.6)", border: s.frame === "edge" ? `${Math.round(width * 0.004)}px solid rgba(255,255,255,0.85)` : undefined, boxSizing: "border-box" }}>
      <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
        <Content s={s} slots={slots} extraFilter={dof ? `blur(${dof}px)` : ""} />
      </div>
      {/* the panel's own words (behind any cut-out in front of the panel) */}
      <div style={{ position: "absolute", left: 0, top: 0, width, height }}>
        {s.elements.map((el, i) => <Element key={i} el={el} i={i} slots={slots} drift={0} />)}
      </div>
    </div>
  );
};

export const JourneyScene: React.FC<{ journey: JourneySpec; slots: Record<string, string> }> = ({ journey, slots }) => {
  const f = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const t = f / fps;
  const stops = journey.stops;
  const cam = cameraAt(stops, t, journey.travel, journey.push);
  const was = cameraAt(stops, Math.max(0, t - 1 / fps), journey.travel, journey.push);
  // the camera blurs with its own speed (frame widths per second); a whip is the strongest
  const speed = Math.hypot(cam.x - was.x, cam.y - was.y, (cam.z - was.z) * 0.6) * fps;
  const blur = Math.min(cam.move === "whip" ? 26 : 12, speed * (cam.move === "whip" ? 9 : 4));
  const P = width * 1.15;
  const near = stops[cam.cur]!;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
      {/* behind everything: the current picture, enlarged, blurred and dimmed (never an empty table between panels) */}
      {journey.ground !== "stage" ? (
        <AbsoluteFill style={{ transform: `scale(1.35) translate(${(cam.x - near.x) * -6}%, ${(cam.y - near.y) * -6}%)`, filter: "blur(38px) brightness(0.45) saturate(1.2)" }}>
          <Content s={near} slots={slots} />
        </AbsoluteFill>
      ) : <KitStage />}
      <AbsoluteFill style={{ perspective: P, perspectiveOrigin: "50% 50%", filter: blur > 0.6 ? `blur(${blur.toFixed(1)}px)` : undefined }}>
        <AbsoluteFill style={{ transformStyle: "preserve-3d", transform: `rotateZ(${-cam.rz}deg) rotateY(${-cam.ry}deg)` }}>
          <AbsoluteFill style={{ transformStyle: "preserve-3d", transform: `translate3d(${-cam.x * width}px, ${-cam.y * height}px, ${cam.z * width}px)` }}>
            {stops.map((s, i) => {
              if (Math.abs(i - cam.cur) > 2) return null;
              // a panel the camera is flying through fades as it nears the lens (a hold's own push-in stays well short of this)
              const ahead = cam.z - (s.depth + Math.log(Math.max(0.3, s.size)) * 0.9);
              const op = ahead <= 0.55 ? 1 : Math.max(0, 1 - (ahead - 0.55) / 0.4);
              if (op <= 0.01) return null;
              return (
                <div key={i} style={{ position: "absolute", left: 0, top: 0, width, height, transformStyle: "preserve-3d", opacity: op, transform: `translate3d(${s.x * width}px, ${s.y * height}px, ${-s.depth * width}px) rotateY(${s.ry}deg) rotateZ(${s.rz}deg)` }}>
                  <Panel s={s} slots={slots} />
                  {s.fore?.length ? (
                    <div style={{ position: "absolute", left: 0, top: 0, width, height, transform: `translateZ(${(s.foreDepth ?? 0.14) * width}px) scale(${1 - (s.foreDepth ?? 0.14) / 1.15})`, transformOrigin: "50% 50%" }}>
                      {s.fore.map((el, j) => <Element key={j} el={el} i={j} slots={slots} drift={0} />)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </AbsoluteFill>
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
