import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, PALETTE } from "../types";
import { AccentLight } from "./Cinema";

export interface VersusSide {
  label: string;
  value: string;
  /** Optional numeric magnitude for the scale bar (parsed from the value when absent). */
  magnitude?: number;
  photoSrc?: string;
}

const magnitudeOf = (s: string) => {
  const m = /([\d.,]+)\s*(T|B|M|K|trillion|billion|million|thousand)?/i.exec(s);
  if (!m) return 0;
  const n = Number(m[1]!.replace(/,/g, ""));
  const k = (m[2] ?? "").toLowerCase();
  return n * (k.startsWith("t") ? 1e12 : k.startsWith("b") ? 1e9 : k.startsWith("m") ? 1e6 : k.startsWith("k") || k.startsWith("th") ? 1e3 : 1);
};

/**
 * VersusSplitCard: head-to-head rivalry on a diagonal split — crimson side vs steel/gold side — each with a
 * textured plate (or photo), a punched-in value and label, a glowing seam with a VS badge, and a scale bar
 * underneath that shows how many times bigger one side is (contrast & scale framing).
 */
export const Versus: React.FC<{ title?: string; left?: VersusSide; right?: VersusSide; accent: string }> = ({ title, left, right }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  const split = spring({ frame: f + 2, fps, config: { damping: 18, stiffness: 120 } });
  const l = spring({ frame: f - 4, fps, config: { damping: 14, stiffness: 150, mass: 0.7 } });
  const r = spring({ frame: f - 9, fps, config: { damping: 14, stiffness: 150, mass: 0.7 } });
  const badge = spring({ frame: f - 12, fps, config: { damping: 9, stiffness: 220, mass: 0.6 } });
  const flash = interpolate(f, [12, 14, 22], [0, 0.55, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lm = left?.magnitude ?? magnitudeOf(left?.value ?? "");
  const rm = right?.magnitude ?? magnitudeOf(right?.value ?? "");
  const big = Math.max(lm, rm, 1);
  const ratio = lm && rm ? Math.max(lm, rm) / Math.min(lm, rm) : 0;
  const bars = interpolate(f, [fps * 0.7, fps * 1.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const seam = 50 + (1 - split) * 50; // diagonal seam slides in from the right
  const valueSize = portrait ? 104 : 118;
  const side = (s: VersusSide | undefined, k: number, which: "l" | "r") => (
    <div style={{ position: "absolute", top: 0, bottom: 0, [which === "l" ? "left" : "right"]: 0, width: portrait ? "100%" : "50%", height: portrait ? "50%" : "100%", ...(portrait && which === "r" ? { top: "50%" } : {}), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: `translate${portrait ? "Y" : "X"}(${(1 - k) * (which === "l" ? -120 : 120)}px)`, opacity: Math.min(1, k * 1.3) }}>
      <div style={{ fontFamily: FONT, fontSize: valueSize, color: which === "l" ? "#fff" : PALETTE.goldSoft, textShadow: `0 0 40px ${which === "l" ? PALETTE.crimson : PALETTE.gold}99, 0 12px 40px #000`, lineHeight: 1 }}>{s?.value}</div>
      <div style={{ marginTop: 18, background: which === "l" ? PALETTE.crimson : PALETTE.gold, color: which === "l" ? "#fff" : "#111", fontFamily: FONT_BODY, fontWeight: 900, fontSize: portrait ? 40 : 34, padding: "8px 22px", textTransform: "uppercase", letterSpacing: 2 }}>{s?.label}</div>
    </div>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: PALETTE.ink }}>
      {/* Left (crimson) and right (steel) plates, split on a diagonal seam. */}
      <AbsoluteFill style={{ clipPath: portrait ? `polygon(0 0, 100% 0, 100% ${seam - 4}%, 0 ${seam + 4}%)` : `polygon(0 0, ${seam + 4}% 0, ${seam - 4}% 100%, 0 100%)` }}>
        {left?.photoSrc ? <Img src={staticFile(left.photoSrc)} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "grayscale(1) contrast(1.2) brightness(0.55)" }} /> : null}
        <AbsoluteFill style={{ background: `linear-gradient(135deg, ${PALETTE.crimsonDeep}ee, ${PALETTE.crimson}88)`, mixBlendMode: left?.photoSrc ? "multiply" : "normal" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ clipPath: portrait ? `polygon(0 ${seam + 4}%, 100% ${seam - 4}%, 100% 100%, 0 100%)` : `polygon(${seam + 4}% 0, 100% 0, 100% 100%, ${seam - 4}% 100%)` }}>
        {right?.photoSrc ? <Img src={staticFile(right.photoSrc)} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "grayscale(1) contrast(1.2) brightness(0.55)" }} /> : null}
        <AbsoluteFill style={{ background: `linear-gradient(225deg, ${PALETTE.steel}f0, #0b1220dd)`, mixBlendMode: right?.photoSrc ? "multiply" : "normal" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: 0.18, backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,0.25) 0 2px, transparent 2px 14px)" }} />
      {/* Glowing seam */}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {portrait ? (
          <line x1={0} y1={((seam + 4) / 100) * height} x2={width} y2={((seam - 4) / 100) * height} stroke={PALETTE.goldSoft} strokeWidth={6} style={{ filter: `drop-shadow(0 0 18px ${PALETTE.gold})` }} />
        ) : (
          <line x1={((seam + 4) / 100) * width} y1={0} x2={((seam - 4) / 100) * width} y2={height} stroke={PALETTE.goldSoft} strokeWidth={6} style={{ filter: `drop-shadow(0 0 18px ${PALETTE.gold})` }} />
        )}
      </svg>
      {side(left, l, "l")}
      {side(right, r, "r")}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
        <div style={{ width: portrait ? 150 : 170, height: portrait ? 150 : 170, borderRadius: "50%", background: "#0b0b0b", border: `6px solid ${PALETTE.goldSoft}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, color: "#fff", fontSize: portrait ? 64 : 72, transform: `scale(${badge}) rotate(${(1 - badge) * -40}deg)`, boxShadow: `0 0 50px ${PALETTE.gold}aa` }}>VS</div>
      </AbsoluteFill>
      {title ? (
        <div style={{ position: "absolute", top: height * 0.07, width: "100%", textAlign: "center", fontFamily: FONT_BODY, fontWeight: 900, color: "#fff", fontSize: portrait ? 50 : 44, textTransform: "uppercase", letterSpacing: 3, textShadow: "0 6px 24px #000" }}>{title}</div>
      ) : null}
      {/* Scale bar: proportional magnitudes + "N× bigger" tag. */}
      {lm && rm && !portrait ? (
        <div style={{ position: "absolute", left: width * 0.12, right: width * 0.12, bottom: height * 0.2, display: "flex", flexDirection: "column", gap: 10 }}>
          {[{ m: lm, c: PALETTE.crimson }, { m: rm, c: PALETTE.gold }].map((b, i) => (
            <div key={i} style={{ height: 16, width: `${(b.m / big) * 100 * bars}%`, background: b.c, boxShadow: `0 0 16px ${b.c}`, borderRadius: 4 }} />
          ))}
          {ratio >= 1.5 ? <div style={{ alignSelf: "flex-end", fontFamily: FONT, color: "#fff", fontSize: 40, opacity: bars, textShadow: "0 4px 18px #000" }}>{ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× BIGGER</div> : null}
        </div>
      ) : null}
      <AccentLight color="#ffffff" at={[0.5, 0.5]} intensity={flash} />
    </AbsoluteFill>
  );
};
