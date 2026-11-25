/**
 * The channel's craft as tools (hand film v31–v32, 2026-11-25): what made the hand-built FTX opening read like the
 * channel, taken out of that film's kit so every film's art director and scene designer can use it. A kit imports them
 * with `import { Slab3D, Shatter, … } from "@craft"`.
 *
 * These are TECHNIQUES, not a look (owner: zero template share). None carries a colour, typeface, layout or timing of
 * its own that a film would inherit: every colour and font is a required prop or a neutral that the kit is expected to
 * replace, and every placement and moment is the kit's. Two films using Slab3D share a technique the reference uses,
 * the way two editors share a whip pan; they must not share how it is set.
 */
import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useVideoConfig } from "remotion";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
/** Seeded noise in [0, 1): the same (i, k) always gives the same value, so a render is deterministic. */
export const rnd = (i: number, k: number) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
/** 0→1 between two frames, clamped, eased. */
export const ramp = (f: number, a: number, b: number, ease: (x: number) => number = EASE_OUT) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
const src = (s: string) => (/^(https?:|data:|\/)/.test(s) ? s : staticFile(s));

/**
 * Type with thickness: the face plus a stack of darker slices behind it in real 3D (preserve-3d), so it can fly in from
 * depth and turn without going flat. Put it inside a parent with `perspective`. Colours and font are the kit's.
 */
export const Slab3D: React.FC<{ text: string; size: number; fontFamily: string; weight?: number; face: string; side: string; highlight?: string; lowlight?: string; glow?: string; depthPx?: number; slices?: number; upper?: boolean; spacing?: number }> = (p) => {
  const d = p.depthPx ?? p.size * 0.12, n = p.slices ?? 14;
  const base: React.CSSProperties = { position: "absolute", left: 0, top: 0, whiteSpace: "nowrap", fontFamily: p.fontFamily, fontWeight: p.weight ?? 900, fontSize: p.size, lineHeight: 1, textTransform: p.upper === false ? "none" : "uppercase", letterSpacing: p.spacing ?? 0 };
  const faceFill = p.highlight || p.lowlight ? { backgroundImage: `linear-gradient(180deg, ${p.highlight ?? p.face} 0%, ${p.face} 45%, ${p.lowlight ?? p.face} 100%)`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" } : { color: p.face };
  return <div style={{ position: "relative", transformStyle: "preserve-3d", width: "max-content", height: p.size }}>
    {Array.from({ length: n }, (_, i) => <div key={i} style={{ ...base, color: p.side, transform: `translateZ(${-d * (i + 1) / n}px)`, filter: `brightness(${1 - i / (n * 1.6)})` }}>{p.text}</div>)}
    <div style={{ ...base, position: "relative", ...faceFill, ...(p.glow ? { filter: `drop-shadow(0 0 ${p.size * 0.1}px ${p.glow})` } : {}) }}>{p.text}</div>
  </div>;
};

/** A flat object with two real faces (a banknote, a card, a coin, a ticket) that can tumble and show its back. */
export const TwoSided: React.FC<{ front: string; back: string; w: number; aspect?: number; style?: React.CSSProperties }> = ({ front, back, w, aspect = 0.43, style }) => <div style={{ position: "absolute", width: w, height: w * aspect, transformStyle: "preserve-3d", ...style }}>
  <Img src={src(front)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", backfaceVisibility: "hidden" }} />
  <Img src={src(back)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", backfaceVisibility: "hidden", transform: "rotateY(180deg)" }} />
</div>;

/**
 * Many objects falling and tumbling through real depth (the channel's money rain, papers, cards). Drawn in two passes
 * so a subject can stand between them: `layer="far"` behind the subject, `layer="near"` in front. `fall` (0→1) drops
 * them all out of frame (the collapse). Put it inside a parent with `perspective`.
 */
export const DepthRain: React.FC<{ n: number; t: number; seed?: number; layer?: "far" | "near" | "all"; split?: number; zFrom?: number; zTo?: number; speed?: number; spread?: number; fall?: number; render: (i: number) => React.ReactNode }> = (p) => {
  const { width: W, height: H } = useVideoConfig();
  const zFrom = p.zFrom ?? -1600, zTo = p.zTo ?? 400, split = p.split ?? -500, sd = p.seed ?? 0, sp0 = p.speed ?? 0.0045, fall = p.fall ?? 0;
  return <>{Array.from({ length: p.n }, (_, i) => {
    const z = zFrom + rnd(i + sd, 1) * (zTo - zFrom);
    if ((p.layer === "far" && z > split) || (p.layer === "near" && z <= split)) return null;
    const x = (rnd(i + sd, 2) - 0.5) * W * (p.spread ?? 2.2), sp = 0.5 + rnd(i + sd, 3);
    const y = ((rnd(i + sd, 4) * 1.6 + p.t * sp0 * sp) % 1.6 - 0.35) * H * 1.6 + fall * H * 1.8 * sp;
    const rx = p.t * (2 + rnd(i + sd, 5) * 5), ry = p.t * (3 + rnd(i + sd, 6) * 6) + rnd(i + sd, 7) * 360, rz = rnd(i + sd, 8) * 360 + p.t * 1.5;
    return <div key={i} style={{ position: "absolute", left: W / 2 + x, top: y - H * 0.3, transformStyle: "preserve-3d", transform: `translate3d(-50%, -50%, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`, filter: z < zFrom + (zTo - zFrom) * 0.3 ? "blur(3px) brightness(0.6)" : z > zTo - (zTo - zFrom) * 0.1 ? "blur(2px)" : undefined }}>{p.render(i)}</div>;
  })}</>;
};

/** A drop-shadow stack that lights a cut-out's edge from the scene's own light, then sets it on the ground. */
export const rimLight = (light: string, core = light, spread = 26) => `drop-shadow(0 0 2px ${core}) drop-shadow(0 0 ${spread}px ${light}) drop-shadow(0 40px 50px rgba(0,0,0,.75))`;

/**
 * The hero: a real cut-out, big, standing on the bottom of the frame, rim-lit by the scene's light, its top edge (where
 * the cut-out ends) fading out. The mask sits on the same element as the filter, so it is applied after the glow and the
 * glow never outlines the fade. Lesson (hand v32): a payoff's hero covers 30–60 % of the frame and is sharp; a small,
 * soft figure among props reads as a pasted photo.
 */
export const HeroCutout: React.FC<{ src: string; x: number; w: number; bottom?: number; light: string; core?: string; fadeTop?: number; scale?: number; brightness?: number; opacity?: number; extraFilter?: string }> = (p) => {
  const { width: W, height: H } = useVideoConfig();
  const fade = p.fadeTop ?? 0.16;
  const mask = fade > 0 ? `linear-gradient(180deg, transparent 0%, #000 ${fade * 100}%)` : undefined;
  return <div style={{ position: "absolute", left: W * p.x, bottom: -H * (p.bottom ?? 0.02), width: W * p.w, transform: `scale(${p.scale ?? 1})`, transformOrigin: "50% 100%", opacity: p.opacity ?? 1, filter: `${rimLight(p.light, p.core)}${p.brightness !== undefined ? ` brightness(${p.brightness})` : ""} ${p.extraFilter ?? ""}`.trim(), ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : {}) }}>
    <Img src={src(p.src)} style={{ width: "100%" }} />
  </div>;
};

/**
 * A name (or any words) wrapping round the subject: drawn once behind the subject and again in front of it, clipped to
 * the right of `frontFrom` (0–1 of the frame width) — the subject's head rises through the middle of its own name.
 */
export const WrapAround: React.FC<{ words: React.ReactNode; subject: React.ReactNode; frontFrom: number; perspective?: number; origin?: string }> = (p) => {
  const { width: W } = useVideoConfig();
  const layer = (clip?: string) => <AbsoluteFill style={{ perspective: p.perspective ?? W, perspectiveOrigin: p.origin ?? "50% 40%", ...(clip ? { clipPath: clip } : {}) }}>{p.words}</AbsoluteFill>;
  return <>{layer()}{p.subject}{layer(`inset(0 0 0 ${W * p.frontFrom}px)`)}</>;
};

/** A second real picture laid into the frame by its light (screen), masked to an area, faint: a face in the city lights. */
export const DoubleExposure: React.FC<{ src: string; opacity: number; cx?: number; cy?: number; radius?: number; scale?: number; shiftX?: number; filter?: string }> = (p) => {
  const { width: W } = useVideoConfig();
  const m = `radial-gradient(ellipse at ${(p.cx ?? 0.6) * 100}% ${(p.cy ?? 0.45) * 100}%, #000 ${(p.radius ?? 0.4) * 50}%, transparent ${(p.radius ?? 0.4) * 155}%)`;
  return <AbsoluteFill style={{ mixBlendMode: "screen", opacity: p.opacity, transform: `scale(${p.scale ?? 1.25}) translateX(${W * (p.shiftX ?? 0.12)}px)`, filter: p.filter ?? "grayscale(1) contrast(1.4) brightness(0.9)", maskImage: m, WebkitMaskImage: m }}>
    <Img src={src(p.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  </AbsoluteFill>;
};

/**
 * A whip: the whole layer smears sideways with motion blur. `out` leaves (k 0→1 as it goes), `in` arrives (k 1→0 as it
 * settles). Pair an `out` on one beat with an `in` on the next for a whip pan between two built scenes.
 */
export const Whip: React.FC<{ k: number; dir: "out" | "in"; side?: 1 | -1; blur?: number; children: React.ReactNode }> = ({ k, dir, side = 1, blur = 26, children }) => {
  const { width: W } = useVideoConfig();
  const x = (dir === "out" ? -1 : 1) * side * k * W * 0.9;
  return <AbsoluteFill style={{ transform: `translateX(${x}px) scaleX(${1 + k * 0.25})`, filter: k > 0.02 ? `blur(${k * blur}px)` : undefined }}>{children}</AbsoluteFill>;
};

/** Anamorphic flare: a thin streak with a hot core crossing the frame (screen-blended). Colours are the scene's light. */
export const Flare: React.FC<{ x: number; y: number; w: number; op: number; light: string; core?: string }> = ({ x, y, w, op, light, core = "#ffffff" }) => op > 0.01 ? <div style={{ position: "absolute", left: x - w / 2, top: y, width: w, height: 6, background: `linear-gradient(90deg, transparent 0%, ${light} 40%, ${core} 50%, ${light} 60%, transparent 100%)`, filter: "blur(2px)", opacity: op, mixBlendMode: "screen", boxShadow: `0 0 40px 12px ${light}` }} /> : null;

/** A device with a lit screen (glass, bezel, a reflection), holding whatever is put in it; `glow` lights what is around. */
export const Phone: React.FC<{ w: number; glow?: number; light?: string; children?: React.ReactNode }> = ({ w, glow = 1, light = "rgba(255,255,255,.35)", children }) => <div style={{ width: w, height: w * 2.05, borderRadius: w * 0.14, background: "linear-gradient(145deg, #3a3a3a, #0b0b0b 40%, #1d1d1d)", padding: w * 0.035, boxShadow: `0 ${w * 0.1}px ${w * 0.3}px rgba(0,0,0,.8), 0 0 ${w * 0.25 * glow}px ${light}`, position: "relative" }}>
  <div style={{ width: "100%", height: "100%", borderRadius: w * 0.11, overflow: "hidden", background: "#0d0f0e", position: "relative" }}>{children}
    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(120deg, rgba(255,255,255,.18) 0%, rgba(255,255,255,0) 35%)", pointerEvents: "none" }} />
  </div>
  <div style={{ position: "absolute", top: w * 0.06, left: "50%", width: w * 0.28, height: w * 0.05, marginLeft: -w * 0.14, borderRadius: w, background: "#000" }} />
</div>;

/** The shards of a pane of glass broken at (cx, cy), as triangles reaching past the frame. */
export const shardsOf = (cx: number, cy: number, n: number, reach: number) => Array.from({ length: n }, (_, i) => { const a0 = (i / n) * Math.PI * 2 + rnd(i, 5) * 0.2, a1 = ((i + 1) / n) * Math.PI * 2 + rnd(i + 1, 5) * 0.2; return [[cx, cy], [cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach], [cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach]] as [[number, number], [number, number], [number, number]]; });

/** Cracks spreading from the break point (k 0→1). */
export const Cracks: React.FC<{ cx: number; cy: number; k: number; n?: number; color?: string }> = ({ cx, cy, k, n = 14, color = "rgba(255,255,255,.9)" }) => {
  const { width: W, height: H } = useVideoConfig();
  if (k <= 0) return null;
  return <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>{shardsOf(cx, cy, n, W * 1.6).map((tri, i) => <polyline key={i} points={`${cx},${cy} ${cx + (tri[1][0] - cx) * 0.4 * k + rnd(i, 7) * 20},${cy + (tri[1][1] - cy) * 0.4 * k} ${cx + (tri[1][0] - cx) * k},${cy + (tri[1][1] - cy) * k}`} fill="none" stroke={color} strokeWidth={2.5} />)}</svg>;
};

/**
 * A transition built from the picture: the frame (children) breaks into shards that fall and turn away (k 0→1),
 * showing whatever is drawn under this layer. Draw the next scene first, then this over it.
 */
export const Shatter: React.FC<{ k: number; cx: number; cy: number; n?: number; children: React.ReactNode }> = ({ k, cx, cy, n = 14, children }) => {
  const { width: W, height: H } = useVideoConfig();
  if (k <= 0) return <AbsoluteFill>{children}</AbsoluteFill>;
  return <AbsoluteFill style={{ perspective: W }}>{shardsOf(cx, cy, n, W * 1.6).map((tri, i) => {
    const dx = (tri[1][0] + tri[2][0]) / 2 - cx, dy = (tri[1][1] + tri[2][1]) / 2 - cy;
    return <AbsoluteFill key={i} style={{ clipPath: `polygon(${tri.map((q) => `${q[0]}px ${q[1]}px`).join(",")})`, transform: `translate3d(${dx * 0.12 * k}px, ${dy * 0.12 * k + H * 0.9 * k * k * (0.6 + rnd(i, 2))}px, ${300 * k}px) rotateX(${(rnd(i, 3) - 0.5) * 140 * k}deg) rotateZ(${(rnd(i, 4) - 0.5) * 60 * k}deg)`, opacity: 1 - k * 0.7 }}>{children}</AbsoluteFill>;
  })}</AbsoluteFill>;
};

/** A pane of glass in depth holding content: stacked edge slices, a light reflection sweeping, an optional reflected picture. */
export const GlassSlab: React.FC<{ w: number; k: number; edge: string; glow: string; reflect?: string; reflectOpacity?: number; radius?: number; children: React.ReactNode }> = (p) => {
  const r = p.radius ?? p.w * 0.033;
  return <div style={{ position: "relative", transformStyle: "preserve-3d" }}>
    {[6, 4, 2].map((d) => <div key={d} style={{ position: "absolute", inset: 0, transform: `translateZ(${-d * 4}px)`, background: p.edge, borderRadius: r }} />)}
    <div style={{ position: "relative", width: p.w, borderRadius: r, overflow: "hidden", boxShadow: `0 0 ${p.w * 0.1}px ${p.glow}, 0 ${p.w * 0.05}px ${p.w * 0.13}px rgba(0,0,0,.9)` }}>
      {p.children}
      {p.reflect ? <AbsoluteFill style={{ mixBlendMode: "screen", opacity: p.reflectOpacity ?? 0.16, filter: "grayscale(1) contrast(1.3)", transform: `translateX(${p.w * 0.08 * p.k}px)` }}><Img src={src(p.reflect)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></AbsoluteFill> : null}
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(${110 + 40 * p.k}deg, rgba(255,255,255,0) 30%, rgba(255,255,255,.14) 45%, rgba(255,255,255,0) 60%)` }} />
    </div>
  </div>;
};

/** A camera shake on an impact: an offset in px for frame f, from `at` for `len` frames. */
export const shake = (f: number, at: number, len = 10, amp = 30) => (f >= at && f < at + len ? (rnd(f, 9) - 0.5) * amp * (1 - (f - at) / len) : 0);

/** What the tools are for, as the agents see it (the art director's and scene designer's brief). */
export const CRAFT_TOOLS: Record<string, string> = {
  Slab3D: "spoken words as thick carved 3D type that flies in from depth and turns (inside perspective); colours and font are yours",
  TwoSided: "a real flat object with two photographed faces (banknote front/back, a card) that tumbles and shows its back",
  DepthRain: "many objects falling and tumbling in real depth, in a far pass behind the subject and a near pass in front of it; fall collapses them",
  HeroCutout: "the subject cut out BIG (30–60 % of the frame), sharp, standing on the frame's bottom, rim-lit by the scene's own light, top edge faded",
  rimLight: "a filter string: edge glow from the scene's light colour plus a ground shadow, for any cut-out",
  WrapAround: "a name or phrase behind the subject and again in front of it (clipped), so the subject breaks through its own words",
  DoubleExposure: "a second real picture (a face) faint in the light of the first (a city), masked to an area",
  Whip: "a whip pan between two built beats: out on one, in on the next, with motion blur",
  Flare: "an anamorphic light streak crossing on a hit or a figure",
  Phone: "a device with a lit screen carrying a real post, flown in 3D",
  GlassSlab: "content on a pane of glass with depth, a sweeping reflection and a faint reflected face",
  Cracks: "cracks spreading from a point before a break",
  Shatter: "the frame breaks into shards that fall away and reveal the next scene beneath (a transition made of the picture)",
  shake: "camera shake offset on an impact",
};
