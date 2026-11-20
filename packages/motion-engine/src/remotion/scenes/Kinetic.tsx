import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, FONT_SERIF, PALETTE, SAFE } from "../types";

// Entrances are pre-rolled by 3 frames so a card's first frame is never empty (no blank frames at cuts).
const PREROLL = 3;
const useIn = (delay = 0, damping = 14) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f + PREROLL - delay, fps, config: { damping, stiffness: 140, mass: 0.7 } });
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
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at center, rgba(0,0,0,0.15), rgba(0,0,0,0.6))" }}>
      <div style={{ transform: `scale(${push})`, textAlign: "center" }}>
        {words.map((w, i) => {
          const s = useIn(i * 4);
          return (
            <div key={i} style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 0.95, color: i === words.length - 1 && words.length > 1 ? PALETTE.crimson : "#fff", transform: `translateY(${(1 - s) * 80}px) scale(${0.7 + 0.3 * s})`, opacity: Math.min(1, s * 1.4), textShadow: i === words.length - 1 && words.length > 1 ? `0 0 30px ${PALETTE.crimson}88, 0 10px 40px rgba(0,0,0,0.8)` : "0 0 24px rgba(255,255,255,0.18), 0 10px 40px rgba(0,0,0,0.8)", letterSpacing: -2 }}>
              {w}
            </div>
          );
        })}
        <div style={{ height: 10, margin: "18px auto 0", width: `${interpolate(f, [6, 18], [0, 70], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}%`, background: PALETTE.crimson, boxShadow: `0 0 24px ${PALETTE.crimson}` }} />
        {sub ? <div style={{ fontFamily: FONT_BODY, fontWeight: 700, color: "rgba(255,255,255,0.9)", fontSize: portrait ? 48 : 40, marginTop: 28, opacity: useIn(10, 200), textTransform: "uppercase", letterSpacing: 3 }}>{sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

/** money_figure: the spoken figure (exact on-screen string from number parity) counts up with a gold glow. */
export const MoneyFigure: React.FC<{ value?: number; prefix?: string; suffix?: string; display?: string; label?: string; accent: string }> = ({ value = 0, prefix = "", suffix = "", display, label }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  // The exact string the narrator says ("$7.2B"); fallback: compact formatting of the bound fact value.
  const [div, unitL] = Math.abs(value) >= 1e12 ? [1e12, "T"] : Math.abs(value) >= 1e9 ? [1e9, "B"] : Math.abs(value) >= 1e6 ? [1e6, "M"] : [1, ""];
  const target = display ?? (unitL ? `${prefix}${+(value / div).toFixed(2)}${unitL}${suffix}` : `${prefix}${value.toLocaleString("en-US")}${suffix}`);
  const m = /^([^\d]*)([\d,]*\.?\d+)(.*)$/.exec(target);
  const pre = m?.[1] ?? "";
  const mant = Number((m?.[2] ?? "0").replace(/,/g, ""));
  const post = m?.[3] ?? "";
  const dec = ((m?.[2] ?? "").split(".")[1] ?? "").length;
  const commas = (m?.[2] ?? "").includes(",");
  // Fast count-up from 85 % (lands on the exact spoken string within 0.45 s; no misleading in-between figures).
  const p = interpolate(f, [0, fps * 0.45], [0.85, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - Math.pow(1 - t, 3) });
  const cur = p >= 1 ? (m?.[2] ?? "") : commas ? Math.round(mant * p).toLocaleString("en-US") : (mant * p).toFixed(dec);
  const shown = `${pre}${cur}${post}`;
  const fs = Math.min(portrait ? 170 : 200, (width * 0.86) / Math.max(1, target.length * 0.62));
  const s = useIn(0);
  const ring = interpolate(f, [0, fps * 0.9], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at center, rgba(0,0,0,0.15), rgba(0,0,0,0.62))" }}>
      <div style={{ position: "absolute", width: fs * 4.2, height: fs * 4.2, borderRadius: "50%", border: `3px solid ${PALETTE.gold}`, opacity: 0.35 * (1 - ring), transform: `scale(${0.6 + 0.6 * ring})`, boxShadow: `0 0 60px ${PALETTE.gold}` }} />
      <div style={{ fontFamily: FONT, color: PALETTE.goldSoft, fontSize: fs, transform: `scale(${0.8 + 0.2 * s}) perspective(900px) rotateX(${(1 - s) * 25}deg)`, textShadow: `0 0 50px ${PALETTE.gold}aa, 0 0 12px ${PALETTE.gold}66, 0 14px 40px #000`, fontVariantNumeric: "tabular-nums", letterSpacing: -1 }}>{shown}</div>
      {label ? <div style={{ marginTop: 14, background: PALETTE.crimson, color: "#fff", fontFamily: FONT_BODY, fontWeight: 900, fontSize: portrait ? 44 : 38, padding: "6px 22px", textTransform: "uppercase", letterSpacing: 3, opacity: useIn(8, 200), maxWidth: width * 0.85, textAlign: "center" }}>{label}</div> : null}
    </AbsoluteFill>
  );
};

/**
 * timeline: a lit track with a progress fill and large year/label stops. Readable at any frame:
 * the first stop is pre-rolled, the backdrop is light enough that the plate reads as texture.
 */
export const Timeline: React.FC<{ items?: Array<{ year: string; label: string }>; accent: string }> = ({ items = [], accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const n = Math.max(1, items.length);
  const step = Math.max(6, Math.floor(Math.min(fps * 2.4, durationInFrames * 0.6) / n));
  const fill = interpolate(f, [0, Math.max(1, step * (n - 1) + 8)], [n > 1 ? 0.04 : 1, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const yearSize = portrait ? 92 : Math.round(height * 0.1);
  const labelSize = portrait ? 44 : Math.round(height * 0.04);
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(10,12,18,0.45), rgba(0,0,0,0.72))", justifyContent: "center", padding: portrait ? "0 70px" : `0 ${Math.round(width * 0.08)}px` }}>
      <div style={{ position: "relative", display: "flex", flexDirection: portrait ? "column" : "row", gap: portrait ? 56 : 40 }}>
        {/* track + progress fill */}
        <div style={{ position: "absolute", ...(portrait ? { left: 0, top: 0, bottom: 0, width: 10 } : { left: 0, right: 0, top: 0, height: 10 }), background: "rgba(255,255,255,0.28)", borderRadius: 5 }} />
        <div style={{ position: "absolute", ...(portrait ? { left: 0, top: 0, width: 10, height: `${fill * 100}%` } : { left: 0, top: 0, height: 10, width: `${fill * 100}%` }), background: accent, borderRadius: 5, boxShadow: `0 0 24px ${accent}` }} />
        {items.map((it, i) => {
          const s = spring({ frame: f + 4 - i * step, fps, config: { damping: 16 } });
          return (
            <div key={i} style={{ flex: 1, opacity: Math.max(0.15, s), transform: `translate${portrait ? "X" : "Y"}(${(1 - s) * 40}px)`, padding: portrait ? "0 0 0 44px" : "40px 8px 0 0" }}>
              <div style={{ width: 26, height: 26, borderRadius: 13, background: accent, boxShadow: `0 0 18px ${accent}`, position: "relative", ...(portrait ? { left: -52, top: yearSize * 0.35, marginBottom: -26 } : { top: -58, marginBottom: -26 }) }} />
              <div style={{ fontFamily: FONT, color: accent, fontSize: yearSize, lineHeight: 1, textShadow: "0 6px 24px rgba(0,0,0,0.8)" }}>{it.year}</div>
              <div style={{ fontFamily: FONT_BODY, fontWeight: 800, color: "#fff", fontSize: labelSize, lineHeight: 1.15, marginTop: 12, textTransform: "uppercase", letterSpacing: 1, textShadow: "0 4px 16px rgba(0,0,0,0.85)" }}>{it.label}</div>
            </div>
          );
        })}
      </div>
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
    <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(0,0,0,0.82), rgba(0,0,0,0.45))", justifyContent: "center", padding: portrait ? "0 80px" : "0 200px" }}>
      <div style={{ position: "absolute", left: portrait ? 50 : 150, top: "30%", bottom: "30%", width: 8, background: PALETTE.crimson, boxShadow: `0 0 24px ${PALETTE.crimson}` }} />
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
export const NameLabel: React.FC<{ name?: string; title?: string; accent: string }> = ({ name, title }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const bar = useIn(0, 20);
  const s = useIn(4, 18);
  const t = useIn(9, 22);
  const nameSize = portrait ? 62 : 52;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", padding: portrait ? `0 60px ${height * SAFE.lowerThird916}px` : `0 90px ${height * SAFE.lowerThird169}px` }}>
      {/* Soft ground shadow so the label reads on any plate without a flat box. */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "42%", background: "linear-gradient(to top, rgba(0,0,0,0.6), transparent)", opacity: bar }} />
      <div style={{ position: "relative", display: "flex", alignItems: "stretch", gap: 0 }}>
        <div style={{ width: 12, background: PALETTE.crimson, boxShadow: `0 0 24px ${PALETTE.crimson}`, transform: `scaleY(${bar})`, transformOrigin: "bottom" }} />
        <div style={{ overflow: "hidden" }}>
          <div style={{ background: "rgba(8,8,10,0.78)", backdropFilter: "blur(6px)", padding: "10px 28px 8px", transform: `translateX(${(1 - s) * -105}%)` }}>
            <div style={{ fontFamily: FONT, color: "#fff", fontSize: nameSize, textTransform: "uppercase", letterSpacing: 1, lineHeight: 1.05 }}>{name}</div>
          </div>
          {title ? (
            <div style={{ display: "inline-block", background: PALETTE.gold, padding: "6px 28px", transform: `translateX(${(1 - t) * -105}%)` }}>
              <div style={{ fontFamily: FONT_BODY, fontWeight: 800, color: "#111", fontSize: portrait ? 32 : 27, textTransform: "uppercase", letterSpacing: 2 }}>{title}</div>
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ display: "none" }}>{f + width}</div>
    </AbsoluteFill>
  );
};
