import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY } from "../types";

export interface MapProps {
  title?: string;
  /** Country outlines pre-projected (in Node) into a fixed world canvas. */
  paths: Array<{ d: string; focus: boolean }>;
  /** Projected points in the same canvas. */
  points: Array<{ name: string; x: number; y: number }>;
  route?: boolean;
  canvas: { w: number; h: number };
  /** viewBox to fly from (wide) and to (tight around the points). */
  from: [number, number, number, number];
  to: [number, number, number, number];
  accent: string;
}

/** Map flyover: camera eases from a wide view onto the region, then the route draws point to point. */
export const MapRoute: React.FC<MapProps> = ({ title, paths, points, route = true, from, to, accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const fly = interpolate(f, [0, Math.min(durationInFrames * 0.45, fps * 1.4)], [0, 1], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const vb = from.map((v, i) => v + (to[i]! - v) * fly);
  // Keep the output aspect: expand the viewBox to the frame ratio.
  const ar = width / height;
  let [x, y, w, h] = vb as [number, number, number, number];
  if (w / h > ar) {
    const nh = w / ar;
    y -= (nh - h) / 2;
    h = nh;
  } else {
    const nw = h * ar;
    x -= (nw - w) / 2;
    w = nw;
  }
  const routeProg = interpolate(f, [fps * 0.9, fps * 0.9 + Math.max(fps, (durationInFrames - fps) * 0.6)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const d = points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const len = points.reduce((s, p, i) => (i ? s + Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) : 0), 0);
  const unit = w / width; // canvas units per output pixel
  return (
    <AbsoluteFill style={{ backgroundColor: "#0d1b26" }}>
      <svg width={width} height={height} viewBox={`${x} ${y} ${w} ${h}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="sea" cx="50%" cy="45%" r="75%">
            <stop offset="0%" stopColor="#1d3a4f" />
            <stop offset="100%" stopColor="#08131b" />
          </radialGradient>
        </defs>
        <rect x={x} y={y} width={w} height={h} fill="url(#sea)" />
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill={p.focus ? "#d9c9a3" : "#3d4f5a"} stroke="#0d1b26" strokeWidth={unit * 1.6} />
        ))}
        {route && points.length > 1 ? <path d={d} fill="none" stroke={accent} strokeWidth={unit * 7} strokeLinecap="round" strokeDasharray={`${len}`} strokeDashoffset={len * (1 - routeProg)} style={{ filter: `drop-shadow(0 0 ${unit * 6}px ${accent})` }} /> : null}
        {points.map((p, i) => {
          const appear = route && points.length > 1 ? interpolate(routeProg, [i / Math.max(1, points.length - 1) - 0.05, i / Math.max(1, points.length - 1)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : fly;
          return (
            <g key={i} opacity={appear}>
              <circle cx={p.x} cy={p.y} r={unit * 14} fill={accent} stroke="#fff" strokeWidth={unit * 4} />
              <text x={p.x} y={p.y - unit * 28} fill="#fff" fontFamily={FONT} fontSize={unit * (height > width ? 46 : 38)} textAnchor="middle" style={{ paintOrder: "stroke", stroke: "#000", strokeWidth: unit * 8 }}>
                {p.name.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
      {title ? <div style={{ position: "absolute", top: height * 0.12, width: "100%", textAlign: "center", fontFamily: FONT_BODY, fontWeight: 800, color: "#fff", fontSize: height > width ? 56 : 46, letterSpacing: 2, textTransform: "uppercase", textShadow: "0 4px 18px #000" }}>{title}</div> : null}
    </AbsoluteFill>
  );
};
