import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, FONT_SERIF } from "../types";

const useIn = (delay = 0, damping = 14) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping, stiffness: 140, mass: 0.7 } });
};

/** big_word: kinetic typography — letters punch in, slight overshoot, slow push. */
export const BigWord: React.FC<{ text?: string; sub?: string; accent: string }> = ({ text = "", sub, accent }) => {
  const f = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const size = Math.min(portrait ? 190 : 210, (width * (portrait ? 0.88 : 0.8)) / (Math.max(4, ...words.map((w) => w.length)) * 0.8));
  const push = interpolate(f, [0, durationInFrames], [1, 1.08]);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at center, rgba(0,0,0,0.35), rgba(0,0,0,0.85))" }}>
      <div style={{ transform: `scale(${push})`, textAlign: "center" }}>
        {words.map((w, i) => {
          const s = useIn(i * 4);
          return (
            <div key={i} style={{ fontFamily: FONT, fontSize: size, lineHeight: 0.95, color: i === words.length - 1 ? accent : "#fff", transform: `translateY(${(1 - s) * 80}px) scale(${0.7 + 0.3 * s})`, opacity: Math.min(1, s * 1.4), textShadow: "0 10px 40px rgba(0,0,0,0.8)", letterSpacing: -2 }}>
              {w}
            </div>
          );
        })}
        {sub ? <div style={{ fontFamily: FONT_BODY, fontWeight: 700, color: "rgba(255,255,255,0.9)", fontSize: portrait ? 48 : 40, marginTop: 28, opacity: useIn(10, 200), textTransform: "uppercase", letterSpacing: 3 }}>{sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

/** money_figure: number counts up with a ticking feel. */
export const MoneyFigure: React.FC<{ value?: number; prefix?: string; suffix?: string; label?: string; accent: string }> = ({ value = 0, prefix = "", suffix = "", label, accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  const p = interpolate(f, [4, 4 + fps * 1.1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - Math.pow(1 - t, 3) });
  const v = value * p;
  // Compact units so large figures never overflow (19,000,000,000 → 19.0B).
  const [div, unit] = Math.abs(value) >= 1e12 ? [1e12, "T"] : Math.abs(value) >= 1e9 ? [1e9, "B"] : Math.abs(value) >= 1e6 ? [1e6, "M"] : [1, ""];
  const scaled = v / div;
  // Keep the figure's own precision (90.75 stays 90.75), max 2 decimals.
  const decimals = (x: number) => Math.min(2, (String(x).split(".")[1] ?? "").length);
  const shown = unit
    ? `${scaled.toFixed(Math.min(2, Math.max(Math.abs(value / div) >= 100 ? 0 : 1, decimals(value / div))))}${unit}`
    : Number.isInteger(value)
      ? Math.round(v).toLocaleString("en-US")
      : v.toLocaleString("en-US", { minimumFractionDigits: decimals(value), maximumFractionDigits: decimals(value) });
  const chars = `${prefix}${shown}${suffix}`.length;
  const fs = Math.min(portrait ? 170 : 190, (width * 0.88) / Math.max(1, chars * 0.62));
  const s = useIn(0);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at center, rgba(0,0,0,0.45), rgba(0,0,0,0.9))" }}>
      <div style={{ fontFamily: FONT, color: accent, fontSize: fs, transform: `scale(${0.8 + 0.2 * s})`, textShadow: `0 0 40px ${accent}66, 0 12px 40px #000`, fontVariantNumeric: "tabular-nums" }}>
        {prefix}
        {shown}
        {suffix}
      </div>
      {label ? <div style={{ fontFamily: FONT_BODY, fontWeight: 800, color: "#fff", fontSize: portrait ? 50 : 44, textTransform: "uppercase", letterSpacing: 3, marginTop: 10, opacity: useIn(8, 200), maxWidth: width * 0.85, textAlign: "center" }}>{label}</div> : null}
    </AbsoluteFill>
  );
};

export const Versus: React.FC<{ title?: string; left?: { label: string; value: string }; right?: { label: string; value: string }; accent: string }> = ({ title, left, right, accent }) => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const l = useIn(0);
  const r = useIn(6);
  const box = (side: { label: string; value: string } | undefined, s: number, hi: boolean, dir: number) => (
    <div style={{ flex: 1, padding: 40, background: hi ? accent : "rgba(255,255,255,0.1)", color: hi ? "#111" : "#fff", transform: `translate${portrait ? "Y" : "X"}(${(1 - s) * 400 * dir}px)`, textAlign: "center", borderRadius: 18 }}>
      <div style={{ fontFamily: FONT, fontSize: portrait ? 96 : 110 }}>{side?.value}</div>
      <div style={{ fontFamily: FONT_BODY, fontWeight: 800, fontSize: portrait ? 42 : 38, textTransform: "uppercase", letterSpacing: 2 }}>{side?.label}</div>
    </div>
  );
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.82)", padding: 60 }}>
      {title ? <div style={{ fontFamily: FONT_BODY, fontWeight: 900, color: "#fff", fontSize: portrait ? 54 : 48, textTransform: "uppercase", marginBottom: 40, letterSpacing: 2 }}>{title}</div> : null}
      <div style={{ display: "flex", flexDirection: portrait ? "column" : "row", gap: 36, width: "100%", alignItems: "stretch" }}>
        {box(left, l, false, -1)}
        <div style={{ alignSelf: "center", fontFamily: FONT, color: "#fff", fontSize: 72 }}>VS</div>
        {box(right, r, true, 1)}
      </div>
    </AbsoluteFill>
  );
};

export const Timeline: React.FC<{ items?: Array<{ year: string; label: string }>; accent: string }> = ({ items = [], accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  const n = Math.max(1, items.length);
  const step = Math.max(6, Math.floor((fps * 1.6) / n));
  return (
    <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", padding: portrait ? "0 70px" : "0 120px" }}>
      <div style={{ display: "flex", flexDirection: portrait ? "column" : "row", gap: portrait ? 44 : 30, position: "relative" }}>
        {items.map((it, i) => {
          const s = spring({ frame: f - i * step, fps, config: { damping: 16 } });
          const active = f >= i * step;
          return (
            <div key={i} style={{ flex: 1, opacity: s, transform: `translateY(${(1 - s) * 40}px)`, borderLeft: portrait ? `8px solid ${active ? accent : "#555"}` : undefined, borderTop: portrait ? undefined : `8px solid ${active ? accent : "#555"}`, padding: portrait ? "4px 0 4px 30px" : "24px 8px 0" }}>
              <div style={{ fontFamily: FONT, color: accent, fontSize: portrait ? 76 : 64 }}>{it.year}</div>
              <div style={{ fontFamily: FONT_BODY, fontWeight: 700, color: "#fff", fontSize: portrait ? 40 : 32, lineHeight: 1.2 }}>{it.label}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "none" }}>{width}</div>
    </AbsoluteFill>
  );
};

export const QuoteCard: React.FC<{ quote?: string; by?: string; accent: string }> = ({ quote = "", by, accent }) => {
  const f = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const words = quote.split(/\s+/);
  const shown = Math.ceil(interpolate(f, [4, Math.max(5, durationInFrames * 0.6)], [0, words.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", padding: portrait ? "0 80px" : "0 200px" }}>
      <div style={{ fontFamily: FONT_SERIF, fontSize: portrait ? 160 : 180, color: accent, lineHeight: 0.6 }}>“</div>
      <div style={{ fontFamily: FONT_SERIF, fontStyle: "italic", color: "#fff", fontSize: portrait ? 66 : 60, lineHeight: 1.25 }}>
        {words.map((w, i) => (
          <span key={i} style={{ opacity: i < shown ? 1 : 0.12 }}>{w} </span>
        ))}
      </div>
      {by ? <div style={{ fontFamily: FONT_BODY, fontWeight: 800, color: accent, fontSize: portrait ? 40 : 34, marginTop: 30, textTransform: "uppercase", letterSpacing: 3 }}>— {by}</div> : null}
      <div style={{ display: "none" }}>{width}</div>
    </AbsoluteFill>
  );
};

/** name_label: lower-third over footage. */
export const NameLabel: React.FC<{ name?: string; title?: string; accent: string }> = ({ name, title, accent }) => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const s = useIn(2, 18);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", padding: portrait ? `0 60px ${height * 0.36}px` : "0 90px 120px" }}>
      <div style={{ transform: `translateX(${(1 - s) * -width * 0.6}px)` }}>
        <div style={{ background: accent, color: "#111", fontFamily: FONT, fontSize: portrait ? 64 : 54, padding: "10px 26px", textTransform: "uppercase" }}>{name}</div>
        {title ? <div style={{ background: "rgba(0,0,0,0.85)", color: "#fff", fontFamily: FONT_BODY, fontWeight: 700, fontSize: portrait ? 36 : 30, padding: "10px 26px", display: "inline-block" }}>{title}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
