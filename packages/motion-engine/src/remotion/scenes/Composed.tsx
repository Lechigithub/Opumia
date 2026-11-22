import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FILM } from "@film";
import { PALETTE } from "../types";
import { Card3D } from "./Three";

/**
 * ComposedScene: a film scene as its scene designer wrote it, drawn from the film's OWN kit (build list 3, L2/L3).
 * The engine draws only real pictures (photos, cut-outs, 3D picture cards) and places the kit's components; every word
 * on screen, every card and the stage behind shots without footage belong to the kit. There are no shared text styles,
 * colour worlds, particles or decorations.
 */
type Enter = "fade" | "slide_left" | "slide_right" | "slide_up" | "slide_down" | "pop" | "stamp" | "type" | "draw" | "wipe" | "zoom";
type Token = "primary" | "primarySoft" | "accent" | "accentDeep" | "surface" | "surfaceAlt" | "paper" | "marker" | "text" | "textMuted";
interface Box { x: number; y: number; w: number; rot?: number; z?: number; at?: number; enter?: Enter }
type El =
  | (Box & { type: "photo"; slot: number; grade?: "natural" | "mono"; h?: number })
  | (Box & {
      type: "cutout";
      slot: number;
      shadow?: boolean;
      matchColor?: string;
      matchStrength?: number;
      lightAngle?: number;
      lightColor?: string;
      lightStrength?: number;
      brightness?: number;
      contactShadow?: number;
      soften?: number;
      turnX?: number;
      turnY?: number;
      flip?: boolean;
    })
  | (Box & { type: "card3d"; slot: number; tilt?: number; spin?: number })
  | (Box & { type: "component"; name: string; props?: Record<string, unknown>; h?: number });

export interface ComposedProps {
  spec: { backdrop?: "footage" | "stage"; wash?: { color: Token; strength: number; mode: "tint" | "duotone" }; camera: { fromScale: number; toScale: number; fromX: number; toX: number; fromY: number; toY: number }; elements: El[] };
  slots: Record<string, string>;
  accent?: string;
}

const tok = (t: Token | undefined, d: string) =>
  t === "primary" ? PALETTE.primary : t === "primarySoft" ? PALETTE.primarySoft : t === "accent" ? PALETTE.accent : t === "accentDeep" ? PALETTE.accentDeep : t === "surface" ? PALETTE.surface : t === "surfaceAlt" ? PALETTE.surfaceAlt : t === "paper" ? PALETTE.paper : t === "marker" ? PALETTE.marker : t === "text" ? PALETTE.text : t === "textMuted" ? PALETTE.textMuted : d;

/** A kit role's component (FILM.roles), or null when the kit has none. */
export const roleComponent = (role: string): React.FC<Record<string, unknown>> | null => {
  const name = FILM.roles?.[role];
  return (name && FILM.components[name]) || null;
};

/** The kit's stage: the full-frame backdrop of shots without footage. */
export const KitStage: React.FC<Record<string, unknown>> = (p) => {
  const { width, height } = useVideoConfig();
  const S = roleComponent("stage");
  return <AbsoluteFill style={{ background: PALETTE.surface }}>{S ? <S {...p} slots={{}} boxW={width} boxH={height} /> : null}</AbsoluteFill>;
};

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
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateX(${(1 - soft) * -160}px)`, clip: undefined };
    case "slide_right":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateX(${(1 - soft) * 160}px)`, clip: undefined };
    case "slide_up":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateY(${(1 - soft) * 110}px)`, clip: undefined };
    case "slide_down":
      return { opacity: Math.min(1, soft * 1.4) * vis, transform: `translateY(${(1 - soft) * -110}px)`, clip: undefined };
    case "pop":
      return { opacity: Math.min(1, snappy * 2) * vis, transform: `scale(${0.55 + 0.45 * snappy})`, clip: undefined };
    case "stamp":
      return { opacity: Math.min(1, snappy * 3) * vis, transform: `scale(${1.8 - 0.8 * snappy}) rotate(${(1 - snappy) * -7}deg)`, clip: undefined };
    case "zoom":
      return { opacity: lin * vis, transform: `scale(${1.22 - 0.22 * lin})`, clip: undefined };
    case "wipe":
    case "draw":
      return { opacity: vis, transform: "", clip: `inset(0 ${(1 - lin) * 100}% 0 0)` };
    default:
      return { opacity: lin * vis, transform: "", clip: undefined };
  }
}

const Element: React.FC<{ el: El; i: number; slots: Record<string, string>; drift: number }> = ({ el, i, slots, drift }) => {
  const { width, height, fps } = useVideoConfig();
  const f = useCurrentFrame();
  const at = el.at ?? 0;
  // a kit component animates its own arrival (its frame 0 is `at`); pictures get the engine's entrance
  const e = useEnter(at, el.type === "component" ? "fade" : (el.enter ?? "fade"));
  const z = el.z ?? 0.5;
  const par = (z - 0.5) * drift;
  const left = Math.min(el.x * width + par, width * 0.97 - el.w * width);
  const top = el.y * height + par * 0.35;
  const w = el.w * width;

  if (el.type === "component") {
    const C = FILM.components[el.name];
    if (!C) return null;
    const boxH = el.h ? el.h * height : undefined;
    return (
      <div style={{ position: "absolute", left: el.x * width, top: el.y * height, width: w, ...(boxH ? { height: boxH } : {}), transform: el.rot ? `rotate(${el.rot}deg)` : undefined }}>
        <Sequence from={Math.round(at * fps)} layout="none">
          <C {...(el.props ?? {})} slots={slots} boxW={w} boxH={boxH ?? null} />
        </Sequence>
      </div>
    );
  }
  // Pictures float a little (nearer ones more), so a still is never frozen.
  const fl = 4 + z * 10;
  const floatX = Math.sin(f / (34 + i * 5) + i * 1.7) * fl;
  const floatY = Math.cos(f / (27 + i * 4) + i * 0.9) * fl * 0.8;
  const rot = (el.rot ?? 0) + Math.sin(f / (48 + i * 6) + i) * 0.6;
  const wrap = (child: React.ReactNode, h?: number) => (
    <div style={{ position: "absolute", left: left + floatX, top: top + floatY, width: w, ...(h ? { height: h } : {}), transform: `rotate(${rot}deg) ${e.transform}`, transformOrigin: "50% 50%", opacity: e.opacity, ...(e.clip ? { clipPath: e.clip } : {}) }}>{child}</div>
  );
  const src = slots[String(el.slot)];
  if (!src) return null;
  if (el.type === "photo") {
    const h = el.h ? el.h * height : undefined;
    const filter = el.grade === "mono" ? "grayscale(1) contrast(1.12)" : undefined;
    const inner = 1.04 + 0.06 * interpolate(f, [0, fps * 6], [0, 1], { extrapolateRight: "clamp" });
    return wrap(
      <div style={{ position: "relative", height: h, overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.55)" }}>
        <Img src={staticFile(src)} style={{ width: "100%", height: h ? "100%" : "auto", objectFit: "cover", display: "block", filter, transform: `scale(${inner})` }} />
      </div>,
      h,
    );
  }
  if (el.type === "cutout") {
    const hex = (c?: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);
    const bright = el.brightness ? `brightness(${Math.max(0.6, Math.min(1.5, el.brightness))}) ` : "";
    const soft = el.soften ? `blur(${Math.max(0, Math.min(3, el.soften)).toFixed(2)}px)` : "";
    const flip = el.flip ? "scaleX(-1)" : undefined;
    const mask = (extra: React.CSSProperties = {}): React.CSSProperties => ({ position: "absolute", inset: 0, WebkitMaskImage: `url(${staticFile(src)})`, maskImage: `url(${staticFile(src)})`, WebkitMaskSize: "100% 100%", maskSize: "100% 100%", ...(flip ? { transform: flip } : {}), ...extra });
    const turn = el.turnX || el.turnY ? `perspective(${Math.round(w * 2.2)}px) rotateY(${Math.max(-35, Math.min(35, el.turnY ?? 0))}deg) rotateX(${Math.max(-25, Math.min(25, el.turnX ?? 0))}deg)` : undefined;
    return wrap(
      <div style={{ position: "relative", ...(turn ? { transform: turn } : {}), filter: el.shadow === false ? undefined : "drop-shadow(0 18px 28px rgba(0,0,0,0.6))" }}>
        {el.contactShadow ? <div style={mask({ background: "#000", opacity: Math.max(0, Math.min(1, el.contactShadow)), top: "auto", height: "100%", transform: `translateY(48%) scaleY(0.12) ${flip ?? ""}`, filter: `blur(${Math.round(w * 0.02)}px)` })} /> : null}
        <div style={{ position: "relative" }}>
          <Img src={staticFile(src)} style={{ width: "100%", height: "auto", display: "block", filter: `${bright}${soft}`.trim() || undefined, ...(flip ? { transform: flip } : {}) }} />
          {hex(el.matchColor) ? <div style={mask({ background: `radial-gradient(ellipse at 50% 30%, transparent 20%, ${hex(el.matchColor)} 100%)`, mixBlendMode: "soft-light", opacity: Math.max(0, Math.min(1, el.matchStrength ?? 0.55)) })} /> : null}
          {el.lightAngle !== undefined ? <div style={mask({ background: `linear-gradient(${Math.round(el.lightAngle)}deg, ${hex(el.lightColor) ?? "#fff4e0"} 0%, transparent 55%, rgba(0,0,0,0.55) 100%)`, mixBlendMode: "soft-light", opacity: Math.max(0, Math.min(1, el.lightStrength ?? 0.45)) })} /> : null}
        </div>
      </div>,
    );
  }
  const h3 = w * 0.75;
  return (
    <div style={{ position: "absolute", left, top, width: w, height: h3, opacity: e.opacity }}>
      <Card3D src={src} tilt={el.tilt ?? -14} spin={el.spin ?? 22} at={at} w={w} h={h3} />
    </div>
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
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* Footage coloured toward the film's palette (the colourist's choice), under everything. */}
      {wash && bd === "footage" ? (
        <>
          {wash.mode === "duotone" ? <AbsoluteFill style={{ backdropFilter: `grayscale(${Math.min(0.85, wash.strength * 1.4)}) contrast(1.1)` }} /> : null}
          <AbsoluteFill style={{ background: tok(wash.color, PALETTE.primary), mixBlendMode: wash.mode === "duotone" ? "color" : "soft-light", opacity: wash.mode === "duotone" ? Math.min(0.6, wash.strength * 0.9) : wash.strength * 1.2 }} />
        </>
      ) : null}
      {bd === "stage" ? <KitStage /> : null}
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
