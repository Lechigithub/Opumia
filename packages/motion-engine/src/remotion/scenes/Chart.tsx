import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY } from "../types";

export interface ChartProps {
  type?: "bar" | "line";
  title?: string;
  unit?: string;
  labels?: string[];
  values?: number[];
  highlight?: number;
  accent: string;
}

const fmt = (v: number, unit = "") => {
  const a = Math.abs(v);
  const s = a >= 1e12 ? `${(v / 1e12).toFixed(1)}T` : a >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(v / 1e3)}K` : Number.isInteger(v) ? String(v) : v.toFixed(1);
  return unit === "$" ? `$${s}` : `${s}${unit && unit !== "$" ? ` ${unit}` : ""}`;
};

/** Animated bar or line chart; bars grow with springs, values count up, the highlighted item glows. */
export const AnimatedChart: React.FC<ChartProps> = ({ type = "bar", title, unit, labels = [], values = [], highlight, accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const n = Math.max(1, Math.min(values.length, labels.length || values.length));
  const max = Math.max(...values.slice(0, n).map((v) => Math.abs(v)), 1);
  const portrait = height > width;
  const W = width * (portrait ? 0.86 : 0.78);
  const H = height * (portrait ? 0.38 : 0.56);
  const hi = highlight ?? n - 1;
  const titleIn = spring({ frame: f, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at center, rgba(15,15,20,0.78), rgba(0,0,0,0.92))" }}>
      <div style={{ width: W, fontFamily: FONT, color: "#fff", fontSize: portrait ? 58 : 54, textTransform: "uppercase", letterSpacing: 1, marginBottom: 40, opacity: titleIn, transform: `translateY(${(1 - titleIn) * 30}px)` }}>{title}</div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <line x1={0} y1={H - 60} x2={W} y2={H - 60} stroke="rgba(255,255,255,0.35)" strokeWidth={3} />
        {type === "line" ? (
          (() => {
            const pts = values.slice(0, n).map((v, i) => [n === 1 ? W / 2 : (i / (n - 1)) * (W - 80) + 40, H - 60 - (v / max) * (H - 140)] as const);
            const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
            const len = pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]) : 0), 0);
            const prog = interpolate(f, [6, 6 + fps * 1.4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <g>
                <path d={d} fill="none" stroke={accent} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - prog)} />
                {pts.map((p, i) => {
                  const on = prog >= (n === 1 ? 0 : i / (n - 1)) - 0.001;
                  return (
                    <g key={i} opacity={on ? 1 : 0}>
                      <circle cx={p[0]} cy={p[1]} r={i === hi ? 18 : 11} fill={i === hi ? accent : "#fff"} />
                      <text x={p[0]} y={p[1] - 32} fill="#fff" fontFamily={FONT} fontSize={portrait ? 40 : 34} textAnchor="middle">{fmt(values[i]!, unit)}</text>
                      <text x={p[0]} y={H - 14} fill="rgba(255,255,255,0.8)" fontFamily={FONT_BODY} fontSize={portrait ? 34 : 30} textAnchor="middle">{labels[i]}</text>
                    </g>
                  );
                })}
              </g>
            );
          })()
        ) : (
          values.slice(0, n).map((v, i) => {
            const bw = (W / n) * 0.62;
            const x = (W / n) * i + (W / n - bw) / 2;
            const g = spring({ frame: f - 6 - i * 4, fps, config: { damping: 18, stiffness: 90 } });
            const h = (Math.abs(v) / max) * (H - 150) * g;
            const isHi = i === hi;
            return (
              <g key={i}>
                <rect x={x} y={H - 60 - h} width={bw} height={h} rx={8} fill={isHi ? accent : "rgba(255,255,255,0.82)"} style={isHi ? { filter: `drop-shadow(0 0 22px ${accent})` } : undefined} />
                <text x={x + bw / 2} y={H - 74 - h} fill="#fff" fontFamily={FONT} fontSize={portrait ? 42 : 36} textAnchor="middle" opacity={g}>{fmt(v * g, unit)}</text>
                <text x={x + bw / 2} y={H - 14} fill="rgba(255,255,255,0.85)" fontFamily={FONT_BODY} fontSize={portrait ? 34 : 30} textAnchor="middle">{labels[i]}</text>
              </g>
            );
          })
        )}
      </svg>
    </AbsoluteFill>
  );
};
