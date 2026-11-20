import React from "react";
import { AbsoluteFill, Img, interpolate, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import type { Layer } from "../types";

/** Interpolate the manifest keyframes (scale, x, y, opacity) at the local frame. */
export function useKeyframes(layer: Layer) {
  const f = useCurrentFrame();
  const k = layer.keyframes;
  if (!k.length) return { scale: 1, x: 0, y: 0, opacity: 1 };
  const frames = k.map((x) => x.frame);
  const at = (key: "scale" | "x" | "y" | "opacity") =>
    k.length === 1 ? k[0]![key] : interpolate(f, frames, k.map((x) => x[key]), { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  return { scale: at("scale"), x: at("x"), y: at("y"), opacity: at("opacity") };
}

/** Entry transition for a shot (fade, dip to black, whip, light-leak flash). */
export function useTransitionIn(kind: string | undefined) {
  const f = useCurrentFrame();
  switch (kind) {
    case "fade":
      return { opacity: interpolate(f, [0, 8], [0, 1], { extrapolateRight: "clamp" }), blur: 0, dx: 0, flash: 0 };
    case "dip_black":
      return { opacity: interpolate(f, [0, 6], [0, 1], { extrapolateRight: "clamp" }), blur: 0, dx: 0, flash: 0 };
    case "whip":
      return { opacity: 1, blur: interpolate(f, [0, 6], [24, 0], { extrapolateRight: "clamp" }), dx: interpolate(f, [0, 6], [0.25, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }), flash: 0 };
    case "light_leak":
      return { opacity: 1, blur: 0, dx: 0, flash: interpolate(f, [0, 3, 12], [0.9, 0.6, 0], { extrapolateRight: "clamp" }) };
    default:
      return { opacity: 1, blur: 0, dx: 0, flash: 0 };
  }
}

const Source: React.FC<{ src: string; kind: string; focus: [number, number]; fit?: "cover" | "contain"; style?: React.CSSProperties }> = ({ src, kind, focus, fit = "cover", style }) => {
  const s: React.CSSProperties = { width: "100%", height: "100%", objectFit: fit, objectPosition: `${focus[0] * 100}% ${focus[1] * 100}%`, ...style };
  return kind === "video" ? <OffthreadVideo src={staticFile(src)} muted style={s} /> : <Img src={staticFile(src)} style={s} />;
};

/**
 * B-roll / photo layer with camera drift (keyframed scale + translate), entry transition,
 * and two treatments: "cover" (full-bleed) and "parallax_card" (2.5D archival card).
 */
export const MediaLayer: React.FC<{ layer: Layer }> = ({ layer }) => {
  const { width, height } = useVideoConfig();
  const f = useCurrentFrame();
  const p = (layer.props ?? {}) as { kind?: string; mode?: string; focus?: [number, number]; transitionIn?: string; dim?: number; dimUntil?: number; period?: boolean; citation?: string };
  const cam = useKeyframes(layer);
  const tr = useTransitionIn(p.transitionIn);
  const focus = p.focus ?? [0.5, 0.5];
  const src = layer.src ?? "";
  const kind = p.kind ?? "video";
  const dur = layer.endFrame - layer.startFrame;

  if (p.mode === "parallax_card") {
    // 2.5D: blurred, slow background plate + a tilted photo card moving faster in front.
    const t = dur > 1 ? f / (dur - 1) : 0;
    const rot = interpolate(t, [0, 1], [-7, 5]);
    const cardScale = interpolate(t, [0, 1], [0.94, 1.02]);
    const portrait = height > width;
    const cardW = portrait ? width * 0.86 : width * 0.62;
    const cardH = portrait ? height * 0.42 : height * 0.74;
    return (
      <AbsoluteFill style={{ backgroundColor: "#0b0b0b", opacity: tr.opacity }}>
        <AbsoluteFill style={{ transform: `scale(${1.25 + 0.06 * t}) translateX(${(t - 0.5) * -2}%)`, filter: "blur(28px) brightness(0.45) saturate(0.8)" }}>
          <Source src={src} kind={kind} focus={focus} />
        </AbsoluteFill>
        <AbsoluteFill style={{ perspective: 1400, alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              width: cardW,
              height: cardH,
              transform: `translateX(${(cam.x + tr.dx) * width}px) translateY(${cam.y * height - (portrait ? height * 0.07 : 0)}px) rotateY(${rot}deg) rotateX(${2 - 3 * t}deg) scale(${cardScale * cam.scale})`,
              boxShadow: "0 50px 110px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.3), 0 0 60px rgba(220,38,38,0.18)",
              border: "14px solid #f2ede2",
              borderBottomWidth: 46,
              backgroundColor: "#f2ede2",
              filter: p.period ? "sepia(0.25) contrast(1.05)" : undefined,
            }}
          >
            <Source src={src} kind={kind} focus={focus} fit={p.citation ? "contain" : "cover"} style={p.citation ? { backgroundColor: "#1b1a17" } : undefined} />
            {p.citation ? (
              <div style={{ position: "absolute", left: 0, right: 0, bottom: -40, height: 40, display: "flex", alignItems: "center", padding: "0 10px", fontFamily: "Helvetica Neue, Arial, sans-serif", fontSize: portrait ? 17 : 15, color: "#3b362c", letterSpacing: 0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {"\u{1F4F7}\u{FE0E} "}{p.citation}
              </div>
            ) : null}
          </div>
        </AbsoluteFill>
        {tr.flash > 0 ? <AbsoluteFill style={{ background: "radial-gradient(circle at 30% 40%, #ffd28a, #ff7a1a 45%, transparent 75%)", mixBlendMode: "screen", opacity: tr.flash }} /> : null}
      </AbsoluteFill>
    );
  }

  const dimK = p.dim ? (p.dimUntil !== undefined ? interpolate(f, [p.dimUntil, p.dimUntil + 8], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1) : 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity: tr.opacity * cam.opacity, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translate(${(cam.x + tr.dx) * width}px, ${cam.y * height}px) scale(${cam.scale})`,
          // dimUntil: the plate clears (blur + darkening ease out over 8 frames) once a capped kinetic card ends.
          // Behind a designed element the plate stays SHARP and is only graded darker (reference luma ≈ 0.28).
          filter: [tr.blur ? `blur(${tr.blur}px)` : "", dimK > 0.01 ? `brightness(${(1 - (p.dim ?? 0) * 0.5 * dimK).toFixed(3)}) contrast(1.06)` : ""].filter(Boolean).join(" ") || undefined,
        }}
      >
        <Source src={src} kind={kind} focus={focus} />
      </AbsoluteFill>
      {tr.flash > 0 ? <AbsoluteFill style={{ background: "radial-gradient(circle at 30% 40%, #ffd28a, #ff7a1a 45%, transparent 75%)", mixBlendMode: "screen", opacity: tr.flash }} /> : null}
    </AbsoluteFill>
  );
};

/** Texture overlay (light leak, dust, film burn) blended over the shot. */
export const OverlayLayer: React.FC<{ layer: Layer }> = ({ layer }) => {
  const p = (layer.props ?? {}) as { kind?: string; opacity?: number };
  const blend = layer.blend === "normal" ? "normal" : layer.blend;
  return (
    <AbsoluteFill style={{ mixBlendMode: blend as React.CSSProperties["mixBlendMode"], opacity: p.opacity ?? 0.55, pointerEvents: "none" }}>
      <Source src={layer.src ?? ""} kind={p.kind ?? "video"} focus={[0.5, 0.5]} />
    </AbsoluteFill>
  );
};
