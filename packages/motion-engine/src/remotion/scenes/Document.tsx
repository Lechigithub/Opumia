import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_SERIF, PALETTE } from "../types";
import { AccentLight, LightSweep } from "./Cinema";

export interface DocumentProps {
  style?: "newspaper" | "filing" | "letter" | "web";
  masthead?: string;
  date?: string;
  headline?: string;
  body?: string;
  highlight?: string;
  /** "yellow" marker (neutral evidence) or "red" (damning line). */
  tone?: "yellow" | "red";
  paperSrc?: string;
  /** Local frames when the narrator starts / finishes saying the highlighted phrase (word-synced sweep). */
  highlightAt?: number;
  highlightEnd?: number;
  accent: string;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Index range [from, to) of the highlight phrase inside a token list (case/punctuation-insensitive). */
function findPhrase(tokens: string[], phrase?: string): [number, number] | null {
  if (!phrase) return null;
  const p = phrase.split(/\s+/).map(norm).filter(Boolean);
  if (!p.length) return null;
  for (let i = 0; i + p.length <= tokens.length; i++) if (p.every((w, k) => norm(tokens[i + k]!) === w)) return [i, i + p.length];
  return null;
}

/** Text with a per-word marker sweep across the highlight phrase; wraps cleanly (words never split mid-sweep). */
const MarkedText: React.FC<{ text: string; phrase?: string; at: number; end: number; color: string; ink: string }> = ({ text, phrase, at, end, color, ink }) => {
  const f = useCurrentFrame();
  const tokens = text.split(/\s+/).filter(Boolean);
  const range = findPhrase(tokens, phrase);
  return (
    <>
      {tokens.map((w, i) => {
        const inside = range && i >= range[0] && i < range[1];
        if (!inside) return <React.Fragment key={i}>{w} </React.Fragment>;
        const lastInPhrase = i === range[1] - 1;
        const n = range[1] - range[0];
        const k = i - range[0];
        const span = Math.max(6, end - at);
        const p = interpolate(f, [at + (k / n) * span, at + ((k + 1) / n) * span], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.quad) });
        return (
          <React.Fragment key={i}>
            {/* The trailing space is inside the marked span so the sweep is one continuous stroke across the phrase. */}
            <span style={{ backgroundImage: `linear-gradient(${color}, ${color})`, backgroundRepeat: "no-repeat", backgroundSize: `${p * 100}% 80%`, backgroundPosition: "0 60%", color: ink, borderRadius: 2 }}>{lastInPhrase ? w : `${w}\u00a0`}</span>{lastInPhrase ? " " : ""}
          </React.Fragment>
        );
      })}
    </>
  );
};

/**
 * DocumentHighlightCard: a real-looking page (newspaper / filing / letter / web article) on a 3D tilt over the
 * darkened plate, entering from below; the camera pushes toward the highlighted line while a marker sweeps it
 * word by word in sync with the narration.
 */
export const DocumentScene: React.FC<DocumentProps> = ({ style = "newspaper", masthead, date, headline = "", body = "", highlight, tone = "yellow", paperSrc, highlightAt, highlightEnd, accent: _accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const at = highlightAt ?? Math.round(fps * 0.45);
  const end = highlightEnd ?? at + Math.round(fps * 0.9);
  const enter = spring({ frame: f + 3, fps, config: { damping: 20, stiffness: 70, mass: 0.9 } });
  const t = durationInFrames > 1 ? f / (durationInFrames - 1) : 0;
  // Push toward the highlight as it is spoken.
  const d = Math.max(4, durationInFrames);
  const k1 = Math.min(Math.max(1, at), d - 3);
  const k2 = Math.min(Math.max(k1 + 1, end + Math.round(fps * 0.4)), d - 2);
  const zoom = interpolate(f, [0, k1, k2, d - 1], [0.98, 1.06, 1.16, 1.2], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const color = tone === "red" ? PALETTE.crimson : PALETTE.marker;
  const web = style === "web";
  const serif = style === "newspaper" || style === "letter";
  const sheetW = portrait ? width * 0.92 : width * 0.56;
  const inHeadline = !!highlight && !!findPhrase(headline.split(/\s+/), highlight);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", perspective: 1800, background: "radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0.25), rgba(0,0,0,0.78))" }}>
      <AccentLight color={tone === "red" ? PALETTE.crimson : PALETTE.gold} at={[0.82, 0.18]} intensity={0.28} />
      <div
        style={{
          width: sheetW,
          minHeight: portrait ? height * 0.5 : height * 0.74,
          position: "relative",
          backgroundColor: web ? "#fbfbfa" : PALETTE.paper,
          boxShadow: "0 60px 120px rgba(0,0,0,0.85), 0 18px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.25)",
          transformStyle: "preserve-3d",
          transform: `translateY(${(1 - enter) * height * 0.45}px) translateX(${(t - 0.5) * -width * 0.03}px) rotateX(${14 - 4 * enter}deg) rotateY(${-9 + 5 * t}deg) rotateZ(${-2.5 + enter * 1.2}deg) scale(${zoom})`,
          overflow: "hidden",
        }}
      >
        {paperSrc && !web ? <Img src={staticFile(paperSrc)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.55, mixBlendMode: "multiply" }} /> : null}
        {web ? (
          <div style={{ height: portrait ? 54 : 46, background: "#111827", display: "flex", alignItems: "center", padding: "0 28px", gap: 18 }}>
            <div style={{ fontFamily: FONT_BODY, fontWeight: 900, color: "#fff", fontSize: portrait ? 26 : 22, letterSpacing: 1 }}>{(masthead ?? "NEWS").toUpperCase()}</div>
            {["World", "Business", "Tech", "Markets"].map((x) => (
              <div key={x} style={{ fontFamily: FONT_BODY, color: "rgba(255,255,255,0.6)", fontSize: portrait ? 20 : 17 }}>{x}</div>
            ))}
          </div>
        ) : null}
        <div style={{ position: "relative", color: "#16130e", padding: portrait ? "48px 52px 56px" : "44px 56px 52px" }}>
          {!web && masthead ? <div style={{ fontFamily: serif ? FONT_SERIF : FONT_BODY, fontWeight: 900, fontSize: portrait ? 60 : 52, textAlign: "center", borderBottom: "4px double #16130e", paddingBottom: 10, letterSpacing: serif ? 1 : 4, textTransform: serif ? "none" : "uppercase" }}>{masthead}</div> : null}
          {date ? <div style={{ fontFamily: FONT_BODY, fontSize: portrait ? 24 : 20, textAlign: web ? "left" : "center", padding: web ? "0 0 10px" : "10px 0 16px", borderBottom: web ? "none" : "1px solid #16130e", textTransform: "uppercase", letterSpacing: 2.5, color: web ? "#6b7280" : undefined }}>{date}</div> : null}
          <div style={{ fontFamily: serif ? FONT_SERIF : FONT_BODY, fontWeight: web ? 800 : 700, fontSize: portrait ? 68 : 66, lineHeight: 1.08, margin: web ? "4px 0 22px" : "24px 0 20px", letterSpacing: web ? -0.5 : 0, overflowWrap: "break-word", hyphens: "auto" }}>
            <MarkedText text={headline} phrase={inHeadline ? highlight : undefined} at={at} end={end} color={color} ink="#16130e" />
          </div>
          <div style={{ fontFamily: serif ? FONT_SERIF : FONT_BODY, fontSize: portrait ? 36 : 34, lineHeight: 1.45, columnCount: !portrait && style === "newspaper" ? 2 : 1, columnGap: 36, textAlign: style === "newspaper" ? "justify" : "left", hyphens: "auto", overflowWrap: "break-word", display: "-webkit-box", WebkitLineClamp: portrait ? 9 : 8, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            <MarkedText text={body} phrase={inHeadline ? undefined : highlight} at={at} end={end} color={color} ink="#16130e" />
          </div>
        </div>
        {/* Edge light on the page so it reads as a physical object under a lamp. */}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(160deg, rgba(255,255,255,0.18), transparent 35%, transparent 70%, rgba(0,0,0,0.18))", pointerEvents: "none" }} />
      </div>
      <LightSweep delay={Math.max(0, at - 6)} periodFrames={40} opacity={0.12} />
    </AbsoluteFill>
  );
};
