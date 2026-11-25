import React from "react";
import { AbsoluteFill, Easing, Freeze, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Element, KitStage } from "./Composed";
import { World, type WorldSpec } from "./Worlds";

/**
 * A continuous camera journey (owner, 2026-11-24): "the reference holds and moves continuously from scene to scene with
 * no cut … words also transition into scenes smoothly and never feel rushed". Real pictures and clips are panels in a
 * 3D space; the camera flies from one to the next with real perspective (panels at other depths pass at other speeds),
 * turns with turned panels (an arc), and keeps drifting while it holds, so the picture never stops moving and never
 * cuts. Each panel carries its own words, which arrive with it and leave with it.
 */
type El = Parameters<typeof Element>[0]["el"];
export interface Stop {
  at: number; x: number; y: number; depth: number; ry: number; rz: number; size: number;
  slot?: number; trim?: number; look: string; world?: WorldSpec; stage?: boolean; frame: string; elements: El[];
}
export interface JourneySpec { stops: Stop[]; travel: number; push: number; ground: string }

const LOOK: Record<string, string> = {
  natural: "contrast(1.06) saturate(1.08)",
  mono: "grayscale(1) contrast(1.25) brightness(0.9)",
  contrast: "contrast(1.3) saturate(1.15)",
  cool: "contrast(1.1) saturate(0.85) hue-rotate(-8deg) brightness(0.95)",
  warm: "contrast(1.08) saturate(1.2) sepia(0.2)",
  faded: "contrast(0.92) saturate(0.7) brightness(1.05)",
  bright: "brightness(1.45) contrast(1.05) saturate(1.1)",
};
const smooth = Easing.bezier(0.45, 0, 0.2, 1);

/** Where the camera is at time t (s): at stop i once it has arrived, flying between arrivals; drifting in while it holds. */
function cameraAt(stops: Stop[], t: number, travel: number, push: number) {
  const pos = (s: Stop) => ({ x: s.x, y: s.y, z: s.depth + Math.log(Math.max(0.3, s.size)) * 0.9, ry: s.ry, rz: s.rz });
  let i = 0;
  while (i + 1 < stops.length && t >= stops[i + 1]!.at) i++;
  const a = pos(stops[i]!);
  const next = stops[i + 1];
  if (!next) return { ...a, z: a.z + push * (t - stops[i]!.at), cur: i };
  const gap = next.at - stops[i]!.at;
  const fly = Math.min(travel, gap * 0.7);
  const leave = next.at - fly;
  // hold: drift into the panel; flight: an eased move to the next (the drift is carried into the flight, never a stop)
  const held = Math.min(t, leave) - stops[i]!.at;
  const from = { ...a, z: a.z + push * held };
  if (t < leave) return { ...from, cur: i };
  const k = smooth((t - leave) / Math.max(0.01, fly));
  const b = pos(next);
  return { x: from.x + (b.x - from.x) * k, y: from.y + (b.y - from.y) * k, z: from.z + (b.z - from.z) * k, ry: from.ry + (b.ry - from.ry) * k, rz: from.rz + (b.rz - from.rz) * k, cur: k > 0.5 ? i + 1 : i };
}

/** A clip that shows its `trim` moment when the camera arrives; it plays from up to 2.5 s before (during the flight)
 *  and holds its first frame before that, so a panel is never black while the camera approaches it. */
const Clip: React.FC<{ src: string; at: number; trim: number; filter: string }> = ({ src, at, trim, filter }) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const lead = Math.min(at, trim, 2.5);
  const from = Math.round((at - lead) * fps), start = Math.round((trim - lead) * fps);
  const style: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter };
  return f < from ? <Freeze frame={start}><OffthreadVideo src={staticFile(src)} muted style={style} /></Freeze> : (
    <Sequence from={from} layout="none"><OffthreadVideo src={staticFile(src)} muted startFrom={start} style={style} /></Sequence>
  );
};

const Panel: React.FC<{ s: Stop; slots: Record<string, string> }> = ({ s, slots }) => {
  const { width, height, fps } = useVideoConfig();
  const src = s.slot !== undefined ? slots[String(s.slot)] : undefined;
  const isVideo = Boolean(src && /\.(mp4|mov|webm)$/i.test(src));
  const pad = s.frame === "print" ? width * 0.014 : 0;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: s.frame === "print" ? "#f3f1ec" : "#000", padding: pad, boxShadow: s.frame !== "none" ? "0 40px 90px rgba(0,0,0,0.75)" : "0 30px 80px rgba(0,0,0,0.6)", border: s.frame === "edge" ? `${Math.round(width * 0.004)}px solid rgba(255,255,255,0.85)` : undefined, boxSizing: "border-box" }}>
      <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
        {s.world ? <World world={s.world} slots={slots} /> : s.stage ? <KitStage /> : null}
        {src && !s.world ? (
          isVideo ? (
            <Clip src={src} at={s.at} trim={s.trim ?? 0} filter={LOOK[s.look] ?? LOOK.natural!} />
          ) : (
            <Img src={staticFile(src)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: LOOK[s.look] ?? LOOK.natural }} />
          )
        ) : null}
      </div>
      {/* the panel's words: laid out on the frame-sized panel, timed from the scene's start */}
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
  const P = width * 1.15;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: journey.ground === "black" ? "#000" : undefined }}>
      {journey.ground === "stage" ? <KitStage /> : null}
      <AbsoluteFill style={{ perspective: P, perspectiveOrigin: "50% 50%" }}>
        {/* the camera: turned about itself, then everything moved so the camera's point sits at the screen centre */}
        <AbsoluteFill style={{ transformStyle: "preserve-3d", transform: `rotateZ(${-cam.rz}deg) rotateY(${-cam.ry}deg)` }}>
          <AbsoluteFill style={{ transformStyle: "preserve-3d", transform: `translate3d(${-cam.x * width}px, ${-cam.y * height}px, ${cam.z * width}px)` }}>
            {stops.map((s, i) =>
              Math.abs(i - cam.cur) > 2 ? null : (
                <div key={i} style={{ position: "absolute", left: 0, top: 0, width, height, transformStyle: "preserve-3d", transform: `translate3d(${s.x * width}px, ${s.y * height}px, ${-s.depth * width}px) rotateY(${s.ry}deg) rotateZ(${s.rz}deg)` }}>
                  <Panel s={s} slots={slots} />
                </div>
              ),
            )}
          </AbsoluteFill>
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
