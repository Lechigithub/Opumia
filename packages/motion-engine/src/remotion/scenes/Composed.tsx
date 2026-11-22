import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, PALETTE, TREATMENT, TYPO, type TextStyleName } from "../types";
import { Card3D, Text3D } from "./Three";

/**
 * ComposedScene: the motion system. Draws any SceneSpec the scene designer writes — backdrop (the shot's footage
 * coloured into the film's world, or a procedural colour world), layered photos, cutouts, kinetic narration
 * phrases, type, shapes, textures and real 3D — each with its own entrance, depth and continuous movement, in the
 * film's own treatment (text style, label style, photo style, particles). Nothing on screen is ever still.
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
      half?: "left" | "right" | "top" | "bottom";
      flip?: boolean;
      outlineColor?: string;
    })
  | (Box & { type: "text"; text: string; role: "display" | "headline" | "body" | "label" | "stamp" | "kicker"; size: number; align?: "left" | "center" | "right"; color?: Token; box?: Token; highlightWord?: string })
  | (Box & { type: "phrase"; text: string; size: number; align?: "left" | "center" | "right"; color?: Token; emphasis?: string; wordFrames?: number[] })
  | (Box & { type: "text3d"; text: string; color?: Token; spin?: number })
  | (Box & { type: "card3d"; slot: number; tilt?: number; spin?: number })
  | (Box & { type: "shape"; shape: "underline" | "circle" | "arrow" | "bar" | "line" | "rect" | "bracket" | "cross"; h?: number; color?: Token; x2?: number; y2?: number })
  | { type: "texture"; texture: "paper" | "halftone" | "grid" | "scanlines" | "noise" | "stripes"; opacity?: number; at?: number };

export interface ComposedProps {
  spec: { backdrop?: "footage" | "surface" | "paper" | "split" | "world"; wash?: { color: Token; strength: number; mode: "tint" | "duotone" }; camera: { fromScale: number; toScale: number; fromX: number; toX: number; fromY: number; toY: number }; elements: El[] };
  slots: Record<string, string>;
  accent?: string;
}

const tok = (t: Token | undefined, d: string) =>
  t === "primary" ? PALETTE.gold : t === "primarySoft" ? PALETTE.goldSoft : t === "accent" ? PALETTE.crimson : t === "accentDeep" ? PALETTE.crimsonDeep : t === "surface" ? PALETTE.ink : t === "surfaceAlt" ? PALETTE.steel : t === "paper" ? PALETTE.paper : t === "marker" ? PALETTE.marker : t === "text" ? PALETTE.text : t === "textMuted" ? PALETTE.textMuted : t === "black" ? "#000000" : t === "white" ? "#ffffff" : d;

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
      return { color: "#fff", background: color === "#ffffff" || color === PALETTE.text ? PALETTE.crimson : color, padding: `${size * 0.1}px ${size * 0.28}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone", boxShadow: `0 ${size * 0.1}px ${size * 0.3}px rgba(0,0,0,0.5)` } as React.CSSProperties;
    case "gradient":
      return { backgroundImage: `linear-gradient(180deg, #ffffff 10%, ${color} 55%, ${PALETTE.crimson} 120%)`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 ${size * 0.06}px ${size * 0.12}px rgba(0,0,0,0.75))` } as React.CSSProperties;
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
  const a = PALETTE.gold;
  const b = PALETTE.crimson;
  const base = PALETTE.ink;
  const d = f / 14;
  if (kind === "paper") return <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${40 + Math.sin(d * 0.3) * 6}% 35%, ${PALETTE.paper}, #cfc6b3 95%)` }} />;
  if (kind === "blueprint")
    return (
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 40%, ${PALETTE.steel}, ${base} 85%)` }}>
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
        <AbsoluteFill style={{ backgroundImage: `repeating-linear-gradient(115deg, ${a} 0 90px, ${b} 90px 180px, ${PALETTE.steel} 180px 270px)`, backgroundPosition: `${d * 60}px 0`, opacity: 0.9 }} />
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
        const color = kind === "embers" ? (i % 3 ? PALETTE.crimson : PALETTE.marker) : kind === "bokeh" ? (i % 2 ? PALETTE.gold : PALETTE.crimson) : "#ffffff";
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
    const duo = el.grade === "duotone" ? <div style={{ position: "absolute", inset: 0, background: PALETTE.gold, mixBlendMode: "multiply", opacity: 0.8 }} /> : null;
    const frame = el.frame ?? TREATMENT.photo;
    if (frame === "circle") return wrap(<div style={{ width: w, height: w, borderRadius: "50%", overflow: "hidden", border: `${Math.round(w * 0.025)}px solid ${PALETTE.gold}`, boxShadow: `0 24px 60px rgba(0,0,0,0.6), 0 0 ${40 * TREATMENT.glow}px ${PALETTE.gold}88`, position: "relative" }}><Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", filter, transform: `scale(${inner})` }} />{duo}</div>);
    if (frame === "torn") return wrap(<div style={{ clipPath: TORN, position: "relative", height: h, overflow: "hidden", filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.7))" }}>{img}{duo}</div>, h);
    if (frame === "tv") return wrap(<div style={{ background: "#0b0b0b", padding: w * 0.035, borderRadius: w * 0.03, boxShadow: "0 30px 80px rgba(0,0,0,0.75)", position: "relative" }}><div style={{ position: "relative", height: h, overflow: "hidden", borderRadius: w * 0.012 }}>{img}{duo}<div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0 2px, transparent 2px 4px)", backgroundPosition: `0 ${f % 4}px` }} /></div></div>);
    if (frame === "none") return wrap(<div style={{ position: "relative", height: h, overflow: "hidden", boxShadow: `0 20px 50px rgba(0,0,0,0.6), 0 0 0 ${Math.max(3, w * 0.006)}px ${PALETTE.gold}` }}>{img}{duo}</div>, h);
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
    const glow = gc ? `drop-shadow(0 0 ${Math.round(w * 0.012 * gs)}px ${gc}) drop-shadow(0 0 ${Math.round(w * 0.04 * gs)}px ${gc}cc) ` : TREATMENT.glow > 0.3 ? `drop-shadow(0 0 ${28 * TREATMENT.glow}px ${PALETTE.gold}aa) ` : "";
    const grade = el.look === "punch" ? "contrast(1.22) saturate(1.45) brightness(1.06)" : el.look === "mono" ? "grayscale(1) contrast(1.3) brightness(1.04)" : el.look === "glitch" ? "contrast(1.15) saturate(1.2)" : "none";
    const clip = el.half === "left" ? "inset(0 50% 0 0)" : el.half === "right" ? "inset(0 0 0 50%)" : el.half === "top" ? "inset(0 0 50% 0)" : el.half === "bottom" ? "inset(50% 0 0 0)" : undefined;
    const flip = el.flip ? "scaleX(-1)" : undefined;
    const mask = (extra: React.CSSProperties = {}): React.CSSProperties => ({ position: "absolute", inset: 0, WebkitMaskImage: `url(${staticFile(src)})`, maskImage: `url(${staticFile(src)})`, WebkitMaskSize: "100% 100%", maskSize: "100% 100%", ...(flip ? { transform: flip } : {}), ...extra });
    const tc = hex(el.tint);
    const off = Math.max(2, w * 0.012);
    return wrap(
      <div style={{ position: "relative", filter: `${outline}${glow}${el.shadow === false ? "" : "drop-shadow(0 18px 28px rgba(0,0,0,0.65))"}`.trim() || undefined }}>
        <div style={{ position: "relative", ...(clip ? { clipPath: clip } : {}) }}>
          <Img src={staticFile(src)} style={{ width: "100%", height: "auto", display: "block", filter: grade, ...(flip ? { transform: flip } : {}) }} />
          {tc ? <div style={mask({ background: tc, mixBlendMode: "color", opacity: Math.max(0, Math.min(1, el.tintStrength ?? 0.6)) })} /> : null}
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
        <Text3D text={el.text} color={tok(el.color, PALETTE.gold)} spin={el.spin ?? 18} at={at} w={w} h={h3} />
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
          const c = isE ? PALETTE.crimson : color;
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
    const pad = el.role === "stamp" ? 1.25 : el.box || TREATMENT.headline === "boxed" ? 1.18 : 1;
    const size = Math.min(el.size * height, (w / (longest * em * pad)) * 0.96);
    const color = tok(el.color, PALETTE.text);
    const raw = (display || el.role === "kicker" || el.role === "label") && TYPO.casing === "upper" ? el.text.toUpperCase() : el.text;
    const shown = el.enter === "type" ? raw.slice(0, Math.ceil(raw.length * e.p)) : raw;
    const hw = el.highlightWord?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const content = shown.split(/(\s+)/).map((wd, k) => (hw && wd.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === hw ? <span key={k} style={{ ...(TREATMENT.headline === "gradient" && display ? { WebkitTextFillColor: PALETTE.crimson } : { color: PALETTE.crimson }) }}>{wd}</span> : <span key={k}>{wd}</span>));
    let css: React.CSSProperties;
    if (display && el.role !== "stamp") css = el.box ? { color, background: tok(el.box, PALETTE.ink), padding: `${size * 0.12}px ${size * 0.3}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } as React.CSSProperties : textCss(TREATMENT.headline, color, size);
    else if (el.role === "stamp") css = { color, border: `${Math.max(4, size * 0.07)}px solid ${color}`, padding: `${size * 0.08}px ${size * 0.25}px`, display: "inline-block", textShadow: "0 3px 10px rgba(0,0,0,0.7)" };
    else if (el.role === "label" || el.role === "kicker") {
      const l = TREATMENT.label;
      css =
        l === "tag" ? { color: "#0c0c0c", background: color === PALETTE.text ? PALETTE.gold : color, padding: `${size * 0.16}px ${size * 0.45}px` }
        : l === "pill" ? { color: "#fff", background: `${PALETTE.ink}dd`, border: `2px solid ${color}`, borderRadius: size, padding: `${size * 0.18}px ${size * 0.6}px` }
        : l === "underline" ? { color, borderBottom: `${Math.max(3, size * 0.12)}px solid ${PALETTE.crimson}`, paddingBottom: size * 0.12, textShadow: "0 2px 10px rgba(0,0,0,0.9)" }
        : l === "bracket" ? { color, borderLeft: `${Math.max(4, size * 0.16)}px solid ${PALETTE.crimson}`, paddingLeft: size * 0.4, textShadow: "0 2px 10px rgba(0,0,0,0.9)" }
        : { color, textShadow: "0 2px 12px rgba(0,0,0,0.95), 0 0 2px #000" };
    } else css = el.box ? { color, background: tok(el.box, PALETTE.ink), padding: `${size * 0.12}px ${size * 0.3}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } as React.CSSProperties : { color, textShadow: "0 3px 18px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.9)" };
    return wrap(
      <div style={{ textAlign: el.align ?? "left", lineHeight: display ? (TREATMENT.headline === "boxed" || TREATMENT.headline === "paper_cut" ? 1.45 : 1.0) : 1.2 }}>
        <span style={{ display: "inline", fontFamily: display ? FONT : FONT_BODY, fontWeight: display ? 900 : el.role === "label" || el.role === "kicker" ? 800 : 600, fontSize: size, letterSpacing: display ? TYPO.tracking : el.role === "kicker" ? 4 : 0.5, ...css }}>{content}</span>
      </div>,
    );
  }
  // Shapes.
  const color = tok(el.color, PALETTE.crimson);
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

export const ComposedScene: React.FC<ComposedProps> = ({ spec, slots }) => {
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
  const wc = wash ? tok(wash.color, PALETTE.gold) : "";
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
        <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${30 + Math.sin(f / 70) * 12}% 30%, ${PALETTE.steel}, ${PALETTE.ink} 72%)` }}>
          <AbsoluteFill style={{ opacity: 0.5, background: `conic-gradient(from ${f / 3}deg at 70% 60%, transparent 0 25deg, ${PALETTE.crimsonDeep}55 25deg 60deg, transparent 60deg 360deg)` }} />
          <AbsoluteFill style={{ opacity: 0.16, backgroundImage: "repeating-linear-gradient(90deg, rgba(255,255,255,0.5) 0 1px, transparent 1px 64px)", backgroundPosition: `${f / 2}px 0` }} />
        </AbsoluteFill>
      ) : null}
      {bd === "paper" ? <World kind="paper" /> : null}
      {bd === "split" ? <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: "50%", overflow: "hidden" }}><World kind={TREATMENT.world} /></div> : null}
      <Particles kind={TREATMENT.particles} />
      {(() => {
        const p = interpolate(f, [2, 34], [-30, 130], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
        return <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen", opacity: 0.22, background: `linear-gradient(105deg, transparent ${p - 14}%, ${PALETTE.goldSoft} ${p}%, transparent ${p + 14}%)` }} />;
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
