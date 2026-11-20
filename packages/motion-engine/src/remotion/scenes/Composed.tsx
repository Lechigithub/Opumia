import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, FONT_BODY, PALETTE, TYPO } from "../types";

/**
 * ComposedScene: draws any SceneSpec written by the scene designer — no fixed layout. Backdrop, layered photos,
 * cutouts, type, shapes and textures, each with its own entrance and depth, under one slow 2.5D camera move.
 */
type Enter = "fade" | "slide_left" | "slide_right" | "slide_up" | "slide_down" | "pop" | "stamp" | "type" | "draw" | "wipe" | "zoom";
type Token = "primary" | "primarySoft" | "accent" | "accentDeep" | "surface" | "surfaceAlt" | "paper" | "marker" | "text" | "textMuted" | "black" | "white";
interface Box { x: number; y: number; w: number; rot?: number; z?: number; at?: number; enter?: Enter }
type El =
  | (Box & { type: "photo"; slot: number; frame?: "none" | "print" | "torn" | "circle" | "tv" | "polaroid"; grade?: "natural" | "mono" | "duotone"; h?: number })
  | (Box & { type: "cutout"; slot: number; shadow?: boolean })
  | (Box & { type: "text"; text: string; role: "display" | "headline" | "body" | "label" | "stamp" | "kicker"; size: number; align?: "left" | "center" | "right"; color?: Token; box?: Token; highlightWord?: string })
  | (Box & { type: "shape"; shape: "underline" | "circle" | "arrow" | "bar" | "line" | "rect" | "bracket" | "cross"; h?: number; color?: Token; x2?: number; y2?: number })
  | { type: "texture"; texture: "paper" | "halftone" | "grid" | "scanlines" | "noise" | "stripes"; opacity?: number; at?: number };

export interface ComposedProps {
  spec: { backdrop?: "footage" | "surface" | "paper" | "split"; camera: { fromScale: number; toScale: number; fromX: number; toX: number; fromY: number; toY: number }; elements: El[] };
  slots: Record<string, string>;
  accent?: string;
}

const tok = (t: Token | undefined, d: string) =>
  t === "primary" ? PALETTE.gold : t === "primarySoft" ? PALETTE.goldSoft : t === "accent" ? PALETTE.crimson : t === "accentDeep" ? PALETTE.crimsonDeep : t === "surface" ? PALETTE.ink : t === "surfaceAlt" ? PALETTE.steel : t === "paper" ? PALETTE.paper : t === "marker" ? PALETTE.marker : t === "text" ? PALETTE.text : t === "textMuted" ? PALETTE.textMuted : t === "black" ? "#000000" : t === "white" ? "#ffffff" : d;

const TORN = "polygon(0% 3%, 7% 0%, 15% 2%, 24% 0%, 33% 3%, 41% 1%, 52% 3%, 60% 0%, 71% 2%, 80% 0%, 89% 3%, 100% 1%, 98% 12%, 100% 25%, 97% 38%, 100% 50%, 98% 63%, 100% 76%, 97% 88%, 100% 99%, 90% 97%, 80% 100%, 69% 97%, 58% 100%, 47% 98%, 36% 100%, 25% 97%, 14% 100%, 5% 98%, 0% 100%, 2% 87%, 0% 74%, 3% 61%, 0% 49%, 2% 36%, 0% 24%, 3% 12%)";

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
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateX(${(1 - soft) * -140}px)`, p: soft, clip: undefined };
    case "slide_right":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateX(${(1 - soft) * 140}px)`, p: soft, clip: undefined };
    case "slide_up":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateY(${(1 - soft) * 90}px)`, p: soft, clip: undefined };
    case "slide_down":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateY(${(1 - soft) * -90}px)`, p: soft, clip: undefined };
    case "pop":
      return { opacity: Math.min(1, snappy * 2) * vis, transform: `scale(${0.6 + 0.4 * snappy})`, p: snappy, clip: undefined };
    case "stamp":
      return { opacity: Math.min(1, snappy * 3) * vis, transform: `scale(${1.7 - 0.7 * snappy}) rotate(${(1 - snappy) * -6}deg)`, p: snappy, clip: undefined };
    case "zoom":
      return { opacity: lin * vis, transform: `scale(${1.18 - 0.18 * lin})`, p: lin, clip: undefined };
    case "wipe":
    case "draw":
      return { opacity: vis, transform: "", p: lin, clip: `inset(0 ${(1 - lin) * 100}% 0 0)` };
    case "type":
      return { opacity: vis, transform: "", p: lin, clip: undefined };
    default:
      return { opacity: lin * vis, transform: "", p: lin, clip: undefined };
  }
}

const Element: React.FC<{ el: El; slots: Record<string, string>; drift: number }> = ({ el, slots, drift }) => {
  const { width, height } = useVideoConfig();
  const f = useCurrentFrame();
  const at = "at" in el ? (el.at ?? 0) : 0;
  const e = useEnter(at, el.type === "texture" ? "fade" : (el.enter ?? "fade"));
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
  const par = (z - 0.5) * drift; // near layers travel further with the camera
  const left = Math.min(el.x * width + par, width * 0.97 - el.w * width);
  const top = el.y * height + par * 0.35;
  const w = el.w * width;
  const rot = el.rot ?? 0;
  const wrap = (child: React.ReactNode, h?: number) => (
    <div style={{ position: "absolute", left, top, width: w, ...(h ? { height: h } : {}), transform: `rotate(${rot}deg) ${e.transform}`, transformOrigin: "50% 50%", opacity: e.opacity, ...(e.clip ? { clipPath: e.clip } : {}) }}>{child}</div>
  );

  if (el.type === "photo") {
    const src = slots[String(el.slot)];
    if (!src) return null;
    const h = el.h ? el.h * height : undefined;
    const filter = el.grade === "mono" ? "grayscale(1) contrast(1.18) brightness(0.95)" : el.grade === "duotone" ? "grayscale(1) contrast(1.25)" : "contrast(1.06) saturate(0.9)";
    const img = <Img src={staticFile(src)} style={{ width: "100%", height: h ? "100%" : "auto", objectFit: "cover", display: "block", filter }} />;
    const duo = el.grade === "duotone" ? <div style={{ position: "absolute", inset: 0, background: PALETTE.crimson, mixBlendMode: "multiply", opacity: 0.75 }} /> : null;
    const frame = el.frame ?? "print";
    if (frame === "circle") return wrap(<div style={{ width: w, height: w, borderRadius: "50%", overflow: "hidden", border: `${Math.round(w * 0.025)}px solid ${PALETTE.text}`, boxShadow: "0 24px 60px rgba(0,0,0,0.6)", position: "relative" }}><Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", filter }} />{duo}</div>);
    if (frame === "torn") return wrap(<div style={{ clipPath: TORN, position: "relative", height: h, filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.7))" }}>{img}{duo}</div>, h);
    if (frame === "tv") return wrap(<div style={{ background: "#0b0b0b", padding: w * 0.035, borderRadius: w * 0.03, boxShadow: "0 30px 80px rgba(0,0,0,0.75)", position: "relative" }}><div style={{ position: "relative", height: h, overflow: "hidden", borderRadius: w * 0.012 }}>{img}{duo}<div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0 2px, transparent 2px 4px)" }} /></div></div>);
    if (frame === "none") return wrap(<div style={{ position: "relative", height: h, overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.6)" }}>{img}{duo}</div>, h);
    const pad = Math.round(w * 0.03);
    return wrap(<div style={{ background: "#f4f1ea", padding: pad, paddingBottom: frame === "polaroid" ? pad * 4 : pad, boxShadow: "0 26px 60px rgba(0,0,0,0.65)", position: "relative" }}><div style={{ position: "relative", height: h ? h - pad * 2 : undefined, overflow: "hidden" }}>{img}{duo}</div></div>);
  }
  if (el.type === "cutout") {
    const src = slots[String(el.slot)];
    if (!src) return null;
    return wrap(<Img src={staticFile(src)} style={{ width: "100%", height: "auto", display: "block", filter: el.shadow === false ? undefined : "drop-shadow(0 18px 28px rgba(0,0,0,0.65))" }} />);
  }
  if (el.type === "text") {
    const display = el.role === "display" || el.role === "headline" || el.role === "stamp";
    // Fit: the longest word must fit the element width (heavy display caps ≈ 0.72 em per character).
    const longest = Math.max(1, ...el.text.split(/\s+/).map((x) => x.length));
    const em = display ? (TYPO.casing === "upper" ? 0.74 : 0.62) : 0.56;
    const stampPad = el.role === "stamp" ? 1.25 : el.box ? 1.15 : 1;
    const size = Math.min(el.size * height, (w / (longest * em * stampPad)) * 0.96);
    const color = tok(el.color, PALETTE.text);
    const raw = (display || el.role === "kicker") && TYPO.casing === "upper" ? el.text.toUpperCase() : el.text;
    const shown = el.enter === "type" ? raw.slice(0, Math.ceil(raw.length * e.p)) : raw;
    const hw = el.highlightWord?.toLowerCase();
    const words = shown.split(/(\s+)/);
    const box = el.box ? tok(el.box, PALETTE.ink) : undefined;
    const content = words.map((wd, i) => (hw && wd.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === hw.replace(/[^\p{L}\p{N}]/gu, "") ? <span key={i} style={{ color: PALETTE.crimson }}>{wd}</span> : <span key={i}>{wd}</span>));
    return wrap(
      <div style={{ textAlign: el.align ?? "left" }}>
        <span
          style={{
            display: "inline",
            fontFamily: display ? FONT : FONT_BODY,
            fontWeight: display ? 900 : el.role === "label" || el.role === "kicker" ? 800 : 600,
            fontSize: size,
            lineHeight: display ? 0.98 : 1.18,
            letterSpacing: display ? TYPO.tracking : el.role === "kicker" ? 4 : 0.5,
            color,
            ...(box ? { background: box, padding: `${size * 0.12}px ${size * 0.3}px`, boxDecorationBreak: "clone" as const, WebkitBoxDecorationBreak: "clone" as const } : { textShadow: "0 4px 24px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.9)" }),
            ...(el.role === "stamp" ? { border: `${Math.max(4, size * 0.07)}px solid ${color}`, padding: `${size * 0.08}px ${size * 0.25}px`, display: "inline-block" } : {}),
          }}
        >
          {content}
        </span>
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
  const glow = { filter: `drop-shadow(0 0 10px ${color}aa)` };
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
        <line x1={x1} y1={y1} x2={hx} y2={hy} stroke={color} strokeWidth={8} strokeLinecap="round" />
        {el.shape === "arrow" && e.p > 0.85 ? <polygon points={`${hx},${hy} ${hx - 34 * Math.cos(a - 0.45)},${hy - 34 * Math.sin(a - 0.45)} ${hx - 34 * Math.cos(a + 0.45)},${hy - 34 * Math.sin(a + 0.45)}`} fill={color} /> : null}
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
  const drift = (t - 0.5) * 60;
  const bd = spec.backdrop ?? "footage";
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {bd === "surface" ? <AbsoluteFill style={{ background: `radial-gradient(ellipse at 35% 30%, ${PALETTE.steel}, ${PALETTE.ink} 70%)` }} /> : null}
      {bd === "paper" ? <AbsoluteFill style={{ background: `radial-gradient(ellipse at 40% 35%, ${PALETTE.paper}, #cfc6b3 95%)` }} /> : null}
      {bd === "split" ? <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: "50%", background: `linear-gradient(90deg, ${PALETTE.ink}ee, ${PALETTE.ink})` }} /> : null}
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${fx * 100}% ${fy * 100}%` }}>
        <div style={{ position: "absolute", inset: 0, width, height }}>
          {spec.elements.map((el, i) => (
            <Element key={i} el={el} slots={slots} drift={drift} />
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
