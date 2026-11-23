import { RetouchFilter, retouchCss, type RetouchSpec } from "../scenes/Worlds";
import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, PALETTE } from "../types";
import { TREATMENT, TYPO, type TextStyleName } from "./tokens";
import { Card3D, Text3D } from "../scenes/Three";

/**
 * Thumbnail layers: the packaging agent's own toolkit (thumbnail lettering, shapes, textures, cut-out finishing),
 * frozen after the entrances. Used ONLY for thumbnails; films are drawn from their own kit (scenes/Composed.tsx).
 * Every picture is a real one (no generated imagery).
 */
type Enter = "fade" | "slide_left" | "slide_right" | "slide_up" | "slide_down" | "pop" | "stamp" | "type" | "draw" | "wipe" | "zoom";
type Token = "primary" | "primarySoft" | "accent" | "accentDeep" | "surface" | "surfaceAlt" | "paper" | "marker" | "text" | "textMuted" | "black" | "white";
interface Box { x: number; y: number; w: number; rot?: number; z?: number; at?: number; enter?: Enter }
type El =
  | (Box & { type: "photo"; slot: number; frame?: "none" | "print" | "torn" | "circle" | "tv" | "polaroid"; grade?: "natural" | "mono" | "duotone"; h?: number })
  | (Box & {
      type: "cutout";
      slot: number;
      shadow?: boolean;
      outline?: boolean;
      /** Thumbnail finishing, all on the picture's own pixels: a coloured glow (rim light), a colour tint masked to the
       * subject, a punchier grade or mono, a glitch colour split, one half only (two half-faces make one face), mirrored. */
      glowColor?: string;
      glowSize?: number;
      tint?: string;
      tintStrength?: number;
      look?: "natural" | "punch" | "mono" | "glitch";
      /** Owner 2026-11-23: deterministic face retouching (smoothing, sharpening, relighting, an exaggerating warp). */
      retouch?: RetouchSpec;
      half?: "left" | "right" | "top" | "bottom";
      flip?: boolean;
      outlineColor?: string;
      /** Light from the scene behind: the background's colour laid over the subject at soft-light, so it sits in it. */
      matchColor?: string;
      matchStrength?: number;
      /** Light falling on the subject from the backdrop's light (CSS gradient angle pointing away from the light). */
      lightAngle?: number;
      lightColor?: string;
      lightStrength?: number;
      brightness?: number;
      /** Compositing into a real scene: a contact shadow on the ground, softened cut edges, a perspective turn. */
      contactShadow?: number;
      soften?: number;
      turnX?: number;
      turnY?: number;
      /** A real texture (blood splatter, cracks, burns, dirt) laid on the subject only. */
      textureSlot?: number;
      textureBlend?: "multiply" | "screen" | "overlay" | "darken" | "normal";
      textureOpacity?: number;
    })
  | (Box & {
      type: "text";
      text: string;
      role: "display" | "headline" | "body" | "label" | "stamp" | "kicker";
      size: number;
      align?: "left" | "center" | "right";
      color?: Token;
      box?: Token;
      highlightWord?: string;
      /** Thumbnail lettering: a font family stack, a drawing style and exact colours (override the film treatment). */
      fontFamily?: string;
      letter?: "label_box" | "outlined" | "plain" | "glow" | "gradient";
      fill?: string;
      boxFill?: string;
      strokeColor?: string;
      highlightFill?: string;
      italic?: boolean;
      /** A picture (public path) seen through the letters. */
      fillImage?: string;
    })
  | (Box & { type: "phrase"; text: string; size: number; align?: "left" | "center" | "right"; color?: Token; emphasis?: string; wordFrames?: number[] })
  | (Box & { type: "text3d"; text: string; color?: Token; spin?: number })
  | (Box & { type: "card3d"; slot: number; tilt?: number; spin?: number })
  | (Box & { type: "shape"; shape: "underline" | "circle" | "arrow" | "bar" | "line" | "rect" | "bracket" | "cross"; h?: number; color?: Token; x2?: number; y2?: number })
  | { type: "texture"; texture: "paper" | "halftone" | "grid" | "scanlines" | "noise" | "stripes"; opacity?: number; at?: number }
  // G24 vocabulary
  | (Box & { type: "counter"; count: number; highlight?: number; slot?: number; cols?: number; color?: Token; label?: string })
  | (Box & { type: "steps"; direction?: "row" | "column"; items: Array<{ label: string; slot?: number }>; color?: Token })
  | (Box & { type: "icongrid"; items: Array<{ slot: number; label: string }>; cols?: number })
  | (Box & { type: "newspaper"; headline: string; date?: string; slot?: number })
  | (Box & { type: "screen"; slot: number; device?: "browser" | "phone" | "monitor"; scroll?: number });


export interface ThumbLayersProps {
  spec: { backdrop?: "footage" | "surface" | "paper" | "split" | "world"; wash?: { color: Token; strength: number; mode: "tint" | "duotone" }; camera: { fromScale: number; toScale: number; fromX: number; toX: number; fromY: number; toY: number }; elements: El[] };
  slots: Record<string, string>;
  accent?: string;
}

const tok = (t: Token | undefined, d: string) =>
  t === "primary" ? PALETTE.primary : t === "primarySoft" ? PALETTE.primarySoft : t === "accent" ? PALETTE.accent : t === "accentDeep" ? PALETTE.accentDeep : t === "surface" ? PALETTE.surface : t === "surfaceAlt" ? PALETTE.surfaceAlt : t === "paper" ? PALETTE.paper : t === "marker" ? PALETTE.marker : t === "text" ? PALETTE.text : t === "textMuted" ? PALETTE.textMuted : t === "black" ? "#000000" : t === "white" ? "#ffffff" : d;

const TORN = "polygon(0% 3%, 7% 0%, 15% 2%, 24% 0%, 33% 3%, 41% 1%, 52% 3%, 60% 0%, 71% 2%, 80% 0%, 89% 3%, 100% 1%, 98% 12%, 100% 25%, 97% 38%, 100% 50%, 98% 63%, 100% 76%, 97% 88%, 100% 99%, 90% 97%, 80% 100%, 69% 97%, 58% 100%, 47% 98%, 36% 100%, 25% 97%, 14% 100%, 5% 98%, 0% 100%, 2% 87%, 0% 74%, 3% 61%, 0% 49%, 2% 36%, 0% 24%, 3% 12%)";

/** Deterministic pseudo-random in [0,1) from an integer seed. */
const rnd = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** The film's text styles: how type is drawn is a per-film decision, not a per-element one. */
function textCss(style: TextStyleName, color: string, size: number): React.CSSProperties {
  const g = TREATMENT.glow;
  switch (style) {
    case "neon_glow":
      // A dark edge under the glow keeps neon type readable on busy footage.
      return { color, WebkitTextStroke: `${Math.max(2, size * 0.035)}px rgba(0,0,0,0.85)`, paintOrder: "stroke fill", textShadow: `0 0 ${size * 0.16 * (0.5 + g)}px ${color}, 0 0 ${size * 0.45 * (0.5 + g)}px ${color}aa, 0 ${size * 0.05}px ${size * 0.1}px rgba(0,0,0,0.9)` } as React.CSSProperties;
    case "solid_stroke":
      return { color, WebkitTextStroke: `${Math.max(3, size * 0.09)}px #0a0a0a`, paintOrder: "stroke fill", textShadow: `0 ${size * 0.06}px 0 #0a0a0a, 0 ${size * 0.14}px ${size * 0.25}px rgba(0,0,0,0.6)` } as React.CSSProperties;
    case "boxed":
      return { color: "#fff", background: color === "#ffffff" || color === PALETTE.text ? PALETTE.accent : color, padding: `${size * 0.1}px ${size * 0.28}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone", boxShadow: `0 ${size * 0.1}px ${size * 0.3}px rgba(0,0,0,0.5)` } as React.CSSProperties;
    case "gradient":
      return { backgroundImage: `linear-gradient(180deg, #ffffff 10%, ${color} 55%, ${PALETTE.accent} 120%)`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 ${size * 0.06}px ${size * 0.12}px rgba(0,0,0,0.75))` } as React.CSSProperties;
    case "paper_cut":
      return { color: "#15120d", background: PALETTE.paper, padding: `${size * 0.08}px ${size * 0.24}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone", boxShadow: `${size * 0.05}px ${size * 0.08}px 0 rgba(0,0,0,0.45)` } as React.CSSProperties;
    case "outline_only":
      return { color: "transparent", WebkitTextStroke: `${Math.max(2, size * 0.035)}px ${color}`, textShadow: `0 0 ${size * 0.3 * g}px ${color}88` } as React.CSSProperties;
  }
}

function useEnter(at: number, enter: Enter) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f - Math.round(at * fps);
  const soft = spring({ frame: t, fps, config: { damping: 18, stiffness: 140, mass: 0.8 } });
  const snappy = spring({ frame: t, fps, config: { damping: 11, stiffness: 260, mass: 0.6 } });
  const lin = interpolate(t, [0, fps * 0.55], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const vis = t >= 0 ? 1 : 0;
  switch (enter) {
    case "slide_left":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateX(${(1 - soft) * -160}px)`, p: soft, clip: undefined };
    case "slide_right":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateX(${(1 - soft) * 160}px)`, p: soft, clip: undefined };
    case "slide_up":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateY(${(1 - soft) * 110}px)`, p: soft, clip: undefined };
    case "slide_down":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateY(${(1 - soft) * -110}px)`, p: soft, clip: undefined };
    case "pop":
      return { opacity: Math.min(1, snappy * 2) * vis, transform: `scale(${0.55 + 0.45 * snappy})`, p: snappy, clip: undefined };
    case "stamp":
      return { opacity: Math.min(1, snappy * 3) * vis, transform: `scale(${1.8 - 0.8 * snappy}) rotate(${(1 - snappy) * -7}deg)`, p: snappy, clip: undefined };
    case "zoom":
      return { opacity: lin * vis, transform: `scale(${1.22 - 0.22 * lin})`, p: lin, clip: undefined };
    case "wipe":
    case "draw":
      return { opacity: vis, transform: "", p: lin, clip: `inset(0 ${(1 - lin) * 100}% 0 0)` };
    case "type":
      return { opacity: vis, transform: "", p: lin, clip: undefined };
    default:
      return { opacity: lin * vis, transform: "", p: lin, clip: undefined };
  }
}

/** Procedural colour worlds in the film's palette: always moving, never a flat card. */
const World: React.FC<{ kind: typeof TREATMENT.world }> = ({ kind }) => {
  const f = useCurrentFrame();
  const a = PALETTE.primary;
  const b = PALETTE.accent;
  const base = PALETTE.surface;
  const d = f / 14;
  if (kind === "paper") return <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${40 + Math.sin(d * 0.3) * 6}% 35%, ${PALETTE.paper}, #cfc6b3 95%)` }} />;
  if (kind === "blueprint")
    return (
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 40%, ${PALETTE.surfaceAlt}, ${base} 85%)` }}>
        <AbsoluteFill style={{ opacity: 0.35, backgroundImage: `linear-gradient(${a}55 1.5px, transparent 1.5px), linear-gradient(90deg, ${a}55 1.5px, transparent 1.5px)`, backgroundSize: "90px 90px", backgroundPosition: `${d * 14}px ${d * 9}px` }} />
        <AbsoluteFill style={{ opacity: 0.18, backgroundImage: `linear-gradient(${a}66 1px, transparent 1px), linear-gradient(90deg, ${a}66 1px, transparent 1px)`, backgroundSize: "18px 18px", backgroundPosition: `${d * 14}px ${d * 9}px` }} />
      </AbsoluteFill>
    );
  if (kind === "halftone")
    return (
      <AbsoluteFill style={{ background: `linear-gradient(${120 + d * 9}deg, ${a}, ${b})` }}>
        <AbsoluteFill style={{ opacity: 0.5, backgroundImage: "radial-gradient(rgba(0,0,0,0.9) 3.2px, transparent 3.6px)", backgroundSize: "16px 16px", backgroundPosition: `${d * 16}px ${d * 10}px` }} />
        <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 30%, ${base}cc 100%)` }} />
      </AbsoluteFill>
    );
  if (kind === "stripes")
    return (
      <AbsoluteFill style={{ background: base }}>
        <AbsoluteFill style={{ backgroundImage: `repeating-linear-gradient(115deg, ${a} 0 90px, ${b} 90px 180px, ${PALETTE.surfaceAlt} 180px 270px)`, backgroundPosition: `${d * 60}px 0`, opacity: 0.9 }} />
        <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 25%, ${base}dd 100%)` }} />
      </AbsoluteFill>
    );
  if (kind === "spotlight")
    return (
      <AbsoluteFill style={{ background: base }}>
        <AbsoluteFill style={{ background: `radial-gradient(ellipse 55% 70% at ${50 + Math.sin(d * 0.5) * 10}% 45%, ${a}cc, ${b}55 45%, transparent 75%)` }} />
        <AbsoluteFill style={{ background: `conic-gradient(from ${d * 12}deg at 50% 45%, transparent 0 20deg, ${a}22 20deg 40deg, transparent 40deg 80deg, ${a}18 80deg 100deg, transparent 100deg 360deg)` }} />
      </AbsoluteFill>
    );
  // nebula / smoke: drifting colour clouds.
  const blobs = kind === "nebula" ? 5 : 4;
  return (
    <AbsoluteFill style={{ background: base }}>
      {Array.from({ length: blobs }, (_, i) => {
        const x = 20 + rnd(i * 7 + 1) * 60 + Math.sin(d * (0.15 + rnd(i) * 0.2) + i) * 12;
        const y = 20 + rnd(i * 13 + 2) * 60 + Math.cos(d * (0.12 + rnd(i + 5) * 0.2) + i * 2) * 10;
        const c = i % 2 ? a : b;
        return <AbsoluteFill key={i} style={{ background: `radial-gradient(ellipse ${38 + rnd(i * 3) * 22}% ${34 + rnd(i * 5) * 22}% at ${x}% ${y}%, ${c}${kind === "nebula" ? "aa" : "66"}, transparent 70%)`, mixBlendMode: "screen" }} />;
      })}
      {kind === "nebula" ? <AbsoluteFill style={{ opacity: 0.5, backgroundImage: "radial-gradient(#fff 1px, transparent 1.4px), radial-gradient(#fff 1px, transparent 1.6px)", backgroundSize: "190px 170px, 260px 230px", backgroundPosition: `${d * 5}px ${d * 2}px, ${-d * 3}px ${d * 4}px` }} /> : null}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 35%, ${base}cc 100%)` }} />
    </AbsoluteFill>
  );
};

/** Drifting particles in the film's colours (depth: small/slow far, large/fast near). */
const Particles: React.FC<{ kind: typeof TREATMENT.particles }> = ({ kind }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (kind === "none") return null;
  const n = kind === "bokeh" ? 14 : 34;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {Array.from({ length: n }, (_, i) => {
        const depth = 0.3 + rnd(i * 3 + 1) * 0.7;
        const up = kind === "embers" ? -1 : kind === "snow" ? 1 : rnd(i * 17) > 0.5 ? -0.25 : 0.25;
        const speed = (kind === "embers" ? 2.2 : kind === "snow" ? 1.6 : 0.5) * depth;
        const x = (rnd(i * 5 + 2) * width + Math.sin(f / (26 + i) + i) * 24 * depth + f * 0.35 * depth) % width;
        const y0 = rnd(i * 11 + 3) * height;
        const y = (((y0 + f * speed * up) % height) + height) % height;
        const size = kind === "bokeh" ? 40 + rnd(i * 7) * 120 : (kind === "dust" ? 2 : 3) + rnd(i * 7) * (kind === "dust" ? 4 : 6);
        const color = kind === "embers" ? (i % 3 ? PALETTE.accent : PALETTE.marker) : kind === "bokeh" ? (i % 2 ? PALETTE.primary : PALETTE.accent) : "#ffffff";
        const tw = 0.5 + 0.5 * Math.sin(f / (9 + rnd(i) * 14) + i);
        return <div key={i} style={{ position: "absolute", left: x, top: y, width: size, height: size, borderRadius: "50%", background: color, opacity: (kind === "bokeh" ? 0.1 : 0.55) * depth * (0.5 + 0.5 * tw), filter: kind === "bokeh" ? "blur(14px)" : kind === "embers" ? `blur(0.5px) drop-shadow(0 0 6px ${color})` : "blur(0.6px)" }} />;
      })}
    </AbsoluteFill>
  );
};

const Element: React.FC<{ el: El; i: number; slots: Record<string, string>; drift: number }> = ({ el, i, slots, drift }) => {
  const { width, height, fps } = useVideoConfig();
  const f = useCurrentFrame();
  const at = "at" in el ? (el.at ?? 0) : 0;
  const e = useEnter(at, el.type === "texture" || el.type === "phrase" ? "fade" : (el.enter ?? "fade"));
  if (el.type === "texture") {
    const bg =
      el.texture === "halftone" ? { backgroundImage: "radial-gradient(rgba(0,0,0,0.85) 1.1px, transparent 1.4px)", backgroundSize: "7px 7px" }
      : el.texture === "grid" ? { backgroundImage: "linear-gradient(rgba(255,255,255,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.18) 1px, transparent 1px)", backgroundSize: "60px 60px" }
      : el.texture === "scanlines" ? { backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.5) 0 2px, transparent 2px 5px)" }
      : el.texture === "stripes" ? { backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,0.14) 0 3px, transparent 3px 18px)" }
      : el.texture === "paper" ? { background: `radial-gradient(ellipse at 30% 20%, rgba(255,250,235,0.5), transparent 60%), radial-gradient(ellipse at 80% 90%, rgba(120,90,50,0.35), transparent 55%)`, mixBlendMode: "multiply" as const }
      : { backgroundImage: `repeating-radial-gradient(circle at ${(f * 37) % 100}% ${(f * 53) % 100}%, rgba(255,255,255,0.08) 0 1px, transparent 1px 3px)` };
    return <AbsoluteFill style={{ pointerEvents: "none", opacity: (el.opacity ?? 0.35) * e.opacity, ...bg }} />;
  }
  const z = el.z ?? 0.5;
  const par = (z - 0.5) * drift;
  // Continuous life: every element floats a little, nearer ones more; phase differs per element.
  const fl = 5 + z * 12;
  const floatX = Math.sin(f / (34 + i * 5) + i * 1.7) * fl;
  const floatY = Math.cos(f / (27 + i * 4) + i * 0.9) * fl * 0.8;
  const floatR = Math.sin(f / (48 + i * 6) + i) * (el.type === "text" || el.type === "phrase" ? 0.15 : 0.7);
  const left = Math.min(el.x * width + par, width * 0.97 - el.w * width) + floatX;
  const top = el.y * height + par * 0.35 + floatY;
  const w = el.w * width;
  const rot = (el.rot ?? 0) + floatR;
  const wrap = (child: React.ReactNode, h?: number) => (
    <div style={{ position: "absolute", left, top, width: w, ...(h ? { height: h } : {}), transform: `rotate(${rot}deg) ${e.transform}`, transformOrigin: "50% 50%", opacity: e.opacity, ...(e.clip ? { clipPath: e.clip } : {}) }}>{child}</div>
  );

  if (el.type === "photo") {
    const src = slots[String(el.slot)];
    if (!src) return null;
    const h = el.h ? el.h * height : undefined;
    const filter = el.grade === "mono" ? "grayscale(1) contrast(1.18) brightness(1.02)" : el.grade === "duotone" ? "grayscale(1) contrast(1.25)" : "contrast(1.06) saturate(1.05)";
    // Slow push inside the frame so a still photo is never frozen.
    const inner = 1.04 + 0.06 * interpolate(f, [0, fps * 6], [0, 1], { extrapolateRight: "clamp" });
    const img = <Img src={staticFile(src)} style={{ width: "100%", height: h ? "100%" : "auto", objectFit: "cover", display: "block", filter, transform: `scale(${inner})` }} />;
    const duo = el.grade === "duotone" ? <div style={{ position: "absolute", inset: 0, background: PALETTE.primary, mixBlendMode: "multiply", opacity: 0.8 }} /> : null;
    const frame = el.frame ?? TREATMENT.photo;
    if (frame === "circle") return wrap(<div style={{ width: w, height: w, borderRadius: "50%", overflow: "hidden", border: `${Math.round(w * 0.025)}px solid ${PALETTE.primary}`, boxShadow: `0 24px 60px rgba(0,0,0,0.6), 0 0 ${40 * TREATMENT.glow}px ${PALETTE.primary}88`, position: "relative" }}><Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", filter, transform: `scale(${inner})` }} />{duo}</div>);
    if (frame === "torn") return wrap(<div style={{ clipPath: TORN, position: "relative", height: h, overflow: "hidden", filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.7))" }}>{img}{duo}</div>, h);
    if (frame === "tv") return wrap(<div style={{ background: "#0b0b0b", padding: w * 0.035, borderRadius: w * 0.03, boxShadow: "0 30px 80px rgba(0,0,0,0.75)", position: "relative" }}><div style={{ position: "relative", height: h, overflow: "hidden", borderRadius: w * 0.012 }}>{img}{duo}<div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0 2px, transparent 2px 4px)", backgroundPosition: `0 ${f % 4}px` }} /></div></div>);
    if (frame === "none") return wrap(<div style={{ position: "relative", height: h, overflow: "hidden", boxShadow: `0 20px 50px rgba(0,0,0,0.6), 0 0 0 ${Math.max(3, w * 0.006)}px ${PALETTE.primary}` }}>{img}{duo}</div>, h);
    const pad = Math.round(w * 0.03);
    return wrap(<div style={{ background: "#f4f1ea", padding: pad, paddingBottom: frame === "polaroid" ? pad * 4 : pad, boxShadow: "0 26px 60px rgba(0,0,0,0.65)", position: "relative" }}><div style={{ position: "relative", height: h ? h - pad * 2 : undefined, overflow: "hidden" }}>{img}{duo}</div></div>);
  }
  if (el.type === "cutout") {
    const src = slots[String(el.slot)];
    if (!src) return null;
    const o = Math.max(3, w * 0.008);
    const hex = (c?: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);
    const oc = hex(el.outlineColor) ?? "#fff";
    const outline = el.outline ? `drop-shadow(${o}px 0 0 ${oc}) drop-shadow(-${o}px 0 0 ${oc}) drop-shadow(0 ${o}px 0 ${oc}) drop-shadow(0 -${o}px 0 ${oc}) ` : "";
    const gc = hex(el.glowColor);
    const gs = Math.max(0.3, Math.min(3, el.glowSize ?? 1));
    const glow = gc ? `drop-shadow(0 0 ${Math.round(w * 0.012 * gs)}px ${gc}) drop-shadow(0 0 ${Math.round(w * 0.04 * gs)}px ${gc}cc) ` : TREATMENT.glow > 0.3 ? `drop-shadow(0 0 ${28 * TREATMENT.glow}px ${PALETTE.primary}aa) ` : "";
    const bright = el.brightness ? ` brightness(${Math.max(0.6, Math.min(1.5, el.brightness))})` : "";
    const soft = el.soften ? ` blur(${Math.max(0, Math.min(3, el.soften)).toFixed(2)}px)` : "";
    const grade = (el.look === "punch" ? "contrast(1.22) saturate(1.45) brightness(1.06)" : el.look === "mono" ? "grayscale(1) contrast(1.3) brightness(1.04)" : el.look === "glitch" ? "contrast(1.15) saturate(1.2)" : "") + bright + soft || "none";
    const clip = el.half === "left" ? "inset(0 50% 0 0)" : el.half === "right" ? "inset(0 0 0 50%)" : el.half === "top" ? "inset(0 0 50% 0)" : el.half === "bottom" ? "inset(50% 0 0 0)" : undefined;
    const flip = el.flip ? "scaleX(-1)" : undefined;
    const mask = (extra: React.CSSProperties = {}): React.CSSProperties => ({ position: "absolute", inset: 0, WebkitMaskImage: `url(${staticFile(src)})`, maskImage: `url(${staticFile(src)})`, WebkitMaskSize: "100% 100%", maskSize: "100% 100%", ...(flip ? { transform: flip } : {}), ...extra });
    const tc = hex(el.tint);
    const off = Math.max(2, w * 0.012);
    const texSrc = el.textureSlot !== undefined ? slots[String(el.textureSlot)] : undefined;
    const turn = el.turnX || el.turnY ? `perspective(${Math.round(w * 2.2)}px) rotateY(${Math.max(-35, Math.min(35, el.turnY ?? 0))}deg) rotateX(${Math.max(-25, Math.min(25, el.turnX ?? 0))}deg)` : undefined;
    return wrap(
      <div style={{ position: "relative", ...(turn ? { transform: turn } : {}), filter: `${outline}${glow}${el.shadow === false ? "" : "drop-shadow(0 18px 28px rgba(0,0,0,0.65))"}`.trim() || undefined }}>
        {el.contactShadow ? <div style={mask({ background: "#000", opacity: Math.max(0, Math.min(1, el.contactShadow)), top: "auto", height: "100%", transform: `translateY(48%) scaleY(0.12) ${flip ?? ""}`, filter: `blur(${Math.round(w * 0.02)}px)` })} /> : null}
        <div style={{ position: "relative", ...(clip ? { clipPath: clip } : {}) }}>
          {el.retouch ? <RetouchFilter id={`trt${el.slot}`} r={el.retouch} /> : null}
          <Img src={staticFile(src)} style={{ width: "100%", height: "auto", display: "block", filter: el.retouch ? `url(#trt${el.slot}) ${retouchCss(el.retouch)} ${grade ?? ""}`.trim() : grade, ...(flip ? { transform: flip } : {}) }} />
          {tc ? <div style={mask({ background: tc, mixBlendMode: "color", opacity: Math.max(0, Math.min(1, el.tintStrength ?? 0.6)) })} /> : null}
          {texSrc ? <div style={mask({ backgroundImage: `url(${staticFile(texSrc)})`, backgroundSize: "cover", backgroundPosition: "center", mixBlendMode: el.textureBlend ?? "multiply", opacity: Math.max(0, Math.min(1, el.textureOpacity ?? 0.8)) })} /> : null}
          {hex(el.matchColor) ? <div style={mask({ background: `radial-gradient(ellipse at 50% 30%, transparent 20%, ${hex(el.matchColor)} 100%)`, mixBlendMode: "soft-light", opacity: Math.max(0, Math.min(1, el.matchStrength ?? 0.55)) })} /> : null}
          {el.lightAngle !== undefined ? <div style={mask({ background: `linear-gradient(${Math.round(el.lightAngle)}deg, ${hex(el.lightColor) ?? "#fff4e0"} 0%, transparent 55%, rgba(0,0,0,0.55) 100%)`, mixBlendMode: "soft-light", opacity: Math.max(0, Math.min(1, el.lightStrength ?? 0.45)) })} /> : null}
          {el.look === "glitch" ? (
            <>
              <div style={mask({ background: "#ff2a55", mixBlendMode: "screen", opacity: 0.55, left: -off, right: off })} />
              <div style={mask({ background: "#19e6ff", mixBlendMode: "screen", opacity: 0.45, left: off, right: -off })} />
            </>
          ) : null}
        </div>
      </div>,
    );
  }
  if (el.type === "card3d") {
    const src = slots[String(el.slot)];
    if (!src) return null;
    const h3 = w * 0.75;
    return (
      <div style={{ position: "absolute", left, top, width: w, height: h3, opacity: e.opacity }}>
        <Card3D src={src} tilt={el.tilt ?? -14} spin={el.spin ?? 22} at={at} w={w} h={h3} />
      </div>
    );
  }
  if (el.type === "text3d") {
    const h3 = w * 0.42;
    return (
      <div style={{ position: "absolute", left, top, width: w, height: h3 }}>
        <Text3D text={el.text} color={tok(el.color, PALETTE.primary)} spin={el.spin ?? 18} at={at} w={w} h={h3} />
      </div>
    );
  }
  if (el.type === "phrase") {
    // Kinetic narration phrase: each word lands when it is spoken, in the film's phrase style.
    const words = el.text.split(/\s+/).filter(Boolean);
    const longest = Math.max(1, ...words.map((x) => x.length));
    const size = Math.min(el.size * height, (w / (longest * 0.7)) * 0.96);
    const color = tok(el.color, PALETTE.text);
    const emph = (el.emphasis ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const start = Math.round(at * fps);
    return (
      <div style={{ position: "absolute", left, top, width: w, transform: `rotate(${rot}deg)`, textAlign: el.align ?? "center", lineHeight: TREATMENT.phrase === "boxed" || TREATMENT.phrase === "paper_cut" ? 1.5 : 1.08 }}>
        {words.map((wd, k) => {
          const wf = el.wordFrames?.[k] ?? start + k * 6;
          const p = spring({ frame: f - wf, fps, config: { damping: 13, stiffness: 240, mass: 0.5 } });
          const isE = emph && wd.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === emph;
          const c = isE ? PALETTE.accent : color;
          return (
            <span key={k} style={{ display: "inline-block", marginRight: size * 0.26, opacity: f >= wf ? Math.min(1, p * 2) : 0, transform: `translateY(${(1 - p) * size * 0.35}px) scale(${0.8 + 0.2 * p})`, fontFamily: FONT, fontWeight: 900, fontSize: isE ? size * 1.12 : size, letterSpacing: TYPO.tracking, ...textCss(TREATMENT.phrase, c, size) }}>
              {TYPO.casing === "upper" ? wd.toUpperCase() : wd}
            </span>
          );
        })}
      </div>
    );
  }
  if (el.type === "text") {
    const display = el.role === "display" || el.role === "headline" || el.role === "stamp";
    const longest = Math.max(1, ...el.text.split(/\s+/).map((x) => x.length));
    const em = display ? (TYPO.casing === "upper" ? 0.74 : 0.62) : 0.56;
    const pad = el.role === "stamp" ? 1.25 : el.box || el.letter === "label_box" || (!el.letter && TREATMENT.headline === "boxed") ? 1.18 : 1;
    const size = Math.min(el.size * height, (w / (longest * em * pad)) * 0.96);
    const color = tok(el.color, PALETTE.text);
    const raw = (display || el.role === "kicker" || el.role === "label") && TYPO.casing === "upper" ? el.text.toUpperCase() : el.text;
    const shown = el.enter === "type" ? raw.slice(0, Math.ceil(raw.length * e.p)) : raw;
    const hw = el.highlightWord?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const hx = (c?: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);
    const hiColor = hx(el.highlightFill) ?? PALETTE.accent;
    const content = shown.split(/(\s+)/).map((wd, k) => (hw && wd.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === hw ? <span key={k} style={{ ...((el.letter ?? (TREATMENT.headline === "gradient" ? "gradient" : "")) === "gradient" && display ? { WebkitTextFillColor: hiColor } : { color: hiColor }) }}>{wd}</span> : <span key={k}>{wd}</span>));
    let css: React.CSSProperties;
    if (el.letter) {
      const fill = hx(el.fill) ?? color;
      const stroke = hx(el.strokeColor) ?? "#0a0a0a";
      css =
        el.letter === "label_box" ? ({ color: fill, background: hx(el.boxFill) ?? PALETTE.accent, padding: `${size * 0.06}px ${size * 0.22}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone", boxShadow: `0 ${size * 0.08}px ${size * 0.25}px rgba(0,0,0,0.45)` } as React.CSSProperties)
        : el.letter === "outlined" ? ({ color: fill, WebkitTextStroke: `${Math.max(3, size * 0.08)}px ${stroke}`, paintOrder: "stroke fill", textShadow: `0 ${size * 0.05}px 0 ${stroke}, 0 ${size * 0.12}px ${size * 0.22}px rgba(0,0,0,0.6)` } as React.CSSProperties)
        : el.letter === "glow" ? ({ color: fill, textShadow: `0 0 ${size * 0.12}px ${fill}, 0 0 ${size * 0.35}px ${fill}aa, 0 ${size * 0.05}px ${size * 0.1}px rgba(0,0,0,0.9)` } as React.CSSProperties)
        : el.letter === "gradient" ? ({ backgroundImage: `linear-gradient(180deg, #ffffff 5%, ${fill} 60%, ${hx(el.boxFill) ?? PALETTE.accent} 115%)`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 ${size * 0.05}px ${size * 0.1}px rgba(0,0,0,0.8))` } as React.CSSProperties)
        : { color: fill, textShadow: `0 ${size * 0.04}px ${size * 0.16}px rgba(0,0,0,0.85)` };
      if (el.fillImage) css = { ...css, backgroundImage: `url(${staticFile(el.fillImage)})`, backgroundSize: "cover", backgroundPosition: "center", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", WebkitTextFillColor: "transparent", textShadow: "none", filter: `drop-shadow(0 ${size * 0.05}px ${size * 0.12}px rgba(0,0,0,0.85))` } as React.CSSProperties;
    } else if (display && el.role !== "stamp") css = el.box ? { color, background: tok(el.box, PALETTE.surface), padding: `${size * 0.12}px ${size * 0.3}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } as React.CSSProperties : textCss(TREATMENT.headline, color, size);
    else if (el.role === "stamp") css = { color, border: `${Math.max(4, size * 0.07)}px solid ${color}`, padding: `${size * 0.08}px ${size * 0.25}px`, display: "inline-block", textShadow: "0 3px 10px rgba(0,0,0,0.7)" };
    else if (el.role === "label" || el.role === "kicker") {
      const l = TREATMENT.label;
      css =
        l === "tag" ? { color: "#0c0c0c", background: color === PALETTE.text ? PALETTE.primary : color, padding: `${size * 0.16}px ${size * 0.45}px` }
        : l === "pill" ? { color: "#fff", background: `${PALETTE.surface}dd`, border: `2px solid ${color}`, borderRadius: size, padding: `${size * 0.18}px ${size * 0.6}px` }
        : l === "underline" ? { color, borderBottom: `${Math.max(3, size * 0.12)}px solid ${PALETTE.accent}`, paddingBottom: size * 0.12, textShadow: "0 2px 10px rgba(0,0,0,0.9)" }
        : l === "bracket" ? { color, borderLeft: `${Math.max(4, size * 0.16)}px solid ${PALETTE.accent}`, paddingLeft: size * 0.4, textShadow: "0 2px 10px rgba(0,0,0,0.9)" }
        : { color, textShadow: "0 2px 12px rgba(0,0,0,0.95), 0 0 2px #000" };
    } else css = el.box ? { color, background: tok(el.box, PALETTE.surface), padding: `${size * 0.12}px ${size * 0.3}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } as React.CSSProperties : { color, textShadow: "0 3px 18px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.9)" };
    return wrap(
      <div style={{ textAlign: el.align ?? "left", lineHeight: display ? (el.letter === "label_box" || (!el.letter && (TREATMENT.headline === "boxed" || TREATMENT.headline === "paper_cut")) ? 1.3 : 1.0) : 1.2 }}>
        <span style={{ display: "inline", fontFamily: el.fontFamily ?? (display ? FONT : FONT_BODY), fontWeight: display ? 900 : el.role === "label" || el.role === "kicker" ? 800 : 600, fontStyle: el.italic ? "italic" : "normal", fontSize: size, letterSpacing: el.fontFamily ? 0 : display ? TYPO.tracking : el.role === "kicker" ? 4 : 0.5, ...css }}>{content}</span>
      </div>,
    );
  }
  // ---- G24 vocabulary: counters, step flows, icon infographics, newspaper layouts, screens.
  const startF = at * fps;
  const label = (t: string, size: number, color = PALETTE.text) => <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, color, textAlign: "center", lineHeight: 1.05, letterSpacing: TYPO.tracking, textShadow: "0 2px 10px rgba(0,0,0,0.85)" }}>{t}</div>;
  if (el.type === "counter") {
    const n = Math.max(1, Math.min(60, el.count));
    const cols = el.cols ?? Math.min(n, n > 24 ? 12 : 10);
    const cell = w / cols;
    const hi = Math.min(n, el.highlight ?? 0);
    const src = el.slot !== undefined ? slots[String(el.slot)] : undefined;
    const c = tok(el.color, PALETTE.accent);
    const items = Array.from({ length: n }, (_, k) => {
      const shown = f >= startF + k * 2;
      const p = shown ? spring({ frame: f - startF - k * 2, fps, config: { damping: 14 } }) : 0;
      const on = k < hi || hi === 0;
      const glyph = src
        ? <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "contain", filter: on ? "none" : "grayscale(1) brightness(0.55)" }} />
        : <svg viewBox="0 0 24 32" style={{ width: "100%", height: "100%" }}><circle cx="12" cy="7" r="6" fill={on ? c : PALETTE.textMuted} /><path d="M2 32 C2 18 22 18 22 32 Z" fill={on ? c : PALETTE.textMuted} /></svg>;
      return <div key={k} style={{ width: cell * 0.86, height: cell * (src ? 0.86 : 1.15), margin: cell * 0.07, transform: `scale(${p})`, opacity: on ? 1 : 0.45 }}>{glyph}</div>;
    });
    return wrap(<div><div style={{ display: "flex", flexWrap: "wrap", width: w }}>{items}</div>{el.label ? <div style={{ marginTop: cell * 0.2 }}>{label(el.label, Math.max(28, cell * 0.55))}</div> : null}</div>);
  }
  if (el.type === "steps") {
    const n = el.items.length;
    const row = (el.direction ?? "row") === "row";
    const c = tok(el.color, PALETTE.primary);
    const size = row ? Math.max(24, (w / n) * 0.13) : Math.max(26, w * 0.07);
    const boxes = el.items.map((it, k) => {
      const t0 = startF + k * fps * 0.45;
      const p = f >= t0 ? spring({ frame: f - t0, fps, config: { damping: 16 } }) : 0;
      const src = it.slot !== undefined ? slots[String(it.slot)] : undefined;
      return (
        <React.Fragment key={k}>
          {k > 0 ? <div style={{ alignSelf: "center", fontFamily: FONT, fontWeight: 900, fontSize: size * 1.4, color: c, opacity: p, margin: row ? `0 ${size * 0.3}px` : `${size * 0.1}px 0`, transform: row ? undefined : "rotate(90deg)" }}>→</div> : null}
          <div style={{ flex: 1, opacity: p, transform: `translateY(${(1 - p) * 30}px)`, background: `${PALETTE.surface}e6`, border: `3px solid ${c}`, borderRadius: 14, padding: size * 0.45, display: "flex", flexDirection: "column", alignItems: "center", gap: size * 0.3, boxShadow: "0 18px 40px rgba(0,0,0,0.5)" }}>
            <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: size * 0.8, color: c }}>{k + 1}</div>
            {src ? <Img src={staticFile(src)} style={{ width: "70%", maxHeight: size * 4, objectFit: "contain" }} /> : null}
            {label(it.label, size)}
          </div>
        </React.Fragment>
      );
    });
    return wrap(<div style={{ display: "flex", flexDirection: row ? "row" : "column", width: w, alignItems: "stretch" }}>{boxes}</div>);
  }
  if (el.type === "icongrid") {
    const n = el.items.length;
    const cols = el.cols ?? Math.min(n, 3);
    const cell = w / cols;
    const cells = el.items.map((it, k) => {
      const src = slots[String(it.slot)];
      const t0 = startF + k * fps * 0.25;
      const p = f >= t0 ? spring({ frame: f - t0, fps, config: { damping: 15 } }) : 0;
      return (
        <div key={k} style={{ width: cell, padding: cell * 0.08, display: "flex", flexDirection: "column", alignItems: "center", gap: cell * 0.06, opacity: p, transform: `scale(${0.7 + 0.3 * p})` }}>
          <div style={{ width: cell * 0.55, height: cell * 0.55, borderRadius: "50%", background: `${PALETTE.surface}cc`, border: `3px solid ${PALETTE.primary}`, display: "flex", alignItems: "center", justifyContent: "center" }}>{src ? <Img src={staticFile(src)} style={{ width: "62%", height: "62%", objectFit: "contain" }} /> : null}</div>
          {label(it.label, Math.max(22, cell * 0.11))}
        </div>
      );
    });
    return wrap(<div style={{ display: "flex", flexWrap: "wrap", width: w, justifyContent: "center" }}>{cells}</div>);
  }
  if (el.type === "newspaper") {
    const src = el.slot !== undefined ? slots[String(el.slot)] : undefined;
    const H = w * 1.18;
    const serif = "'Playfair Display', 'Times New Roman', Georgia, serif";
    const bars = (rows: number) => <div style={{ flex: 1, backgroundImage: "repeating-linear-gradient(180deg, rgba(40,35,30,0.35) 0 5px, transparent 5px 14px)", minHeight: rows * 14 }} />;
    return wrap(
      <div style={{ width: w, height: H, background: "#efe7d4", padding: w * 0.05, boxShadow: "0 30px 70px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", gap: w * 0.02, position: "relative", overflow: "hidden" }}>
        <div style={{ borderTop: "4px solid #222", borderBottom: "1px solid #222", height: w * 0.012 }} />
        {el.date ? <div style={{ fontFamily: serif, fontSize: w * 0.03, color: "#333", textTransform: "uppercase", letterSpacing: 2 }}>{el.date}</div> : null}
        <div style={{ fontFamily: serif, fontWeight: 900, fontSize: w * (el.headline.length > 40 ? 0.07 : 0.09), lineHeight: 1.02, color: "#151311" }}>{el.headline}</div>
        <div style={{ display: "flex", gap: w * 0.03, flex: 1 }}>
          {src ? <div style={{ width: "55%", display: "flex", flexDirection: "column", gap: 8 }}><Img src={staticFile(src)} style={{ width: "100%", height: H * 0.42, objectFit: "cover", filter: "grayscale(1) contrast(1.15)" }} />{bars(4)}</div> : bars(10)}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>{bars(12)}</div>
        </div>
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 30% 20%, rgba(255,250,235,0.3), transparent 60%), radial-gradient(ellipse at 80% 90%, rgba(120,90,50,0.25), transparent 55%)", mixBlendMode: "multiply", pointerEvents: "none" }} />
      </div>,
      H,
    );
  }
  if (el.type === "screen") {
    const src = slots[String(el.slot)];
    if (!src) return null;
    const dev = el.device ?? "browser";
    const H = dev === "phone" ? w * 2.05 : w * 0.62;
    const p = interpolate(f, [startF + fps * 0.6, startF + fps * 6], [0, el.scroll ?? 0.25], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
    const view = <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: `50% ${p * 100}%`, display: "block" }} />;
    if (dev === "phone")
      return wrap(<div style={{ width: w, height: H, borderRadius: w * 0.14, background: "#0c0c0e", padding: w * 0.045, boxShadow: "0 30px 70px rgba(0,0,0,0.65)" }}><div style={{ width: "100%", height: "100%", borderRadius: w * 0.1, overflow: "hidden", position: "relative" }}>{view}<div style={{ position: "absolute", top: w * 0.03, left: "35%", width: "30%", height: w * 0.06, borderRadius: w, background: "#0c0c0e" }} /></div></div>, H);
    const bar = w * 0.045;
    return wrap(
      <div style={{ width: w }}>
        <div style={{ width: w, height: H, borderRadius: 12, overflow: "hidden", background: "#1b1d22", boxShadow: "0 30px 70px rgba(0,0,0,0.65)", border: dev === "monitor" ? `${w * 0.02}px solid #111` : "1px solid #333" }}>
          {dev === "browser" ? <div style={{ height: bar, display: "flex", alignItems: "center", gap: bar * 0.25, padding: `0 ${bar * 0.4}px`, background: "#2a2d34" }}>{["#ff5f57", "#febc2e", "#28c840"].map((c) => <div key={c} style={{ width: bar * 0.32, height: bar * 0.32, borderRadius: "50%", background: c }} />)}<div style={{ flex: 1, height: bar * 0.5, borderRadius: bar, background: "#3a3e47", marginLeft: bar * 0.4 }} /></div> : null}
          <div style={{ width: "100%", height: dev === "browser" ? H - bar : H }}>{view}</div>
        </div>
        {dev === "monitor" ? <div style={{ width: w * 0.18, height: w * 0.08, margin: "0 auto", background: "linear-gradient(#222, #111)" }} /> : null}
      </div>,
    );
  }
  // Shapes.
  if (el.type !== "shape") return null;
  const color = tok(el.color, PALETTE.accent);
  const sw = Math.max(4, (el.h ?? 0.008) * height);
  const x1 = el.x * width + par;
  const y1 = el.y * height;
  const W = el.w * width;
  const H = (el.h ?? 0.01) * height;
  const len = 4000;
  const dash = { strokeDasharray: len, strokeDashoffset: len * (1 - (el.enter === "draw" ? e.p : 1)) };
  const glow = { filter: `drop-shadow(0 0 ${6 + 14 * TREATMENT.glow}px ${color})` };
  let shape: React.ReactNode = null;
  if (el.shape === "underline" || el.shape === "bar") shape = <rect x={x1} y={y1} width={W * (el.enter === "draw" ? e.p : 1)} height={el.shape === "bar" ? H : sw} fill={color} style={glow} />;
  else if (el.shape === "rect") shape = <rect x={x1} y={y1} width={W} height={H} fill="none" stroke={color} strokeWidth={6} style={{ ...dash, ...glow }} />;
  else if (el.shape === "circle") shape = <ellipse cx={x1 + W / 2} cy={y1 + Math.max(H, W * 0.35) / 2} rx={W / 2} ry={Math.max(H, W * 0.35) / 2} fill="none" stroke={color} strokeWidth={7} style={{ ...dash, ...glow }} />;
  else if (el.shape === "line" || el.shape === "arrow") {
    const x2 = (el.x2 ?? el.x + el.w) * width + par;
    const y2 = (el.y2 ?? el.y) * height;
    const a = Math.atan2(y2 - y1, x2 - x1);
    const hx = x1 + (x2 - x1) * (el.enter === "draw" ? e.p : 1);
    const hy = y1 + (y2 - y1) * (el.enter === "draw" ? e.p : 1);
    shape = (
      <g style={glow}>
        <line x1={x1} y1={y1} x2={hx} y2={hy} stroke={color} strokeWidth={10} strokeLinecap="round" />
        {el.shape === "arrow" && e.p > 0.85 ? <polygon points={`${hx},${hy} ${hx - 40 * Math.cos(a - 0.45)},${hy - 40 * Math.sin(a - 0.45)} ${hx - 40 * Math.cos(a + 0.45)},${hy - 40 * Math.sin(a + 0.45)}`} fill={color} /> : null}
      </g>
    );
  } else if (el.shape === "bracket") shape = <path d={`M ${x1 + 30} ${y1} L ${x1} ${y1} L ${x1} ${y1 + Math.max(H, 80)} L ${x1 + 30} ${y1 + Math.max(H, 80)}`} fill="none" stroke={color} strokeWidth={7} style={{ ...dash, ...glow }} />;
  else if (el.shape === "cross") shape = <g style={glow}><line x1={x1} y1={y1} x2={x1 + W} y2={y1 + Math.max(H, W * 0.6)} stroke={color} strokeWidth={12} style={dash} /><line x1={x1 + W} y1={y1} x2={x1} y2={y1 + Math.max(H, W * 0.6)} stroke={color} strokeWidth={12} style={dash} /></g>;
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, opacity: e.opacity, overflow: "visible" }}>
      {shape}
    </svg>
  );
};

export const ThumbLayers: React.FC<ThumbLayersProps> = ({ spec, slots }) => {
  const f = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const t = interpolate(f, [0, Math.max(1, durationInFrames - 1)], [0, 1], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const c = spec.camera;
  const scale = c.fromScale + (c.toScale - c.fromScale) * t;
  const fx = c.fromX + (c.toX - c.fromX) * t;
  const fy = c.fromY + (c.toY - c.fromY) * t;
  const drift = (t - 0.5) * 170;
  const bd = spec.backdrop ?? "footage";
  const wash = spec.wash;
  const wc = wash ? tok(wash.color, PALETTE.primary) : "";
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* Footage coloured into the film's world: duotone (grey → colour) or tint, under everything. */}
      {wash && (bd === "footage" || bd === "split") ? (
        <>
          {wash.mode === "duotone" ? <AbsoluteFill style={{ backdropFilter: `grayscale(${Math.min(0.85, wash.strength * 1.4)}) contrast(1.1)` }} /> : null}
          <AbsoluteFill style={{ background: wc, mixBlendMode: wash.mode === "duotone" ? "color" : "soft-light", opacity: wash.mode === "duotone" ? Math.min(0.6, wash.strength * 0.9) : wash.strength * 1.2 }} />
        </>
      ) : null}
      {bd === "world" ? <World kind={TREATMENT.world} /> : null}
      {/* The film's second stage: a deep surface in its own hues with a slow sweep — clearly not the colour world. */}
      {bd === "surface" ? (
        <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${30 + Math.sin(f / 70) * 12}% 30%, ${PALETTE.surfaceAlt}, ${PALETTE.surface} 72%)` }}>
          <AbsoluteFill style={{ opacity: 0.5, background: `conic-gradient(from ${f / 3}deg at 70% 60%, transparent 0 25deg, ${PALETTE.accentDeep}55 25deg 60deg, transparent 60deg 360deg)` }} />
          <AbsoluteFill style={{ opacity: 0.16, backgroundImage: "repeating-linear-gradient(90deg, rgba(255,255,255,0.5) 0 1px, transparent 1px 64px)", backgroundPosition: `${f / 2}px 0` }} />
        </AbsoluteFill>
      ) : null}
      {bd === "paper" ? <World kind="paper" /> : null}
      {bd === "split" ? <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: "50%", overflow: "hidden" }}><World kind={TREATMENT.world} /></div> : null}
      <Particles kind={TREATMENT.particles} />
      {(() => {
        const p = interpolate(f, [2, 34], [-30, 130], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
        return <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen", opacity: 0.22, background: `linear-gradient(105deg, transparent ${p - 14}%, ${PALETTE.primarySoft} ${p}%, transparent ${p + 14}%)` }} />;
      })()}
      <AbsoluteFill style={{ transform: `scale(${1 + (scale - 1) * 0.3})`, transformOrigin: `${fx * 100}% ${fy * 100}%` }}>
        <div style={{ position: "absolute", inset: 0, width, height }}>
          {spec.elements.map((el, i) => (
            <Element key={i} el={el} i={i} slots={slots} drift={drift} />
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
