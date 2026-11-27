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
import { AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

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


// ── the minute's techniques (hand film v34, 2026-11-25: built after watching the channel's first minutes at 12 fps) ──

/**
 * The line's key words, huge, building WORD BY WORD on the voice: each word arrives on its own time out of a blur, a
 * little large, settles and keeps growing slowly; the block leaves together at `until` (s). Fills are the film's own
 * (a CSS gradient clipped to the letters); a glow filter and fonts are the film's too. The longest line is fitted to
 * its box, so nothing runs off the frame. Channel: the typical word stays up ≈ 2.5 s. A word marked `c` takes the
 * `hi` fill: the key word of a line picked out in the film's warning colour (a channel staple).
 */
export const BuildWords: React.FC<{ words: Array<{ text: string; at: number; br?: boolean; c?: "r" | "y" }>; x: number; y: number; w: number; size: number; fontFamily: string; fill: string; /** fill of the key words (`c`), the channel's one word picked out in colour */ hi?: string; glow?: string; until?: number; align?: "left" | "center" | "right"; tilt?: number; caps?: boolean; charEm?: number; enter?: "rise" | "fly" | "spin" }> = (p) => {
  const f = useCurrentFrame(); const { width: W, height: H, fps } = useVideoConfig();
  if (!p.words.length) return null;
  const first = Math.min(...p.words.map((w) => w.at));
  const gone = p.until !== undefined ? interpolate(f, [p.until * fps, p.until * fps + 8], [1, 0], clamp) : 1;
  if (gone <= 0 || f < first * fps - 6) return null;
  const grow = interpolate(f, [first * fps, first * fps + 150], [1, 1.06], clamp);
  const lines: Array<typeof p.words> = [[]];
  for (const w of p.words) { if (w.br) lines.push([]); lines.at(-1)!.push(w); }
  const em = p.charEm ?? 0.41;
  const est = Math.max(...lines.map((l) => l.reduce((a, w) => a + (w.text.length + 1) * em, 0)));
  const size = Math.min(p.size, (p.w * W * 0.96) / Math.max(1, est));
  return <div style={{ position: "absolute", left: W * p.x, top: H * p.y, width: W * p.w, display: "flex", flexDirection: "column", alignItems: p.align === "left" ? "flex-start" : p.align === "right" ? "flex-end" : "center", transform: `scale(${grow}) rotate(${p.tilt ?? 0}deg)`, opacity: gone, filter: `${p.glow ?? ""}${gone < 1 ? ` blur(${(1 - gone) * 14}px)` : ""}` || undefined }}>
    {lines.map((l, i) => <div key={i} style={{ display: "flex", gap: size * 0.12, whiteSpace: "nowrap", lineHeight: 0.92 }}>{l.map((w, j) => {
      const letterStyle: React.CSSProperties = { display: "inline-block", whiteSpace: "nowrap", fontFamily: p.fontFamily, fontSize: size, textTransform: p.caps === false ? "none" : "uppercase", backgroundImage: w.c && p.hi ? p.hi : p.fill, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent" };
      if (p.enter === "spin") {
        // letters turn in one after another (the channel's title letters spinning in)
        return <span key={j} style={{ display: "inline-block", whiteSpace: "nowrap", perspective: size * 4, padding: `0 ${size * 0.02}px` }}>{[...w.text].map((ch, c) => { const kc = interpolate(f, [w.at * fps - 3 + c * 1.6, w.at * fps + 8 + c * 1.6], [0, 1], { ...clamp, easing: EASE_OUT }); return <span key={c} style={{ ...letterStyle, opacity: kc, transform: `rotateY(${(1 - kc) * 95}deg) scale(${1.4 - 0.4 * kc})`, filter: kc < 0.99 ? `blur(${(1 - kc) * 8}px)` : undefined }}>{ch === " " ? "\u00a0" : ch}</span>; })}</span>;
      }
      const k = interpolate(f, [w.at * fps - (p.enter === "fly" ? 5 : 3), w.at * fps + (p.enter === "fly" ? 7 : 6)], [0, 1], { ...clamp, easing: EASE_OUT });
      const tr = p.enter === "fly" ? `scale(${2.8 - 1.8 * k}) translateY(${(1 - k) * -size * 0.4}px)` : `translateY(${(1 - k) * size * 0.25}px) scale(${1.25 - 0.25 * k})`;
      return <span key={j} style={{ ...letterStyle, opacity: Math.min(1, k * 1.4), transform: tr, filter: k < 0.99 ? `blur(${(1 - k) * (p.enter === "fly" ? 20 : 12)}px)` : undefined, padding: `0 ${size * 0.02}px` }}>{w.text}</span>;
    })}</div>)}
  </div>;
};

/** A performed clip (or photo) filling the frame under the film's grade, with its own bloom, pushing in the whole time;
 *  `from` (s) starts a clip later in the shot (a second picture dissolving in). */
export const GradedPlate: React.FC<{ src?: string; trim?: number; from?: number; push?: [number, number]; pan?: [number, number]; rot?: [number, number]; len: number; bloom?: number; grade: string; blend?: React.CSSProperties["mixBlendMode"]; opacity?: number }> = (p) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  if (!p.src) return null;
  const k = interpolate(f, [0, Math.max(1, p.len * fps)], [0, 1], clamp);
  const [a, b] = p.push ?? [1.04, 1.16], [x0, x1] = p.pan ?? [0, 0];
  const style: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };
  const isV = /\.(mp4|mov|webm)$/i.test(p.src);
  const pic = (filter: string) => isV ? <Sequence from={Math.round((p.from ?? 0) * fps)} layout="none"><OffthreadVideo src={src(p.src!)} muted startFrom={Math.round((p.trim ?? 0) * fps)} style={{ ...style, filter }} /></Sequence> : <Img src={src(p.src!)} style={{ ...style, filter }} />;
  const [r0, r1] = p.rot ?? [0, 0];
  return <AbsoluteFill style={{ transform: `scale(${a + (b - a) * k}) translateX(${(x0 + (x1 - x0) * k) * 100}%) rotate(${r0 + (r1 - r0) * k}deg)`, mixBlendMode: p.blend ?? "normal", opacity: p.opacity ?? 1 }}>
    {pic(p.grade)}
    {p.bloom ? <AbsoluteFill style={{ mixBlendMode: "screen", opacity: p.bloom }}>{pic(`${p.grade} blur(22px) brightness(1.35)`)}</AbsoluteFill> : null}
  </AbsoluteFill>;
};

/** A light flash carrying one picture into the next: from white at the start (inF frames), to white at the end (outF),
 *  and short flashes at `at` (s). The channel changes picture this way every few seconds in a cold open. */
export const FlashCut: React.FC<{ len: number; inF?: number; outF?: number; at?: number[]; colour: string }> = ({ len, inF = 7, outF = 4, at = [], colour }) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const end = len * fps;
  let o = Math.max(inF > 0 ? interpolate(f, [0, inF], [1, 0], clamp) : 0, outF > 0 ? interpolate(f, [end - outF, end], [0, 1], clamp) : 0);
  for (const t of at) o = Math.max(o, interpolate(f, [t * fps - 2, t * fps, t * fps + 7], [0, 0.95, 0], clamp));
  return o > 0.01 ? <AbsoluteFill style={{ background: colour, opacity: o }} /> : null;
};

/** The frame's own light: a soft-light wash in the film's colour, a hot centre, the edges burned down. */
export const LightWash: React.FC<{ wash: string; washOpacity?: number; hot: string; cx?: number; cy?: number; edge: string }> = ({ wash, washOpacity = 0.38, hot, cx = 50, cy = 45, edge }) => <>
  <AbsoluteFill style={{ background: wash, mixBlendMode: "soft-light", opacity: washOpacity }} />
  <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${cx}% ${cy}%, ${hot} 0%, rgba(0,0,0,0) 55%)`, mixBlendMode: "screen" }} />
  <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 52%, ${edge} 100%)` }} />
</>;

/** Light filmed on black (sparks, embers, dust in a beam) laid over by its light. */
export const LightLayer: React.FC<{ src?: string; opacity?: number; trim?: number; filter?: string }> = ({ src: s, opacity = 0.5, trim = 0, filter }) => { const { fps } = useVideoConfig(); return s ? <AbsoluteFill style={{ mixBlendMode: "screen", opacity }}><OffthreadVideo src={src(s)} muted startFrom={Math.round(trim * fps)} style={{ width: "100%", height: "100%", objectFit: "cover", ...(filter ? { filter } : {}) }} /></AbsoluteFill> : null; };


/** A zoom-through between two built shots: the shot arrives out of a blurred, enlarged frame (inF frames) and leaves
 *  into one (outF frames), so the picture changes by moving, not by a cut. Wrap a whole shot in it. */
export const ZoomThrough: React.FC<{ len: number; inF?: number; outF?: number; children: React.ReactNode }> = ({ len, inF = 8, outF = 6, children }) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const end = len * fps;
  const ki = inF > 0 ? interpolate(f, [0, inF], [1, 0], { ...clamp, easing: Easing.out(Easing.cubic) }) : 0;
  const ko = outF > 0 ? interpolate(f, [end - outF, end], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) }) : 0;
  const k = Math.max(ki, ko);
  return <AbsoluteFill style={{ transform: `scale(${1 + 0.45 * ki + 0.5 * ko})`, filter: k > 0.02 ? `blur(${k * 9}px) brightness(${1 + 0.25 * k})` : undefined }}>{children}</AbsoluteFill>;
};

/** What the tools are for, as the agents see it (the art director's and scene designer's brief). */
/** Camera keyframes over time (s): scale, x/y (fractions of the frame), rotation (deg). Eased between keys. A plain
 *  building block (build list 6, F1): the look of what it moves through is the film's own. */
export type CamKey = { t: number; s?: number; x?: number; y?: number; r?: number };
export function camAt(keys: CamKey[], t: number): Required<Omit<CamKey, "t">> {
  const ks = [...keys].sort((a, b) => a.t - b.t);
  const v = (k: CamKey) => ({ s: k.s ?? 1, x: k.x ?? 0, y: k.y ?? 0, r: k.r ?? 0 });
  if (!ks.length) return { s: 1, x: 0, y: 0, r: 0 };
  if (t <= ks[0]!.t) return v(ks[0]!);
  for (let i = 1; i < ks.length; i++) if (t <= ks[i]!.t) {
    const a = v(ks[i - 1]!), b = v(ks[i]!), u = EASE_IN_OUT((t - ks[i - 1]!.t) / Math.max(1e-3, ks[i]!.t - ks[i - 1]!.t));
    return { s: a.s + (b.s - a.s) * u, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, r: a.r + (b.r - a.r) * u };
  }
  return v(ks[ks.length - 1]!);
}
export const CameraPath: React.FC<{ keys: CamKey[]; depth?: number; origin?: [number, number]; children: React.ReactNode }> = ({ keys, depth = 1, origin = [0.5, 0.5], children }) => {
  const f = useCurrentFrame(); const { fps, width: W, height: H } = useVideoConfig();
  const c = camAt(keys, f / fps);
  return <AbsoluteFill style={{ transformOrigin: `${origin[0] * 100}% ${origin[1] * 100}%`, transform: `translate(${c.x * W * depth}px, ${c.y * H * depth}px) scale(${1 + (c.s - 1) * depth}) rotate(${c.r * depth}deg)` }}>{children}</AbsoluteFill>;
};

/** A real still made to move like a filmed shot: the photo split into depth planes (its background, softened, and the
 *  subject cut out at the place it stood — `box` from the cut-out tool), each plane following the same camera path at its
 *  own depth, so the subject travels against its background. Plain block: grade, colour and type stay the film's. */
export const Parallax: React.FC<{ bg: string; cut?: string; box?: [number, number, number, number]; aspect: number; keys: CamKey[]; near?: number; far?: number; bgFilter?: string; cutFilter?: string; extra?: React.ReactNode }> = (p) => {
  const { width: W, height: H } = useVideoConfig();
  // the photo fitted to cover the frame (with room to travel)
  const fw = Math.max(W, H * p.aspect) * 1.08, fh = fw / p.aspect;
  const plane = (child: React.ReactNode, depth: number, key: string) => <CameraPath key={key} keys={p.keys} depth={depth}><div style={{ position: "absolute", left: (W - fw) / 2, top: (H - fh) / 2, width: fw, height: fh }}>{child}</div></CameraPath>;
  const b = p.box ?? [0, 0, 1, 1];
  return <AbsoluteFill style={{ overflow: "hidden" }}>
    {plane(<Img src={src(p.bg)} style={{ width: "100%", height: "100%", objectFit: "fill", filter: p.bgFilter ?? "blur(3px) brightness(0.82)", transform: "scale(1.22)" }} />, p.far ?? 0.55, "bg")} {/* the far plane is oversized so the camera never travels past its edge */}
    {p.extra ? plane(p.extra, ((p.far ?? 0.55) + (p.near ?? 1.35)) / 2, "mid") : null}
    {p.cut ? plane(<Img src={src(p.cut)} style={{ position: "absolute", left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[3] * 100}%`, filter: p.cutFilter ?? "drop-shadow(0 18px 30px rgba(0,0,0,.55))" }} />, p.near ?? 1.35, "cut") : null}
  </AbsoluteFill>;
};

// ---- from Wirecard v7 (2026-11-26, footage first): the quiet devices the channel uses between its big words

/** A place or name line, the documentary way: a thin rule drawing out, mono caps beside it, an optional second line.
 *  Not a box or a label: it sits on the footage. Your font and colours. */
export const PlaceLine: React.FC<{ text: string; sub?: string; at: number; x?: number; y?: number; until?: number; font: string; color: string; subColor?: string; rule: string; size?: number }> = (p) => {
  const t = useCurrentFrame() / useVideoConfig().fps;
  const k = interpolate(t, [p.at, p.at + 0.5], [0, 1], { ...clamp, easing: EASE_OUT });
  const g = p.until !== undefined ? interpolate(t, [p.until - 0.25, p.until], [1, 0], clamp) : 1;
  if (k <= 0) return null;
  const z = p.size ?? 52;
  return <div style={{ position: "absolute", left: `${(p.x ?? 0.06) * 100}%`, top: `${(p.y ?? 0.8) * 100}%`, opacity: g }}>
    <div style={{ width: k * z * 5, height: Math.max(3, z / 10), background: p.rule, marginBottom: z * 0.27 }} />
    <div style={{ fontFamily: p.font, fontWeight: 600, fontSize: z, letterSpacing: "0.18em", color: p.color, opacity: k, textShadow: "0 2px 18px rgba(0,0,0,.95)" }}>{p.text}</div>
    {p.sub ? <div style={{ fontFamily: p.font, fontWeight: 500, fontSize: z * 0.58, letterSpacing: "0.26em", color: p.subColor ?? p.color, opacity: k, marginTop: z * 0.15, textShadow: "0 2px 14px rgba(0,0,0,.95)" }}>{p.sub}</div> : null}
  </div>;
};

/** A lit information board in a dark room (stock index, departures, scoreboard): glowing rows on a dot-pitch screen,
 *  seen at an angle; one row changes on cue (flickers, then shows its new text in its new colour). Your font and colours. */
export const LedBoard: React.FC<{ rows: Array<{ name: string; value?: string; to?: string; toColor?: string }>; swapAt?: number; font: string; color: string; up?: string; down?: string; size?: number; columns?: number; tilt?: number }> = (p) => {
  const t = useCurrentFrame() / useVideoConfig().fps;
  const sw = p.swapAt !== undefined ? interpolate(t, [p.swapAt, p.swapAt + 0.35], [0, 1], clamp) : 0;
  const flick = sw > 0 && sw < 1 ? (Math.floor(t * 30) % 2 ? 0.2 : 1) : 1;
  return <AbsoluteFill style={{ background: "#04060a" }}>
    <AbsoluteFill style={{ transform: `perspective(1600px) rotateY(${p.tilt ?? -14}deg)`, transformOrigin: "30% 40%" }}>
      <div style={{ position: "absolute", left: "8%", top: "6%", width: "84%", height: "90%", background: "#0a0c10", border: "6px solid #15181f", padding: "28px 40px", columnCount: p.columns ?? 2, columnGap: 80 }}>
        {p.rows.map((r, i) => {
          const swapped = r.to !== undefined && sw >= 0.5;
          const c = swapped ? r.toColor ?? p.color : p.color;
          const v = r.value ?? "";
          const vc = v.trim().startsWith("-") ? p.down ?? "#ff5a4a" : p.up ?? "#7dff8c";
          return <div key={i} style={{ display: "flex", justifyContent: "space-between", fontFamily: p.font, fontWeight: 900, fontSize: p.size ?? 40, letterSpacing: "0.04em", color: c, textShadow: `0 0 12px ${c}, 0 0 30px ${c}`, opacity: r.to !== undefined ? flick : 0.92, padding: "4px 0" }}>
            <span>{swapped ? r.to : r.name}</span>{v ? <span style={{ color: vc, textShadow: "0 0 10px currentColor" }}>{v}</span> : null}
          </div>;
        })}
      </div>
      <AbsoluteFill style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0) 0 1.6px, rgba(0,0,0,.55) 2.2px)", backgroundSize: "6px 6px" }} />
    </AbsoluteFill>
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 40% 45%, rgba(0,0,0,0) 40%, rgba(0,0,0,.75) 100%)" }} />
  </AbsoluteFill>;
};

/** A real photo printed and pinned into a scene (an evidence board, a wall), dropping in on cue, with a thread drawn
 *  to it. Put it over footage of the place it is pinned in. */
export const PinnedPrint: React.FC<{ src: string; at: number; right?: number; top?: number; w?: number; pin: string; thread?: { from: [number, number] }; filter?: string }> = (p) => {
  const { fps, width: W, height: H } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  const k = interpolate(t, [p.at, p.at + 0.4], [0, 1], { ...clamp, easing: EASE_OUT });
  const right = p.right ?? 0.09, top = p.top ?? 0.14, w = p.w ?? 0.26;
  return <>
    <div style={{ position: "absolute", right: `${right * 100}%`, top: `${top * 100}%`, width: `${w * 100}%`, aspectRatio: "4 / 5", background: "#ececea", padding: "1.2%", transform: `rotate(${4 - k * 2}deg) translateY(${(1 - k) * -60}px)`, opacity: k, boxShadow: "0 30px 60px rgba(0,0,0,.7)" }}>
      <div style={{ width: "100%", height: "100%", background: "#c9c9c4", overflow: "hidden" }}><Img src={src(p.src)} style={{ width: "120%", marginLeft: "-10%", filter: p.filter ?? "grayscale(1) contrast(1.3)" }} /></div>
      <div style={{ position: "absolute", left: "48%", top: -10, width: 22, height: 22, borderRadius: 11, background: p.pin, boxShadow: "0 4px 6px rgba(0,0,0,.6)" }} />
    </div>
    {p.thread ? <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }} viewBox={`0 0 ${W} ${H}`}><path d={`M ${W * (1 - right - w / 2)} ${H * (top - 0.01)} Q ${W * 0.55} ${H * 0.24} ${W * p.thread.from[0]} ${H * p.thread.from[1]}`} stroke={p.pin} strokeWidth="4" fill="none" strokeDasharray={`${k * W} ${W * 2}`} /></svg> : null}
  </>;
};

/** A beam of light sweeping across a print or a document on a dark wall (a torch, a passing car) — a still made to
 *  play. Lay it over the print's box. */
export const LightSweep: React.FC<{ from?: number; to?: number; len: number; dark?: number; light?: number }> = ({ from = -40, to = 140, len, dark = 0.55, light = 0.18 }) => {
  const t = useCurrentFrame() / useVideoConfig().fps;
  const x = interpolate(t, [0, len], [from, to], clamp);
  return <AbsoluteFill style={{ background: `linear-gradient(105deg, rgba(0,0,0,${dark}) ${x - 30}%, rgba(255,255,255,${light}) ${x}%, rgba(0,0,0,${dark}) ${x + 30}%)` }} />;
};

// ---- from Wirecard v7.1–v7.2 (2026-11-26): what the channel lays over its footage. A menu, never a recipe: each film
//      uses what its own story calls for (see packages/agents/skills/scenes.md "The channel's menu").

/** The subject arriving out of a broken signal: RGB split, jitter and tear lines settling into the picture over `len`
 *  seconds. For a shock or the first sight of a person — not a default opening. */
export const GlitchIn: React.FC<{ len?: number; from?: number; children: React.ReactNode }> = ({ len = 0.8, from = 0, children }) => {
  const { fps } = useVideoConfig(); const t = useCurrentFrame() / fps - from;
  const g = interpolate(t, [0, len], [1, 0], { ...clamp, easing: EASE_OUT });
  if (t < 0 || g <= 0.01) return <>{children}</>;
  const f = Math.floor(t * fps), j = (k: number) => (rnd(f, k) - 0.5) * 2;
  return <AbsoluteFill>
    <AbsoluteFill style={{ transform: `translateX(${j(1) * 40 * g}px)` }}>{children}</AbsoluteFill>
    <AbsoluteFill style={{ mixBlendMode: "screen", opacity: 0.7 * g, transform: `translateX(${18 * g + j(2) * 20 * g}px)`, filter: "sepia(1) saturate(6) hue-rotate(-50deg)" }}>{children}</AbsoluteFill>
    <AbsoluteFill style={{ mixBlendMode: "screen", opacity: 0.7 * g, transform: `translateX(${-18 * g + j(3) * 20 * g}px)`, filter: "sepia(1) saturate(6) hue-rotate(170deg)" }}>{children}</AbsoluteFill>
    {[0, 1, 2, 3].map((k) => <div key={k} style={{ position: "absolute", left: 0, right: 0, top: `${rnd(f, 10 + k) * 100}%`, height: `${2 + rnd(f, 20 + k) * 6}%`, background: "rgba(255,255,255,.12)", opacity: g, transform: `translateX(${j(4 + k) * 80}px)` }} />)}
  </AbsoluteFill>;
};

/** A real article (a screenshot of the cited source, never retyped) laid into the shot as a lit print, a marker sweeping
 *  the words that prove the line, its source and date under it. The claim shown, not only said. */
export const PressHeadline: React.FC<{ src: string; at: number; x: number; y: number; w: number; rot?: number; mark?: { x: number; y: number; w: number; h: number; at: number }; markColor: string; source: string; sourceFont: string; sourceColor: string }> = (p) => {
  const { fps } = useVideoConfig(); const t = useCurrentFrame() / fps;
  const k = interpolate(t, [p.at, p.at + 0.45], [0, 1], { ...clamp, easing: EASE_OUT });
  const gl = interpolate(t, [p.at, p.at + 0.25], [1, 0], clamp);
  const mk = p.mark ? interpolate(t, [p.mark.at, p.mark.at + 0.5], [0, 1], { ...clamp, easing: EASE_OUT }) : 0;
  if (k <= 0) return null;
  return <div style={{ position: "absolute", left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, transform: `translate(-50%, -50%) rotate(${p.rot ?? -2}deg) scale(${0.94 + 0.06 * k}) translateX(${(rnd(Math.floor(t * fps), 3) - 0.5) * 60 * gl}px)`, opacity: k, boxShadow: "0 40px 80px rgba(0,0,0,.75)" }}>
    <Img src={src(p.src)} style={{ width: "100%", display: "block" }} />
    {p.mark ? <div style={{ position: "absolute", left: `${p.mark.x * 100}%`, top: `${p.mark.y * 100}%`, width: `${p.mark.w * mk * 100}%`, height: `${p.mark.h * 100}%`, background: p.markColor, opacity: 0.4, mixBlendMode: "multiply" }} /> : null}
    <div style={{ position: "absolute", left: 0, bottom: -46, fontFamily: p.sourceFont, fontWeight: 600, fontSize: 24, letterSpacing: "0.24em", color: p.sourceColor }}>{p.source}</div>
  </div>;
};

/** The film's signature object: one real object from THIS story (cut out), lit on a dark ground, with a surface whose
 *  content the scene controls (a terminal's screen, a phone, a ticket board, a stamp's face) — it returns two or three
 *  times and its meaning changes. `screen` is the surface quad in fractions of the cut-out (centre, size, rotation). */
export const SignatureObject: React.FC<{ src: string; aspect: number; w: number; screen?: { cx: number; cy: number; w: number; h: number; rot: number }; text?: string; textAt?: number; dieAt?: number; color: string; font: string; size?: number; keys?: CamKey[]; ground?: string; blink?: boolean }> = (p) => {
  const { fps, width: W } = useVideoConfig(); const t = useCurrentFrame() / fps;
  const c = camAt(p.keys ?? [{ t: 0, s: 1 }, { t: 3, s: 1.1 }], t);
  const on = interpolate(t, [p.textAt ?? 0.15, (p.textAt ?? 0.15) + 0.12], [0, 1], clamp) * (p.dieAt !== undefined ? interpolate(t, [p.dieAt, p.dieAt + 0.08, p.dieAt + 0.16, p.dieAt + 0.5], [1, 0.3, 0.8, 0], clamp) : 1);
  const bl = p.blink ? (Math.floor(t * 3) % 2 ? 1 : 0.55) : 1;
  const w = p.w * W, h = w / p.aspect;
  return <AbsoluteFill style={{ background: p.ground ?? "radial-gradient(ellipse at 55% 45%, #1a2433 0%, #07090d 60%, #020305 100%)" }}>
    <AbsoluteFill style={{ transform: `translate(${c.x}%, ${c.y}%) scale(${c.s}) rotate(${c.r}deg)` }}>
      <div style={{ position: "absolute", left: "50%", top: "50%", width: w, height: h, transform: "translate(-50%, -50%)" }}>
        <Img src={src(p.src)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", filter: "brightness(0.8) contrast(1.15) drop-shadow(0 50px 60px rgba(0,0,0,.85))" }} />
        {p.screen && p.text ? <div style={{ position: "absolute", left: `${p.screen.cx * 100}%`, top: `${p.screen.cy * 100}%`, width: `${p.screen.w * 100}%`, height: `${p.screen.h * 100}%`, transform: `translate(-50%, -50%) rotate(${p.screen.rot}deg)`, boxShadow: `0 0 ${60 * on}px ${p.color}`, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }}>
          <span style={{ fontFamily: p.font, fontWeight: 900, fontSize: p.size ?? 40, letterSpacing: "0.04em", color: p.color, opacity: on * bl, textShadow: `0 0 14px ${p.color}, 0 0 34px ${p.color}` }}>{p.text}</span>
        </div> : null}
      </div>
    </AbsoluteFill>
  </AbsoluteFill>;
};

/** One figure carried across several shots on its own layer (put it above the shots, in film time): it arrives, rides
 *  along (`path`: where it sits and how big, over time), and at `breakAt` falls apart letter by letter — the money that
 *  was never there. Your font, colour and glow. */
export const TravellingFigure: React.FC<{ text: string; at: number; path: Array<{ t: number; x: number; y: number; size: number }>; breakAt?: number; font: string; color: string; glow: string }> = (p) => {
  const { fps } = useVideoConfig(); const t = useCurrentFrame() / fps;
  const k = interpolate(t, [p.at, p.at + 0.45], [0, 1], { ...clamp, easing: EASE_OUT });
  if (k <= 0) return null;
  const pt = (key: "x" | "y" | "size") => { const ps = p.path; if (t <= ps[0]!.t) return ps[0]![key]; for (let i = 0; i < ps.length - 1; i++) if (t <= ps[i + 1]!.t) return interpolate(t, [ps[i]!.t, ps[i + 1]!.t], [ps[i]![key], ps[i + 1]![key]], { ...clamp, easing: EASE_IN_OUT }); return ps[ps.length - 1]![key]; };
  const br = p.breakAt !== undefined ? interpolate(t, [p.breakAt, p.breakAt + 1.2], [0, 1], clamp) : 0;
  const size = pt("size");
  return <div style={{ position: "absolute", left: `${pt("x") * 100}%`, top: `${pt("y") * 100}%`, transform: "translate(-50%,-50%)", display: "flex", whiteSpace: "pre" }}>
    {p.text.split("").map((ch, i) => { const d = Math.max(0, br * 1.7 - rnd(i, 1) * 0.7);
      return <span key={i} style={{ fontFamily: p.font, fontWeight: 900, fontSize: size, color: p.color, opacity: k * (1 - Math.min(1, d)), display: "inline-block", transform: `translate(${(rnd(i, 2) - 0.5) * d * 160}px, ${d * d * 520}px) rotate(${(rnd(i, 3) - 0.5) * d * 140}deg)`, filter: `blur(${(1 - k) * 12}px)`, textShadow: `0 0 ${size * 0.3}px ${p.glow}, 0 6px 30px rgba(0,0,0,.6)` }}>{ch}</span>; })}
  </div>;
};

/** A wall of screens: every cell shows `before` (pictures or one video in the centre), then from `flipAt` the cells turn
 *  to `after` one by one from the centre out while the camera pulls back — one person everywhere, a name in every
 *  headline. `cells` 3–7 a side. */
export const ScreenWall: React.FC<{ cells?: number; before: string[]; after: string[]; centreBefore?: string; centreAfter?: string; flipAt: number; keys?: CamKey[]; afterFilter?: string; beforeFilter?: string; glow?: string }> = (p) => {
  const { fps } = useVideoConfig(); const t = useCurrentFrame() / fps;
  const n = p.cells ?? 5, w = 100 / n, gap = 0.7, mid = Math.floor(n / 2);
  const c = camAt(p.keys ?? [{ t: 0, s: 3 }, { t: p.flipAt - 0.1, s: 2.6 }, { t: p.flipAt + 1.6, s: 1.08 }], t);
  const isV = (f: string) => /\.(mp4|webm|mov)$/i.test(f);
  const pic = (f: string, filter?: string, from?: number) => isV(f) ? (from !== undefined ? <Sequence from={Math.round(from * fps)} layout="none"><OffthreadVideo src={src(f)} muted style={{ width: "100%", height: "100%", objectFit: "cover", filter }} /></Sequence> : <OffthreadVideo src={src(f)} muted style={{ width: "100%", height: "100%", objectFit: "cover", filter }} />) : <Img src={src(f)} style={{ width: "100%", height: "100%", objectFit: "cover", filter }} />;
  return <AbsoluteFill style={{ background: "#020305", transform: `scale(${c.s}) translate(${c.x}%, ${c.y}%)` }}>
    {Array.from({ length: n * n }).map((_, i) => {
      const cx = i % n, cy = Math.floor(i / n), centre = cx === mid && cy === mid;
      const flipped = t > p.flipAt + Math.hypot(cx - mid, cy - mid) * 0.18 + rnd(i, 7) * 0.15;
      const f = centre ? (flipped ? p.centreAfter ?? p.after[0]! : p.centreBefore ?? p.before[0]!) : (flipped ? p.after[Math.floor(rnd(i, 8) * p.after.length)]! : p.before[i % p.before.length]!);
      return <div key={i} style={{ position: "absolute", left: `${cx * w + gap / 2}%`, top: `${cy * w + gap / 2}%`, width: `${w - gap}%`, height: `${w - gap}%`, overflow: "hidden", background: "#0b0d10", boxShadow: `0 0 30px ${p.glow ?? "rgba(255,255,255,.08)"}` }}>
        {pic(f, flipped ? p.afterFilter : p.beforeFilter, centre && flipped ? p.flipAt : undefined)}
        <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 2px, rgba(0,0,0,0) 2px 4px)" }} />
      </div>;
    })}
  </AbsoluteFill>;
};

export { DepthPlate } from "./depth";
/**
 * The channel's caption over footage (proven by the referee, 2026-11-26: v7's highest-scoring moments were dark real
 * footage with a heavy condensed caption glowing in the picture; Juicero's lowest were app-style type and flat cards).
 * Font, colour and glow are the film's own (its world), never a fixed look. Times in seconds from the Sequence start.
 */
export const GlowCaption: React.FC<{ text: string; at?: number; until?: number; x?: number; y?: number; size?: number; font: string; weight?: number; color?: string; glow?: string; sub?: string; subFont?: string; subAt?: number; align?: "center" | "left" }> = (p) => {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  const t = f / fps, at = p.at ?? 0;
  const k = interpolate(t, [at, at + 0.45], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const g = p.until !== undefined ? interpolate(t, [p.until - 0.25, p.until], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  if (k <= 0) return null;
  const size = p.size ?? 180, glow = p.glow ?? "rgba(120,170,255,.7)";
  const ks = p.subAt !== undefined ? interpolate(t, [p.subAt, p.subAt + 0.35], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : k;
  return (
    <div style={{ position: "absolute", left: `${(p.x ?? 0.5) * 100}%`, top: `${(p.y ?? 0.5) * 100}%`, transform: `translate(${p.align === "left" ? "0" : "-50%"}, -50%) translateY(${(1 - k) * 18 - (t - at) * 3}px)`, textAlign: p.align ?? "center", opacity: g, whiteSpace: "nowrap" }}>
      <div style={{ fontFamily: p.font, fontWeight: p.weight ?? 900, fontSize: size, lineHeight: 0.9, color: p.color ?? "#ffffff", letterSpacing: `${(1 - k) * 0.35 + 0.01}em`, filter: `blur(${(1 - k) * 14}px)`, opacity: k, textShadow: `0 0 ${size * 0.3}px ${glow}, 0 0 ${size * 0.07}px ${glow}, 0 6px 30px rgba(0,0,0,.6)`, textTransform: "uppercase" }}>{p.text}</div>
      {p.sub ? <div style={{ fontFamily: p.subFont ?? p.font, fontWeight: 600, fontSize: size * 0.16, letterSpacing: "0.32em", color: p.color ?? "#ffffff", marginTop: size * 0.12, opacity: ks * 0.85, textTransform: "uppercase", textShadow: "0 2px 14px rgba(0,0,0,.95)" }}>{p.sub}</div> : null}
    </div>
  );
};
/** Footage dimmed so words read and the shot feels lit, pushing in slowly (the plate under a GlowCaption). */
export const DarkPlate: React.FC<{ src: string; video?: boolean; trim?: number; dim?: number; contrast?: number; push?: [number, number]; len?: number; pos?: string }> = (p) => {
  const f = useCurrentFrame(), { fps, durationInFrames } = useVideoConfig();
  const len = (p.len ?? durationInFrames / fps) * fps;
  const [s0, s1] = p.push ?? [1.04, 1.12];
  const sc = interpolate(f, [0, len], [s0, s1], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.sin) });
  const style: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", objectPosition: p.pos ?? "50% 50%", transform: `scale(${sc})`, filter: `brightness(${p.dim ?? 0.55}) contrast(${p.contrast ?? 1.12}) saturate(0.9)` };
  return <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>{p.video ? <OffthreadVideo src={src(p.src)} muted startFrom={Math.round((p.trim ?? 0) * fps)} style={style} /> : <Img src={src(p.src)} style={style} />}</AbsoluteFill>;
};

/**
 * Bright news or product footage as the channel shows it: being watched on a screen in a dark room (Juicero rebuild,
 * 2026-11-26: Bloomberg's squeeze test scored 3.5 full frame, 4.9 on a screen in a dark room; lab +0.4). `room` is a
 * real dark place (a still or clip of this film's own), blurred and dimmed behind the screen.
 */
export const RoomScreen: React.FC<{ src: string; video?: boolean; trim?: number; room: string; roomVideo?: boolean; glow?: string; tilt?: number }> = (p) => {
  const f = useCurrentFrame(), { fps, durationInFrames } = useVideoConfig();
  const push = interpolate(f, [0, durationInFrames], [1, 1.06], clamp);
  const fill: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  return (
    <AbsoluteFill style={{ background: "#000", perspective: 1800 }}>
      <AbsoluteFill style={{ filter: "brightness(0.35) blur(6px)", transform: `scale(${push})` }}>{p.roomVideo ? <OffthreadVideo src={src(p.room)} muted style={fill} /> : <Img src={src(p.room)} style={fill} />}</AbsoluteFill>
      <div style={{ position: "absolute", left: "15%", top: "10%", width: "68%", height: "64%", transform: `rotateY(${p.tilt ?? -14}deg) rotateX(3deg) scale(${push})`, boxShadow: `0 0 90px ${p.glow ?? "rgba(255,190,120,.3)"}, 0 50px 120px rgba(0,0,0,.9)`, border: "14px solid #0b0c0e", borderRadius: 10, overflow: "hidden" }}>
        {p.video === false ? <Img src={src(p.src)} style={{ ...fill, filter: "brightness(0.9) contrast(1.1)" }} /> : <OffthreadVideo src={src(p.src)} muted startFrom={Math.round((p.trim ?? 0) * fps)} style={{ ...fill, filter: "brightness(0.9) contrast(1.1)" }} />}
        <AbsoluteFill style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 2px, transparent 2px 4px)" }} />
      </div>
    </AbsoluteFill>
  );
};
/** A real photo as a print laid into dark footage, not full frame (Juicero rebuild: a product photo 3.2 full frame,
 *  higher as a print over the night office; v7's wanted poster among its highest moments). Put it over a DarkPlate. */
export const PhotoPrint: React.FC<{ src: string; w?: number; rot?: number; y?: number; border?: string }> = (p) => {
  const f = useCurrentFrame(), { durationInFrames } = useVideoConfig();
  const k = interpolate(f, [0, 8], [0, 1], clamp), s = interpolate(f, [0, durationInFrames], [1, 1.07], clamp);
  return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}><Img src={src(p.src)} style={{ width: `${(p.w ?? 0.46) * 100}%`, border: `12px solid ${p.border ?? "#eae6dc"}`, transform: `rotate(${p.rot ?? -4}deg) scale(${s * (0.96 + 0.04 * k)})`, opacity: k, boxShadow: "0 50px 120px rgba(0,0,0,.9)", filter: "brightness(0.85) contrast(1.08) sepia(0.12)", marginTop: `${(p.y ?? -0.08) * 100}%` }} /></AbsoluteFill>;
};

export const CRAFT_TOOLS: Record<string, string> = {
  RoomScreen: "bright news or product footage played on a screen in a dark room — the channel shows press footage as footage being watched (proven: +0.4 to +1.4 on the referee over full frame)",
  PhotoPrint: "a real photo as a print laid into dark footage instead of full frame (proven on the referee; v7's wanted poster)",
  GlowCaption: "the channel's caption over footage: heavy condensed capitals glowing in the film's own colour, a dark shadow, settling in from a blur; a mono line under it (the referee's highest-scoring moments of our films are this over dark real footage)",
  DarkPlate: "real footage dimmed and pushing in slowly, so a caption reads and the shot feels lit — the plate under a GlowCaption",
  DepthPlate: "a real still made into a 3D surface from its own depth map (tools/depth/depth.py) and filmed by a real camera: dolly, drift and orbit with true parallax and occlusion — the channel's layered photo move",
  CameraPath: "a camera move through keyframes (scale, x, y, rotation at times), eased; wraps anything; depth scales how far a layer travels",
  Parallax: "a real still made to move like a filmed shot: its background softened and its subject cut out where it stood (box from the cut-out tool), each plane on the same camera path at its own depth",
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
  BuildWords: "the line's key words, huge, building word by word on the voice out of a blur and staying (fitted to their box; your font, gradient fill and glow)",
  GradedPlate: "a performed clip filling the frame under your grade with its own bloom, pushing in; `from` dissolves a second picture in later in the shot",
  FlashCut: "a light flash carrying one picture into the next (in at the start, out at the end, short flashes inside the shot)",
  LightWash: "the frame's own light: a soft-light wash in your colour, a hot centre, edges burned down",
  LightLayer: "sparks, embers or dust filmed on black, screened over the picture",
  PlaceLine: "a place or a name as the documentary marks it: a thin rule drawing out and mono caps beside it, on the footage (never a box or a label); a second smaller line under it",
  LedBoard: "a lit information board in a dark room (a stock index, departures, a scoreboard) at an angle, glowing rows on a dot-pitch screen; one row flickers and changes on cue (a company replacing another)",
  PinnedPrint: "a real photo of a person printed and pinned into footage of a place (an evidence board, a wall) on cue, with a thread drawn to it — who is being looked at",
  LightSweep: "a beam sweeping across a print or document on a dark wall, so a still plays",
  GlitchIn: "a subject arriving out of a broken signal (RGB split, tear lines) — for a shock or a person's first appearance; never every film's opening",
  PressHeadline: "a real article screenshot laid into the shot as a lit print, a marker sweeping the words that prove the line, source and date under it",
  SignatureObject: "THIS film's one recurring object, cut out from a real photo and lit, whose screen or surface says what the story says at that moment (e.g. a terminal: APPROVED, then DECLINED); chosen from the film's own story, never reused by another film",
  TravellingFigure: "one figure on its own layer carried across several shots (arrives, rides along, falls apart at the turn) — the idea that links a sequence",
  ScreenWall: "a wall of screens whose cells turn to one person or one name from the centre out while the camera pulls back — how big someone became, or how everyone reported it",
  ZoomThrough: "wrap a built shot: it arrives out of a blurred enlarged frame and leaves into one — a picture change by moving, not a cut",
};
