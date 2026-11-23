import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FILM } from "@film";
import { PALETTE, pick, vary } from "../types";
import { Card3D, Prop3D, Text3D } from "./Three";
import { Finish, gradeFilter, World, type FinishSpec, type WorldSpec , RetouchFilter, retouchCss, type RetouchSpec } from "./Worlds";

/**
 * ComposedScene: a film scene as its scene designer wrote it, drawn from the film's OWN kit (build list 3, L2/L3).
 * The engine draws only real pictures (photos, cut-outs, 3D picture cards) and places the kit's components; every word
 * on screen, every card and the stage behind shots without footage belong to the kit. There are no shared text styles,
 * colour worlds, particles or decorations.
 */
type Enter = "fade" | "slide_left" | "slide_right" | "slide_up" | "slide_down" | "pop" | "stamp" | "type" | "draw" | "wipe" | "zoom" | "settle" | "glitch" | "swoop";
type Token = "primary" | "primarySoft" | "accent" | "accentDeep" | "surface" | "surfaceAlt" | "paper" | "marker" | "text" | "textMuted";
interface Box { x: number; y: number; w: number; rot?: number; z?: number; at?: number; enter?: Enter; exit?: "none" | "slide" | "erode"; track?: { x: number; y: number; path?: Array<{ t: number; x: number; y: number }> } }
type El =
  | (Box & { type: "photo"; slot: number; grade?: string; h?: number; blend?: "normal" | "screen"; frame?: "none" | "polaroid" | "neon" | "torn" | "perspective" })
  | (Box & {
      type: "cutout";
      silhouette?: boolean;
      retouch?: RetouchSpec;
      outline?: boolean;
      glow?: "primary" | "accent" | "white";
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
  | (Box & { type: "prop3d"; query: string; model?: string; spin?: number; tilt?: number; h?: number })
  | (Box & { type: "text3d"; text: string; spin?: number; serif?: boolean; color?: "primary" | "accent" | "white" | "paper"; h?: number; material?: "paint" | "chrome" | "gold" })
  | (Box & { type: "component"; name: string; props?: Record<string, unknown>; h?: number });

export interface ComposedProps {
  spec: { backdrop?: "footage" | "stage" | "world"; world?: WorldSpec; finish?: FinishSpec; wash?: { color: Token; strength: number; mode: "tint" | "duotone" }; camera: { fromScale: number; toScale: number; fromX: number; toX: number; fromY: number; toY: number }; elements: El[] };
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
    // craft inventory: blurred and tilted, settling into place
    case "settle":
      return { opacity: Math.min(1, soft * 1.6) * vis, transform: `rotate(${(1 - soft) * -8}deg) scale(${1.12 - 0.12 * soft})`, clip: undefined, filter: soft < 0.98 ? `blur(${((1 - soft) * 14).toFixed(1)}px)` : undefined };
    // a glitch reveal: sliced bands jump, then lock
    case "glitch":
      return { opacity: vis * (t < 6 && t % 2 ? 0.55 : 1), transform: t < 8 ? `translateX(${Math.round(Math.sin(t * 3.1) * 18)}px)` : "", clip: t < 8 ? `inset(${(t * 13) % 60}% 0 ${(t * 7) % 30}% 0)` : undefined, filter: t < 8 ? "saturate(2) hue-rotate(25deg)" : undefined };
    // a print swooping in from the side at depth (floating polaroids)
    case "swoop":
      return { opacity: Math.min(1, soft * 1.5) * vis, transform: `translate(${(1 - soft) * 420}px, ${(1 - soft) * -140}px) rotate(${(1 - soft) * 24}deg) scale(${0.7 + 0.3 * soft})`, clip: undefined };
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
  if (el.type === "prop3d") {
    if (!el.model) return null;
    const hp = el.h ? el.h * height : w * 0.85;
    return (
      <div style={{ position: "absolute", left, top, width: w, height: hp, opacity: e.opacity }}>
        <Prop3D src={el.model} spin={el.spin ?? 30} tilt={el.tilt ?? 22} at={at} w={w} h={hp} />
      </div>
    );
  }
  if (el.type === "text3d") {
    // craft inventory: 3D type in films (it was reachable only in thumbnails)
    const h3 = el.h ? el.h * height : w * 0.32;
    const col = el.color === "accent" ? PALETTE.accent : el.color === "primary" ? PALETTE.primary : el.color === "paper" ? "#f3ead8" : "#ffffff";
    return (
      <div style={{ position: "absolute", left, top, width: w, height: h3, opacity: e.opacity }}>
        <Text3D text={el.text} color={el.material === "gold" ? "#d4a73a" : el.material === "chrome" ? "#d9dde3" : col} spin={el.spin ?? 18} at={at} w={w} h={h3} {...(el.serif ? { serif: true } : {})} {...(el.material && el.material !== "paint" ? { metal: true } : {})} />
      </div>
    );
  }
  // Pictures float a little (nearer ones more), so a still is never frozen.
  const fl = 4 + z * 10;
  const floatX = Math.sin(f / (34 + i * 5) + i * 1.7) * fl;
  const floatY = Math.cos(f / (27 + i * 4) + i * 0.9) * fl * 0.8;
  const rot = (el.rot ?? 0) + Math.sin(f / (48 + i * 6) + i) * 0.6;
  const wrap = (child: React.ReactNode, h?: number) => (
    <div style={{ position: "absolute", left: left + floatX, top: top + floatY, width: w, ...(h ? { height: h } : {}), transform: `rotate(${rot}deg) ${e.transform}`, transformOrigin: "50% 50%", opacity: e.opacity, ...(e.clip ? { clipPath: e.clip } : {}), ...((e as { filter?: string }).filter ? { filter: (e as { filter?: string }).filter } : {}) }}>{child}</div>
  );
  const src = slots[String(el.slot)];
  if (!src) return null;
  if (el.type === "photo") {
    const h = el.h ? el.h * height : undefined;
    // the film's own version of this frame, when its kit draws one
    const OwnFrame = el.frame && el.frame !== "none" ? FILM.styles?.[el.frame] : undefined;
    if (OwnFrame) return wrap(<OwnFrame src={src} width={w} height={h ?? w * 0.62}><Img src={staticFile(src)} style={{ width: "100%", height: h ? "100%" : "auto", objectFit: "cover", display: "block", filter: gradeFilter(el.grade) }} /></OwnFrame>, h);
    const filter = gradeFilter(el.grade);
    const inner = 1.04 + 0.06 * interpolate(f, [0, fps * 6], [0, 1], { extrapolateRight: "clamp" });
    return wrap(
      // craft inventory: picture frames — a polaroid print, a neon frame, ripped paper edges, a screen tilted in perspective
      <div style={{ position: "relative", ...(el.frame === "perspective" ? { transform: `perspective(${Math.round(w * 2.4)}px) rotateY(${-18 + 6 * interpolate(f, [0, fps * 6], [0, 1], { extrapolateRight: "clamp" })}deg) rotateX(6deg)` } : {}) }}>
        <div style={{ position: "relative", height: h, overflow: "hidden",
          ...(el.blend === "screen" ? { mixBlendMode: "screen", opacity: 0.7 } : { boxShadow: "0 20px 50px rgba(0,0,0,0.55)" }),
          ...(el.frame === "polaroid" ? { background: pick("polaroid.paper", ["#f6f3ec", "#ffffff", "#efe6d2"]), padding: `${w * vary("polaroid.border", 0.025, 0.06)}px ${w * vary("polaroid.border", 0.025, 0.06)}px ${w * vary("polaroid.foot", 0.1, 0.2)}px`, boxShadow: "0 18px 40px rgba(0,0,0,0.5)" } : {}),
          ...(el.frame === "neon" ? { outline: `${Math.max(2, w * vary("neon.width", 0.004, 0.013))}px solid ${pick("neon.colour", [PALETTE.accent, PALETTE.primary, "#ffffff"])}`, outlineOffset: w * vary("neon.offset", 0, 0.025), borderRadius: w * vary("neon.round", 0, 0.04), boxShadow: `0 0 ${w * vary("neon.glow", 0.02, 0.06)}px ${PALETTE.accent}, 0 0 ${w * 0.09}px ${PALETTE.accent}` } : {}),
          ...(el.frame === "torn" ? { clipPath: tornPath(i) } : {}) }}>
          <Img src={staticFile(src)} style={{ width: "100%", height: h ? "100%" : "auto", objectFit: "cover", display: "block", filter, transform: `scale(${inner})` }} />
        </div>
      </div>,
      h,
    );
  }
  const rid = `rt${i}${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (el.type === "cutout") {
    const hex = (c?: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);
    const bright = el.brightness ? `brightness(${Math.max(0.6, Math.min(1.5, el.brightness))}) ` : "";
    const soft = el.soften ? `blur(${Math.max(0, Math.min(3, el.soften)).toFixed(2)}px)` : "";
    const flip = el.flip ? "scaleX(-1)" : undefined;
    const mask = (extra: React.CSSProperties = {}): React.CSSProperties => ({ position: "absolute", inset: 0, WebkitMaskImage: `url(${staticFile(src)})`, maskImage: `url(${staticFile(src)})`, WebkitMaskSize: "100% 100%", maskSize: "100% 100%", ...(flip ? { transform: flip } : {}), ...extra });
    const turn = el.turnX || el.turnY ? `perspective(${Math.round(w * 2.2)}px) rotateY(${Math.max(-35, Math.min(35, el.turnY ?? 0))}deg) rotateX(${Math.max(-25, Math.min(25, el.turnX ?? 0))}deg)` : undefined;
    return wrap(
      // craft inventory: white outline (four tight drop-shadows) and a coloured glow around the cut-out
      <div style={{ position: "relative", ...(turn ? { transform: turn } : {}), filter: [el.outline ? "drop-shadow(3px 0 0 #fff) drop-shadow(-3px 0 0 #fff) drop-shadow(0 3px 0 #fff) drop-shadow(0 -3px 0 #fff)" : "", el.glow ? `drop-shadow(0 0 ${Math.round(w * 0.03)}px ${el.glow === "accent" ? PALETTE.accent : el.glow === "primary" ? PALETTE.primary : "#ffffff"})` : "", el.shadow === false ? "" : "drop-shadow(0 18px 28px rgba(0,0,0,0.6))"].filter(Boolean).join(" ") || undefined }}>
        {el.contactShadow ? <div style={mask({ background: "#000", opacity: Math.max(0, Math.min(1, el.contactShadow)), top: "auto", height: "100%", transform: `translateY(48%) scaleY(0.12) ${flip ?? ""}`, filter: `blur(${Math.round(w * 0.02)}px)` })} /> : null}
        {el.retouch ? <RetouchFilter id={rid} r={el.retouch} /> : null}
        <div style={{ position: "relative" }}>
          <Img src={staticFile(src)} style={{ width: "100%", height: "auto", display: "block", filter: `${el.silhouette ? "brightness(0) " : ""}${el.retouch ? `url(#${rid}) ${retouchCss(el.retouch)} ` : ""}${bright}${soft}`.trim() || undefined, ...(flip ? { transform: flip } : {}) }} />
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

/** Ripped paper edges: a jagged polygon, stable per element. */
const tornPath = (seed: number) => {
  const r = (k: number) => { const x = Math.sin(k * 91.7 + (seed + vary("torn.seed", 0, 999)) * 13.3) * 43758.5; return (x - Math.floor(x)) * vary("torn.depth", 0.6, 1.4); };
  const pts: string[] = [];
  for (let k = 0; k <= 20; k++) pts.push(`${(k * 5).toFixed(1)}% ${(r(k) * 4).toFixed(1)}%`);
  for (let k = 0; k <= 14; k++) pts.push(`${(100 - r(k + 40) * 3).toFixed(1)}% ${(k * 7.14).toFixed(1)}%`);
  for (let k = 20; k >= 0; k--) pts.push(`${(k * 5).toFixed(1)}% ${(100 - r(k + 80) * 4).toFixed(1)}%`);
  for (let k = 14; k >= 0; k--) pts.push(`${(r(k + 120) * 3).toFixed(1)}% ${(k * 7.14).toFixed(1)}%`);
  return `polygon(${pts.join(", ")})`;
};

/** Craft inventory: procedural weather and light over a shot — snow, confetti, bokeh (deterministic, drawn). */
const AirLayer: React.FC<{ kind: "snow" | "confetti" | "bokeh" }> = ({ kind }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const r = (k: number, s: number) => { const x = Math.sin(k * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
  const n = Math.round((kind === "bokeh" ? 14 : 70) * vary(`air.${kind}`, 0.6, 1.4));
  const cols = [PALETTE.accent, PALETTE.primary, "#ffffff", "#f2c14e"];
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: kind === "bokeh" ? "screen" : "normal" }}>
      {Array.from({ length: n }, (_, k) => {
        if (kind === "bokeh") {
          const d = width * (0.05 + r(k, 1) * 0.12);
          return <div key={k} style={{ position: "absolute", left: r(k, 2) * width + Math.sin(f / 60 + k) * 20, top: r(k, 3) * height + Math.cos(f / 70 + k) * 20, width: d, height: d, borderRadius: "50%", background: `radial-gradient(circle, ${k % 3 ? "#ffd59a" : PALETTE.accent}aa 0%, transparent 70%)`, filter: "blur(4px)", opacity: 0.55 }} />;
        }
        const sp = kind === "snow" ? 0.6 + r(k, 4) * 0.8 : 1.2 + r(k, 4);
        const y = ((f * sp * 2.2 + r(k, 5) * height * 1.2) % (height * 1.2)) - height * 0.1;
        const x = r(k, 6) * width + Math.sin(f / 22 + k) * (kind === "snow" ? 18 : 30);
        const s = kind === "snow" ? 3 + r(k, 7) * 7 : 8 + r(k, 7) * 10;
        return <div key={k} style={{ position: "absolute", left: x, top: y, width: s, height: kind === "snow" ? s : s * 0.45, borderRadius: kind === "snow" ? "50%" : 2, background: kind === "snow" ? "#ffffff" : cols[k % cols.length], opacity: kind === "snow" ? 0.85 : 0.95, transform: kind === "confetti" ? `rotate(${f * 6 * (r(k, 8) - 0.5) + k * 40}deg)` : undefined, filter: kind === "snow" && s < 5 ? "blur(1px)" : undefined }} />;
      })}
    </AbsoluteFill>
  );
};

/** Craft inventory: scanlines with a flicker (CRT / neon type), a ruler grid over the picture, an interface cursor that
 *  travels and clicks, a two-tone grade (cool ground, warm pictures). */
const FxLayer: React.FC<{ fx: { scanlines?: boolean; grid?: boolean; cursor?: { x: number; y: number } } }> = ({ fx }) => {
  const f = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const p = interpolate(f, [fps * 0.4, fps * 1.4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const click = fx.cursor ? interpolate(f, [fps * 1.4, fps * 1.9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {fx.scanlines ? <AbsoluteFill style={{ background: `repeating-linear-gradient(180deg, rgba(0,0,0,0.28) 0, rgba(0,0,0,0.28) 2px, transparent 2px, transparent 5px)`, opacity: 0.55 + 0.25 * Math.abs(Math.sin(f * 1.7)), mixBlendMode: "multiply" }} /> : null}
      {fx.grid ? (
        <AbsoluteFill>
          <AbsoluteFill style={{ background: `repeating-linear-gradient(90deg, rgba(255,255,255,0.35) 0, rgba(255,255,255,0.35) 1px, transparent 1px, transparent ${width / 20}px), repeating-linear-gradient(180deg, rgba(255,255,255,0.18) 0, rgba(255,255,255,0.18) 1px, transparent 1px, transparent ${width / 20}px)`, opacity: 0.6 }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: height * 0.06, height: height * 0.04, display: "flex", justifyContent: "space-between", padding: `0 ${width * 0.02}px`, color: "#fff", fontFamily: "monospace", fontSize: height * 0.022, opacity: 0.8 }}>
            {Array.from({ length: 11 }, (_, k) => <span key={k}>{k * 10}</span>)}
          </div>
        </AbsoluteFill>
      ) : null}
      {fx.cursor ? (
        <div style={{ position: "absolute", left: width * (0.5 + (fx.cursor.x - 0.5) * p), top: height * (0.6 + (fx.cursor.y - 0.6) * p) }}>
          {click > 0 && click < 1 ? <div style={{ position: "absolute", left: -30 * click, top: -30 * click, width: 60 * click, height: 60 * click, borderRadius: "50%", border: `3px solid ${PALETTE.accent}`, opacity: 1 - click }} /> : null}
          <svg width={height * 0.045} height={height * 0.06} viewBox="0 0 24 32"><path d="M2 2 L2 26 L8 20 L12 30 L16 28 L12 18 L20 18 Z" fill="#fff" stroke="#000" strokeWidth="1.6" /></svg>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** Craft inventory: an element pinned to a moving subject follows its tracked path (offset from where it was placed). */
const TrackWrap: React.FC<{ track?: { x: number; y: number; path?: Array<{ t: number; x: number; y: number }> }; children: React.ReactNode }> = ({ track, children }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p = track?.path;
  if (!track || !p || p.length < 2) return <>{children}</>;
  const t = f / fps;
  const k = Math.max(0, p.findIndex((q, i) => i === p.length - 1 || p[i + 1]!.t > t));
  const a = p[k]!, b = p[Math.min(p.length - 1, k + 1)]!;
  const u = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  const dx = (a.x + (b.x - a.x) * u - track.x) * width;
  const dy = (a.y + (b.y - a.y) * u - track.y) * height;
  return <AbsoluteFill style={{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` }}>{children}</AbsoluteFill>;
};

/** Craft inventory: an element leaves before the cut — it slides off, or erodes away (blurs, crumbles from the edges, fades). */
const ExitWrap: React.FC<{ exit?: "none" | "slide" | "erode"; children: React.ReactNode }> = ({ exit, children }) => {
  const f = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  if (!exit || exit === "none") return <>{children}</>;
  const k = interpolate(f, [durationInFrames - 10, durationInFrames - 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  if (k <= 0) return <>{children}</>;
  const style: React.CSSProperties = exit === "slide"
    ? { transform: `translateX(${-k * width * 1.1}px)` }
    : { filter: `blur(${(k * 10).toFixed(1)}px)`, opacity: 1 - k, clipPath: `inset(${(k * 30).toFixed(1)}% ${(k * 8).toFixed(1)}% ${(k * 30).toFixed(1)}% ${(k * 8).toFixed(1)}%)` };
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};

type DriftSpec = { slot: number; mode: "fall" | "float"; count?: number };
/** Craft inventory: a real picture (a cut-out object — banknotes, coins, papers) repeated as a falling or floating layer. */
const DriftLayer: React.FC<{ drift: DriftSpec; slots: Record<string, string> }> = ({ drift, slots }) => {
  const f = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const src = slots[String(drift.slot)];
  if (!src) return null;
  const n = Math.max(3, Math.min(24, Math.round((drift.count ?? 10) * vary("drift.density", 0.7, 1.3))));
  const rnd = (k: number, s: number) => {
    const x = Math.sin(k * 127.1 + s * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {Array.from({ length: n }, (_, k) => {
        const size = width * (0.07 + rnd(k, 1) * 0.08);
        const x0 = rnd(k, 2) * width;
        const speed = (drift.mode === "fall" ? 0.9 : 0.25) * (0.7 + rnd(k, 3) * 0.6);
        const prog = (f / durationInFrames) * speed + rnd(k, 4);
        const y = drift.mode === "fall" ? ((prog % 1.25) - 0.15) * height : height * (0.15 + rnd(k, 5) * 0.7) + Math.sin(f / 30 + k) * height * 0.03 - prog * height * 0.1;
        const x = x0 + Math.sin(f / (20 + rnd(k, 6) * 20) + k) * width * 0.04;
        const r = (f * (drift.mode === "fall" ? 2.5 : 0.6) * (rnd(k, 7) - 0.5)) + rnd(k, 8) * 360;
        const z = 0.6 + rnd(k, 9) * 0.6;
        return <Img key={k} src={staticFile(src)} style={{ position: "absolute", left: x, top: y, width: size * z, transform: `rotate(${r}deg) rotateX(${Math.sin(f / 9 + k) * 50}deg)`, filter: `drop-shadow(0 8px 12px rgba(0,0,0,0.45)) ${z < 0.8 ? "blur(1.2px)" : ""}`, opacity: 0.95 }} />;
      })}
    </AbsoluteFill>
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
  // craft inventory: a glitch burst with RGB split over the shot's first frames (and a flicker at a third of it)
  const fxs = (spec as { fx?: { glitch?: boolean; dof?: number; rack?: boolean; scanlines?: boolean; grid?: boolean; cursor?: { x: number; y: number }; twotone?: boolean } }).fx;
  const rackPx = fxs?.rack ? interpolate(f, [0, 14], [width * 0.012, 0], { extrapolateRight: "clamp" }) : 0;
  const gid = `glitch${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const glitchOn = Boolean(fxs?.glitch) && (f < 9 || (f > durationInFrames / 3 && f < durationInFrames / 3 + 4));
  const gdx = glitchOn ? Math.round((Math.sin(f * 2.7) + 1.2) * width * 0.004) : 0;
  const dofPx = Math.round((fxs?.dof ?? 0) * width * 0.008);
  return (
    <AbsoluteFill style={{ overflow: "hidden", ...(glitchOn ? { filter: `url(#${gid})` } : rackPx > 0.3 ? { filter: `blur(${rackPx.toFixed(1)}px)` } : {}) }}>
      {glitchOn ? (
        <svg width={0} height={0} style={{ position: "absolute" }}>
          <filter id={gid} colorInterpolationFilters="sRGB">
            <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
            <feOffset in="r" dx={gdx} dy="0" result="ro" />
            <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="gb" />
            <feOffset in="gb" dx={-gdx} dy="0" result="gbo" />
            <feBlend in="ro" in2="gbo" mode="screen" />
          </filter>
        </svg>
      ) : null}
      {/* shallow depth of field: footage under the scene defocused behind the pictures on it */}
      {dofPx > 0 && bd === "footage" ? <AbsoluteFill style={{ backdropFilter: `blur(${dofPx}px)` }} /> : null}
      {/* Footage coloured toward the film's palette (the colourist's choice), under everything. */}
      {wash && bd === "footage" ? (
        <>
          {wash.mode === "duotone" ? <AbsoluteFill style={{ backdropFilter: `grayscale(${Math.min(0.85, wash.strength * 1.4)}) contrast(1.1)` }} /> : null}
          <AbsoluteFill style={{ background: tok(wash.color, PALETTE.primary), mixBlendMode: wash.mode === "duotone" ? "color" : "soft-light", opacity: wash.mode === "duotone" ? Math.min(0.6, wash.strength * 0.9) : wash.strength * 1.2 }} />
        </>
      ) : null}
      {bd === "stage" ? <KitStage /> : null}
      {bd === "world" && spec.world ? <AbsoluteFill style={dofPx > 0 ? { filter: `blur(${dofPx}px)` } : undefined}><World world={spec.world} slots={slots} /></AbsoluteFill> : bd === "world" ? <KitStage /> : null}
      <AbsoluteFill style={{ transform: `scale(${1 + (scale - 1) * 0.3})`, transformOrigin: `${fx * 100}% ${fy * 100}%` }}>
        <div style={{ position: "absolute", inset: 0, width, height, ...(fxs?.twotone ? { filter: "sepia(0.35) saturate(1.3) hue-rotate(-10deg)" } : {}) }}>
          {spec.elements.map((el, i) => (
            <ExitWrap key={i} exit={el.exit}>
              <TrackWrap track={el.track}>
                <Element el={el} i={i} slots={slots} drift={drift} />
              </TrackWrap>
            </ExitWrap>
          ))}
        </div>
      </AbsoluteFill>
      {fxs?.twotone ? <AbsoluteFill style={{ background: "#1b6f8a", mixBlendMode: "color", opacity: 0.35, pointerEvents: "none" }} /> : null}
      {fxs && (fxs.scanlines || fxs.grid || fxs.cursor) ? <FxLayer fx={fxs} /> : null}
      {(spec as { atmos?: { kind: string } }).atmos && ["snow", "confetti", "bokeh"].includes((spec as unknown as { atmos: { kind: string } }).atmos.kind) ? <AirLayer kind={(spec as unknown as { atmos: { kind: "snow" | "confetti" | "bokeh" } }).atmos.kind} /> : null}
      {(spec as { drift?: DriftSpec }).drift ? <DriftLayer drift={(spec as unknown as { drift: DriftSpec }).drift} slots={slots} /> : null}
      {spec.finish ? <Finish finish={spec.finish} /> : null}
    </AbsoluteFill>
  );
};
