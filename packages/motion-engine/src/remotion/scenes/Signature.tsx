import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, FONT_SERIF, PALETTE, SAFE } from "../types";

/**
 * MagnatesMedia signature primitives (from Library/moments/MagnatesMedia): HeroFaceSplit (NameTag/HeroFace),
 * SharpOverlayCounter (Counter over actor footage), CutoutCollage (LiftOut/Tear), TitleRollChapter (TitleRoll),
 * ScreenMock. None of them blurs the picture underneath.
 */


const Media: React.FC<{ src: string; style?: React.CSSProperties; fit?: "cover" | "contain" }> = ({ src, style, fit = "cover" }) => {
  const s: React.CSSProperties = { width: "100%", height: "100%", objectFit: fit, ...style };
  return /\.(mp4|mov|webm)$/i.test(src) ? <OffthreadVideo src={staticFile(src)} muted style={s} /> : <Img src={staticFile(src)} style={s} />;
};

/** HeroFaceSplit: crimson block with a big condensed name on the left, B&W portrait on the right (typographic fallback). */
export const HeroFaceSplit: React.FC<{ name?: string; title?: string; portraitSrc?: string; accent: string }> = ({ name = "", title, portraitSrc }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const wipe = spring({ frame: f + 2, fps, config: { damping: 20, stiffness: 140 } });
  const nameIn = spring({ frame: f - 5, fps, config: { damping: 16, stiffness: 160 } });
  const push = interpolate(f, [0, durationInFrames], [1.04, 1.12]);
  const words = name.toUpperCase().split(/\s+/).filter(Boolean);
  const size = Math.min(portrait ? 120 : 150, ((portrait ? width : width * 0.42) * 0.9) / Math.max(4, ...words.map((w) => w.length * 0.55)));
  const panel = portrait ? { left: 0, right: 0, top: 0, height: "45%" } : { left: 0, top: 0, bottom: 0, width: "44%" };
  const photo = portrait ? { left: 0, right: 0, bottom: 0, height: "55%" } : { right: 0, top: 0, bottom: 0, width: "56%" };
  return (
    <AbsoluteFill style={{ backgroundColor: portraitSrc ? PALETTE.ink : "transparent" }}>
      <div style={{ position: "absolute", ...photo, overflow: "hidden", background: portraitSrc ? "#111" : "transparent" }}>
        {portraitSrc ? (
          <div style={{ width: "100%", height: "100%", transform: `scale(${push})` }}>
            <Media src={portraitSrc} fit="cover" style={{ filter: "grayscale(1) contrast(1.35) brightness(0.95)" }} />
          </div>
        ) : null /* no portrait: the sharp footage plate shows through — never a placeholder */}
        <AbsoluteFill style={{ background: `linear-gradient(${portrait ? "180deg" : "90deg"}, ${PALETTE.crimsonDeep}cc, transparent 35%)` }} />
      </div>
      <div style={{ position: "absolute", ...panel, background: `linear-gradient(160deg, ${PALETTE.crimson}, ${PALETTE.crimsonDeep})`, transform: portrait ? `translateY(${(1 - wipe) * -100}%)` : `translateX(${(1 - wipe) * -100}%)`, display: "flex", flexDirection: "column", justifyContent: "center", padding: portrait ? "0 60px" : "0 70px", boxShadow: "20px 0 60px rgba(0,0,0,0.6)" }}>
        {words.map((w, i) => (
          <div key={i} style={{ fontFamily: FONT, fontSize: size, lineHeight: 0.92, color: "#fff", letterSpacing: 1, transform: `translateY(${(1 - nameIn) * (30 + i * 15)}px)`, opacity: Math.min(1, nameIn * 1.4) }}>{w}</div>
        ))}
        {title ? <div style={{ marginTop: 22, fontFamily: FONT_BODY, fontWeight: 800, fontSize: portrait ? 34 : 30, color: PALETTE.goldSoft, textTransform: "uppercase", letterSpacing: 3, opacity: nameIn }}>{title}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

/** SharpOverlayCounter: gold running counter + thin label anchored in the upper side third, straight over sharp footage. */
export const SharpOverlayCounter: React.FC<{ display?: string; value?: number; prefix?: string; suffix?: string; label?: string; side?: "left" | "right"; accent: string }> = ({ display, value = 0, prefix = "", suffix = "", label, side = "left" }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const target = display ?? `${prefix}${value.toLocaleString("en-US")}${suffix}`;
  const m = /^([^\d]*)([\d,]*\.?\d+)(.*)$/.exec(target);
  const pre = m?.[1] ?? "";
  const raw = m?.[2] ?? "0";
  const mant = Number(raw.replace(/,/g, ""));
  const dec = (raw.split(".")[1] ?? "").length;
  // Counts up over 0.8 s from 0 like the reference (a ticking tally), then holds exactly on the spoken string.
  const p = interpolate(f, [2, 2 + fps * 0.8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const cur = p >= 1 ? raw : raw.includes(",") ? Math.round(mant * p).toLocaleString("en-US") : (mant * p).toFixed(dec);
  const out = interpolate(f, [durationInFrames - 6, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fs = portrait ? 120 : 112;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* A soft local shade (not a box) so gold reads on bright footage. */}
      <div style={{ position: "absolute", [side]: 0, top: 0, width: "60%", height: "55%", background: `radial-gradient(ellipse at ${side === "left" ? "25%" : "75%"} 35%, rgba(0,0,0,0.55), transparent 65%)`, opacity: out }} />
      <div style={{ position: "absolute", top: height * (portrait ? 0.12 : 0.14), [side]: width * 0.07, textAlign: side, opacity: out }}>
        <div style={{ fontFamily: FONT, fontSize: fs, color: PALETTE.goldSoft, letterSpacing: 1, fontVariantNumeric: "tabular-nums", textShadow: `0 0 26px ${PALETTE.gold}88, 0 4px 18px rgba(0,0,0,0.9)` }}>
          {pre}
          {cur}
          {m?.[3] ?? ""}
        </div>
        {label ? (
          <div style={{ display: "inline-block", marginTop: 4, borderTop: `3px solid ${PALETTE.gold}`, paddingTop: 8, fontFamily: FONT_BODY, fontWeight: 800, color: "#fff", fontSize: portrait ? 32 : 26, textTransform: "uppercase", letterSpacing: 3, textShadow: "0 2px 10px rgba(0,0,0,0.95)", transform: `scaleX(${p})`, transformOrigin: side }}>{label}</div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/** Jagged torn-paper polygon (deterministic) for clip-path. */
const torn = (seed: number) => {
  const pts: string[] = [];
  const r = (i: number) => ((Math.sin(seed * 97 + i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  for (let i = 0; i <= 24; i++) pts.push(`${(i / 24) * 100}% ${r(i) * 3}%`);
  for (let i = 0; i <= 16; i++) pts.push(`${97 + r(i + 40) * 3}% ${(i / 16) * 100}%`);
  for (let i = 24; i >= 0; i--) pts.push(`${(i / 24) * 100}% ${97 + r(i + 80) * 3}%`);
  for (let i = 16; i >= 0; i--) pts.push(`${r(i + 120) * 3}% ${(i / 16) * 100}%`);
  return `polygon(${pts.join(",")})`;
};

/** CutoutCollage: duotone giant backdrop of the subject + the subject lifted out (PNG cutout) or torn out (photo/video). */
export const CutoutCollage: React.FC<{ subjectSrc?: string; title?: string; tone?: "crimson" | "gold" | "teal"; accent: string }> = ({ subjectSrc, title, tone = "crimson" }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const tint = tone === "gold" ? PALETTE.gold : tone === "teal" ? "#0F766E" : PALETTE.crimson;
  const lift = spring({ frame: f + 2, fps, config: { damping: 15, stiffness: 120 } });
  const t = f / Math.max(1, durationInFrames - 1);
  const cut = !!subjectSrc && /\.png$/i.test(subjectSrc);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0b0b", overflow: "hidden" }}>
      {subjectSrc ? (
        <AbsoluteFill style={{ transform: `scale(${1.6 + 0.08 * t}) translateX(${(t - 0.5) * 3}%)`, filter: "grayscale(1) contrast(1.4) brightness(0.6)" }}>
          <Media src={subjectSrc} fit="cover" />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={{ background: tint, mixBlendMode: "multiply", opacity: 0.92 }} />
      <AbsoluteFill style={{ opacity: 0.25, backgroundImage: "radial-gradient(rgba(0,0,0,0.6) 1.2px, transparent 1.3px)", backgroundSize: "9px 9px" }} />
      {subjectSrc ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: cut ? width * 0.5 : width * 0.46, height: cut ? height * 0.86 : height * 0.6, transform: `translateY(${(1 - lift) * 120}px) rotate(${(1 - lift) * -6 + 1.5 - t * 1.5}deg) scale(${0.96 + 0.06 * t})`, filter: "drop-shadow(0 30px 40px rgba(0,0,0,0.75))" }}>
            <div style={{ width: "100%", height: "100%", clipPath: cut ? undefined : torn(7), background: cut ? undefined : "#f1ece1", padding: cut ? 0 : 14 }}>
              <Media src={subjectSrc} fit={cut ? "contain" : "cover"} style={{ filter: cut ? "contrast(1.15)" : "grayscale(0.2) contrast(1.1)" }} />
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
      {title ? (
        <div style={{ position: "absolute", left: width * 0.06, bottom: height * 0.22, fontFamily: FONT, fontSize: height * 0.13, color: "#fff", lineHeight: 0.9, textTransform: "uppercase", textShadow: "0 8px 30px rgba(0,0,0,0.8)", opacity: lift }}>{title}</div>
      ) : null}
    </AbsoluteFill>
  );
};

/** TitleRollChapter: serif chapter title rolling forward in 3D on a white paper light, small teaser line above. */
export const TitleRollChapter: React.FC<{ title?: string; teaser?: string; index?: number; accent: string }> = ({ title = "", teaser, index }) => {
  const f = useCurrentFrame();
  const { fps, height, durationInFrames } = useVideoConfig();
  const roll = spring({ frame: f + 2, fps, config: { damping: 22, stiffness: 70 } });
  const out = interpolate(f, [durationInFrames - 8, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 45%, #fbfaf6 0%, #dcd8cf 55%, #8d8a83 100%)", alignItems: "center", justifyContent: "center", perspective: 1200, opacity: out }}>
      <div style={{ textAlign: "center", transform: `rotateX(${(1 - roll) * 70}deg) translateZ(${(1 - roll) * -300}px) rotateZ(${(1 - roll) * -6}deg)` }}>
        <div style={{ fontFamily: FONT_BODY, fontSize: height * 0.028, color: "#2b2b2b", letterSpacing: 6, textTransform: "uppercase", marginBottom: 14 }}>{teaser ?? (index ? `Chapter ${index}` : "Chapter")}</div>
        <div style={{ fontFamily: FONT_SERIF, fontWeight: 700, fontSize: height * 0.11, color: "#121212", lineHeight: 1, letterSpacing: 1 }}>{title}</div>
        <div style={{ margin: "22px auto 0", height: 5, width: `${roll * 40}%`, background: PALETTE.crimson }} />
      </div>
    </AbsoluteFill>
  );
};

/** ScreenMock: a tilted dark monitor (or phone) with UI lines typing on, glowing in a dark room. */
export const ScreenMock: React.FC<{ title?: string; lines?: string[]; device?: "monitor" | "phone"; accent: string }> = ({ title, lines = [], device = "monitor" }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const enter = spring({ frame: f + 3, fps, config: { damping: 22, stiffness: 80 } });
  const t = f / Math.max(1, durationInFrames - 1);
  const phone = device === "phone";
  const W = phone ? height * 0.46 : width * 0.72;
  const H = phone ? height * 0.84 : height * 0.7;
  const per = Math.max(4, Math.floor((durationInFrames * 0.6) / Math.max(1, lines.length)));
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 55%, rgba(40,60,95,0.45) 0%, rgba(5,7,11,0.55) 75%)", alignItems: "center", justifyContent: "center", perspective: 1500 }}>
      <div style={{ width: W, height: H, borderRadius: phone ? 46 : 18, border: "10px solid #1c1f26", boxShadow: "0 60px 120px rgba(0,0,0,0.8), 0 0 80px rgba(80,140,255,0.18)", transform: `rotateY(${-16 + 8 * t}deg) rotateX(${8 - 3 * enter}deg) translateY(${(1 - enter) * 200}px) scale(${0.95 + 0.06 * t})`, overflow: "hidden", padding: phone ? "60px 34px" : "48px 60px", backgroundImage: "linear-gradient(180deg, #1c2b4a, #101a2e)" }}>
        {title ? <div style={{ fontFamily: FONT_BODY, fontWeight: 800, color: "#e5e7eb", fontSize: phone ? 44 : height * 0.05, borderBottom: "1px solid #2a3140", paddingBottom: 14, marginBottom: 20 }}>{title}</div> : null}
        {lines.map((l, i) => {
          const shown = Math.floor(interpolate(f, [6 + i * per, 6 + i * per + per * 0.8], [0, l.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
          return (
            <div key={i} style={{ fontFamily: `"SF Mono", Menlo, monospace`, color: i === lines.length - 1 ? PALETTE.goldSoft : "#93c5fd", fontSize: phone ? 38 : height * 0.045, lineHeight: 1.5, whiteSpace: "nowrap", overflow: "hidden" }}>
              {"› "}
              {l.slice(0, shown)}
              {shown < l.length && shown > 0 ? <span style={{ opacity: f % 16 < 8 ? 1 : 0 }}>▍</span> : null}
            </div>
          );
        })}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(130deg, rgba(255,255,255,0.08), transparent 40%)", pointerEvents: "none" }} />
      </div>
      <div style={{ display: "none" }}>{SAFE.lowerThird169}{FONT}</div>
    </AbsoluteFill>
  );
};

