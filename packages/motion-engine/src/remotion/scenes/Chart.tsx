import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, PALETTE } from "../types";
import { AccentLight, LightSweep } from "./Cinema";

export interface ChartProps {
  type?: "bar" | "line";
  title?: string;
  unit?: string;
  labels?: string[];
  values?: number[];
  /** Exact on-screen strings per value (number parity with the narration); falls back to compact formatting. */
  displays?: string[];
  highlight?: number;
  accent: string;
}

export const fmtCompact = (v: number, unit = "") => {
  const a = Math.abs(v);
  const s = a >= 1e12 ? `${+(v / 1e12).toFixed(1)}T` : a >= 1e9 ? `${+(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(v / 1e3)}K` : Number.isInteger(v) ? String(v) : v.toFixed(1);
  return unit === "$" || unit === "€" || unit === "£" ? `${unit}${s}` : unit === "%" ? `${s}%` : `${s}${unit ? ` ${unit}` : ""}`;
};

/** MagnatesMedia title strip: white box, black condensed caps, the key word in crimson, typed on. */
export const TitleStrip: React.FC<{ text: string; delay?: number; size: number }> = ({ text, delay = 0, size }) => {
  const f = useCurrentFrame();
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  // Key word: the longest word (ties → last), shown in crimson.
  const key = words.reduce((k, w, i) => (w.length >= (words[k]?.length ?? 0) ? i : k), 0);
  const total = text.length;
  const shown = Math.floor(interpolate(f - delay, [0, 14], [0, total], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const bar = interpolate(f - delay, [-4, 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  let used = 0;
  return (
    <div style={{ display: "inline-block", background: "#fff", padding: `${size * 0.12}px ${size * 0.35}px`, transform: `scaleX(${bar})`, transformOrigin: "left center", boxShadow: "0 12px 40px rgba(0,0,0,0.55)" }}>
      {words.map((w, i) => {
        const vis = Math.max(0, Math.min(w.length, shown - used));
        used += w.length + 1;
        return (
          <span key={i} style={{ fontFamily: FONT, fontSize: size, color: i === key ? PALETTE.crimson : "#0b0b0b", letterSpacing: 0.5 }}>
            {w.slice(0, vis)}
            <span style={{ opacity: 0 }}>{w.slice(vis)}</span>
            {i < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
};

/**
 * TrajectoryChart: glowing growth/crash chart on a dark perspective grid. Rising segments glow gold; once the
 * series passes its peak and falls, the line turns crimson, the camera jolts and the peak is tagged.
 */
export const AnimatedChart: React.FC<ChartProps> = ({ type = "line", title, unit, labels = [], values = [], displays, highlight, accent: _accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const n = Math.max(1, Math.min(values.length, labels.length || values.length));
  const vals = values.slice(0, n);
  const max = Math.max(...vals.map((v) => Math.abs(v)), 1);
  const peakI = vals.indexOf(Math.max(...vals));
  const crash = n > 2 && peakI < n - 1 && vals[n - 1]! < vals[peakI]! * 0.75;
  const W = width * (portrait ? 0.86 : 0.74);
  const H = height * (portrait ? 0.4 : 0.5);
  const hi = highlight ?? (crash ? n - 1 : peakI);
  const label = (i: number) => displays?.[i] ?? fmtCompact(vals[i]!, unit);
  const prog = interpolate(f, [3, 3 + Math.max(6, Math.min(fps * 1.6, durationInFrames * 0.45))], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const tilt = spring({ frame: f, fps, config: { damping: 30, stiffness: 60 } });
  // Crash jolt when the draw passes the peak.
  const peakAt = n > 1 ? peakI / (n - 1) : 1;
  const joltT = crash ? (prog - peakAt) * 40 : -1;
  const jolt = joltT > 0 && joltT < 1 ? Math.sin(joltT * Math.PI * 6) * (1 - joltT) * 10 : 0;
  const base = H - 70;
  const x = (i: number) => (n === 1 ? W / 2 : 60 + (i / (n - 1)) * (W - 120));
  const y = (v: number) => base - (v / max) * (H - 170);
  const pts = vals.map((v, i) => [x(i), y(v)] as const);
  const seg = (a: number, b: number) => pts.slice(a, b + 1).map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const lenOf = (a: number, b: number) => pts.slice(a, b + 1).reduce((s, p, i, arr) => (i ? s + Math.hypot(p[0] - arr[i - 1]![0], p[1] - arr[i - 1]![1]) : 0), 0);
  const riseEnd = crash ? peakI : n - 1;
  const riseLen = lenOf(0, riseEnd);
  const fallLen = crash ? lenOf(peakI, n - 1) : 0;
  const drawn = prog * (riseLen + fallLen);
  const riseShown = Math.min(riseLen, drawn);
  const fallShown = Math.max(0, drawn - riseLen);
  const headI = Math.min(n - 1, Math.floor(prog * (n - 1) + 1e-6));
  const area = `${seg(0, n - 1)} L${x(n - 1)},${base} L${x(0)},${base} Z`;
  const gold = PALETTE.gold;
  const red = PALETTE.crimson;
  const fs = portrait ? 40 : 32;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at 50% 60%, rgba(8,10,16,0.55), rgba(0,0,0,0.88))" }}>
      {/* Perspective floor grid */}
      <AbsoluteFill style={{ perspective: 900, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: "-50%", right: "-50%", top: "52%", height: "110%", transform: `rotateX(62deg) translateY(${(f * 1.2) % 90}px)`, transformOrigin: "50% 0%", backgroundImage: `linear-gradient(${crash && prog > peakAt ? "rgba(220,38,38,0.35)" : "rgba(245,158,11,0.28)"} 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px)`, backgroundSize: "90px 90px", maskImage: "linear-gradient(to bottom, black, transparent 75%)" }} />
      </AbsoluteFill>
      <AccentLight color={crash && prog > peakAt ? red : gold} at={[0.75, 0.3]} intensity={0.3} />
      <div style={{ position: "relative", width: W, transform: `translateX(${jolt}px) translateY(${jolt * 0.4}px)` }}>
        {title ? (
          <div style={{ marginBottom: portrait ? 36 : 28 }}>
            <TitleStrip text={title} delay={2} size={portrait ? 50 : 42} />
          </div>
        ) : null}
        <div style={{ perspective: 1400 }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible", transform: `rotateX(${10 - 6 * tilt}deg) rotateY(${-8 + 5 * tilt}deg)` }}>
            <defs>
              <linearGradient id="areaG" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={crash ? red : gold} stopOpacity={0.45} />
                <stop offset="100%" stopColor={crash ? red : gold} stopOpacity={0} />
              </linearGradient>
              <clipPath id="reveal">
                <rect x={0} y={-200} width={x(0) + prog * (x(n - 1) - x(0)) + 2} height={H + 400} />
              </clipPath>
            </defs>
            {[0.25, 0.5, 0.75, 1].map((g) => (
              <line key={g} x1={0} x2={W} y1={base - g * (H - 170)} y2={base - g * (H - 170)} stroke="rgba(255,255,255,0.1)" strokeDasharray="6 10" />
            ))}
            <line x1={0} y1={base} x2={W} y2={base} stroke="rgba(255,255,255,0.45)" strokeWidth={3} />
            {type === "line" ? (
              <g>
                <path d={area} fill="url(#areaG)" clipPath="url(#reveal)" />
                <path d={seg(0, riseEnd)} fill="none" stroke={gold} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={riseLen} strokeDashoffset={riseLen - riseShown} style={{ filter: `drop-shadow(0 0 14px ${gold})` }} />
                {crash ? <path d={seg(peakI, n - 1)} fill="none" stroke={red} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={fallLen} strokeDashoffset={fallLen - fallShown} style={{ filter: `drop-shadow(0 0 18px ${red})` }} /> : null}
                {pts.map((p, i) => {
                  const on = i <= headI && prog > 0;
                  const isHi = i === hi;
                  const c = crash && i > peakI ? red : gold;
                  return (
                    <g key={i} opacity={on ? 1 : 0}>
                      <circle cx={p[0]} cy={p[1]} r={isHi ? 16 : 9} fill={isHi ? c : "#fff"} style={isHi ? { filter: `drop-shadow(0 0 16px ${c})` } : undefined} />
                      {isHi || i === 0 || (crash && i === peakI) ? (
                        <g>
                          <rect x={p[0] - (label(i).length * fs * 0.33 + 16)} y={p[1] - fs * 2.1} width={label(i).length * fs * 0.66 + 32} height={fs * 1.35} rx={6} fill={isHi ? c : "rgba(0,0,0,0.75)"} />
                          <text x={p[0]} y={p[1] - fs * 1.08} fill={isHi && c === gold ? "#111" : "#fff"} fontFamily={FONT} fontSize={fs} textAnchor="middle">{label(i)}</text>
                        </g>
                      ) : null}
                      {crash && i === peakI ? <text x={p[0]} y={p[1] - fs * 2.5} fill={gold} fontFamily={FONT_BODY} fontWeight={900} fontSize={fs * 0.6} textAnchor="middle" letterSpacing={3}>PEAK</text> : null}
                      <text x={p[0]} y={H - 22} fill="rgba(255,255,255,0.85)" fontFamily={FONT_BODY} fontWeight={700} fontSize={portrait ? 32 : 26} textAnchor="middle">{labels[i]}</text>
                    </g>
                  );
                })}
              </g>
            ) : (
              vals.map((v, i) => {
                const bw = ((W - 80) / n) * 0.58;
                const cx = n === 1 ? W / 2 : 40 + ((W - 80) / n) * (i + 0.5);
                // Every bar lands by 45 % of the shot (≤ 1.2 s), however short the shot is.
                const span = Math.max(6, Math.min(fps * 1.2, durationInFrames * 0.45));
                const g = interpolate(f, [2 + (i / n) * span * 0.5, 2 + (i / n) * span * 0.5 + span * 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.4)) });
                const h = (Math.abs(v) / max) * (H - 170) * g;
                const c = crash && i > peakI ? red : i === hi ? gold : "rgba(255,255,255,0.85)";
                return (
                  <g key={i}>
                    <rect x={cx - bw / 2} y={base - h} width={bw} height={h} rx={6} fill={c} style={c !== "rgba(255,255,255,0.85)" ? { filter: `drop-shadow(0 0 18px ${c})` } : undefined} />
                    <text x={cx} y={base - h - 16} fill="#fff" fontFamily={FONT} fontSize={fs} textAnchor="middle" opacity={Math.min(1, g * 1.2)}>{label(i)}</text>
                    <text x={cx} y={H - 22} fill="rgba(255,255,255,0.85)" fontFamily={FONT_BODY} fontWeight={700} fontSize={portrait ? 32 : 26} textAnchor="middle">{labels[i]}</text>
                  </g>
                );
              })
            )}
          </svg>
        </div>
      </div>
      <LightSweep delay={6} periodFrames={45} opacity={0.1} />
    </AbsoluteFill>
  );
};
