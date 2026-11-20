import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, PALETTE } from "../types";

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

/** Arc between two points: quadratic curve bowed perpendicular to the chord (flight-path look). */
const arc = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const bow = Math.min(0.35 * d, 400);
  const cx = mx - (dy / (d || 1)) * bow;
  const cy = my + (dx / (d || 1)) * bow * (dx >= 0 ? -1 : 1);
  const len = (() => {
    let s = 0;
    let px = a.x;
    let py = a.y;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const x = (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t * t * b.x;
      const y = (1 - t) ** 2 * a.y + 2 * (1 - t) * t * cy + t * t * b.y;
      s += Math.hypot(x - px, y - py);
      px = x;
      py = y;
    }
    return s;
  })();
  const at = (t: number) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * cy + t * t * b.y });
  return { d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`, len, at };
};

/**
 * MapFlyover (tactical): near-black sea with a coordinate grid, dark slate land, focus countries lit crimson,
 * the camera flies from the world onto the region, glowing route arcs draw point to point with a travelling
 * spark, pins pulse with expanding rings, and labels sit in MagnatesMedia white tags.
 */
export const MapRoute: React.FC<MapProps> = ({ title, paths, points, route = true, from, to }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const fly = interpolate(f, [0, Math.min(durationInFrames * 0.5, fps * 1.6)], [0, 1], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const drift = interpolate(f, [0, durationInFrames], [0, 1]);
  const vb = from.map((v, i) => v + (to[i]! - v) * fly);
  const ar = width / height;
  let [x, y, w, h] = vb as [number, number, number, number];
  // Continuous slow push after the flyover lands.
  const push = 1 - 0.06 * drift;
  x += (w * (1 - push)) / 2;
  y += (h * (1 - push)) / 2;
  w *= push;
  h *= push;
  if (w / h > ar) {
    const nh = w / ar;
    y -= (nh - h) / 2;
    h = nh;
  } else {
    const nw = h * ar;
    x -= (nw - w) / 2;
    w = nw;
  }
  const unit = w / width;
  const legs = route && points.length > 1 ? points.slice(1).map((p, i) => arc(points[i]!, p)) : [];
  const total = legs.reduce((s, l) => s + l.len, 0);
  const routeProg = interpolate(f, [fps * 1.0, fps * 1.0 + Math.max(fps, (durationInFrames - fps) * 0.6)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  let remaining = routeProg * total;
  const grid = Math.max(20, Math.round(w / 12 / 10) * 10);
  return (
    <AbsoluteFill style={{ backgroundColor: "#04060a" }}>
      <svg width={width} height={height} viewBox={`${x} ${y} ${w} ${h}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="sea2" cx="50%" cy="45%" r="80%">
            <stop offset="0%" stopColor="#0d1622" />
            <stop offset="100%" stopColor="#020305" />
          </radialGradient>
          <pattern id="grid2" width={grid} height={grid} patternUnits="userSpaceOnUse">
            <path d={`M ${grid} 0 L 0 0 0 ${grid}`} fill="none" stroke="rgba(120,160,200,0.10)" strokeWidth={unit * 1.2} />
          </pattern>
        </defs>
        <rect x={x - w} y={y - h} width={w * 3} height={h * 3} fill="url(#sea2)" />
        <rect x={x - w} y={y - h} width={w * 3} height={h * 3} fill="url(#grid2)" />
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill={p.focus ? PALETTE.crimson : "#151b24"} fillOpacity={p.focus ? 0.55 + 0.25 * fly : 1} stroke={p.focus ? "#ff6b6b" : "rgba(130,150,175,0.35)"} strokeWidth={unit * (p.focus ? 2.2 : 1)} style={p.focus ? { filter: `drop-shadow(0 0 ${unit * 10}px ${PALETTE.crimson})` } : undefined} />
        ))}
        {legs.map((l, i) => {
          const shown = Math.max(0, Math.min(l.len, remaining));
          remaining -= l.len;
          const head = l.at(shown / (l.len || 1));
          return (
            <g key={i}>
              <path d={l.d} fill="none" stroke={PALETTE.gold} strokeOpacity={0.25} strokeWidth={unit * 10} strokeDasharray={`${l.len}`} strokeDashoffset={l.len - shown} />
              <path d={l.d} fill="none" stroke={PALETTE.goldSoft} strokeWidth={unit * 4.5} strokeLinecap="round" strokeDasharray={`${l.len}`} strokeDashoffset={l.len - shown} style={{ filter: `drop-shadow(0 0 ${unit * 8}px ${PALETTE.gold})` }} />
              {shown > 0 && shown < l.len ? <circle cx={head.x} cy={head.y} r={unit * 9} fill="#fff" style={{ filter: `drop-shadow(0 0 ${unit * 14}px ${PALETTE.goldSoft})` }} /> : null}
            </g>
          );
        })}
        {points.map((p, i) => {
          const appear = legs.length ? interpolate(routeProg, [i / Math.max(1, points.length - 1) - 0.06, i / Math.max(1, points.length - 1)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : fly;
          const pulse = ((f + i * 9) % 36) / 36;
          const fs = unit * (height > width ? 40 : 30);
          const label = p.name.toUpperCase();
          const tw = label.length * fs * 0.68 + fs;
          return (
            <g key={i} opacity={appear}>
              <circle cx={p.x} cy={p.y} r={unit * (14 + 46 * pulse)} fill="none" stroke={PALETTE.crimson} strokeWidth={unit * 3} opacity={1 - pulse} />
              <circle cx={p.x} cy={p.y} r={unit * 11} fill={PALETTE.crimson} stroke="#fff" strokeWidth={unit * 3.5} style={{ filter: `drop-shadow(0 0 ${unit * 10}px ${PALETTE.crimson})` }} />
              <rect x={p.x - tw / 2} y={p.y - unit * 30 - fs * 1.25} width={tw} height={fs * 1.3} fill="#fff" />
              <text x={p.x} y={p.y - unit * 30 - fs * 0.27} fill="#0b0b0b" fontFamily={FONT} fontSize={fs} textAnchor="middle">{label}</text>
            </g>
          );
        })}
      </svg>
      {/* Radar sweep line */}
      <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.14, background: `linear-gradient(90deg, transparent ${((f * 1.5) % 140) - 20}%, rgba(255,255,255,0.7) ${((f * 1.5) % 140) - 18}%, transparent ${((f * 1.5) % 140) - 16}%)` }} />
      {title ? (
        <div style={{ position: "absolute", top: height * 0.09, width: "100%", display: "flex", justifyContent: "center" }}>
          <div style={{ background: "rgba(0,0,0,0.6)", borderLeft: `8px solid ${PALETTE.crimson}`, padding: "10px 26px", fontFamily: FONT_BODY, fontWeight: 900, color: "#fff", fontSize: height > width ? 50 : 42, letterSpacing: 3, textTransform: "uppercase" }}>{title}</div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
