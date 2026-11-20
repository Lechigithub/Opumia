import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from "remotion";
import { PALETTE } from "../types";

/**
 * Cinema finishing primitives shared by every scene: animated film grain, edge vignette, accent light,
 * a moving light sweep, and a continuous camera push. All deterministic per frame.
 */

/** Real animated grain: SVG fractal noise re-seeded every 2 frames, overlay-blended. */
export const FilmGrain: React.FC<{ opacity?: number }> = ({ opacity = 0.14 }) => {
  const f = useCurrentFrame();
  const seed = Math.floor(f / 2) % 24;
  const dx = Math.round(random(`gx${seed}`) * 60);
  const dy = Math.round(random(`gy${seed}`) * 60);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity }}>
      <svg width="100%" height="100%" style={{ transform: `translate(${-dx}px, ${-dy}px)`, width: "calc(100% + 60px)", height: "calc(100% + 60px)" }}>
        <filter id={`grain${seed}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={seed} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** Edge vignette with a slow breathing intensity. */
export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.7 }) => {
  const f = useCurrentFrame();
  const b = strength * (0.94 + 0.06 * Math.sin(f / 37));
  return <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(ellipse 75% 70% at 50% 48%, transparent 45%, rgba(0,0,0,${(b * 0.55).toFixed(3)}) 78%, rgba(0,0,0,${b.toFixed(3)}) 100%)` }} />;
};

/** Soft coloured light pooled in one corner (crimson or gold), drifting slowly. */
export const AccentLight: React.FC<{ color?: string; at?: [number, number]; intensity?: number }> = ({ color = PALETTE.crimson, at = [0.18, 0.2], intensity = 0.35 }) => {
  const f = useCurrentFrame();
  const x = at[0] * 100 + Math.sin(f / 50) * 4;
  const y = at[1] * 100 + Math.cos(f / 63) * 3;
  return <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen", opacity: intensity, background: `radial-gradient(circle at ${x}% ${y}%, ${color} 0%, transparent 42%)` }} />;
};

/** A diagonal light sweep that crosses the frame once over `periodFrames`. */
export const LightSweep: React.FC<{ delay?: number; periodFrames?: number; opacity?: number }> = ({ delay = 6, periodFrames = 50, opacity = 0.22 }) => {
  const f = useCurrentFrame();
  const p = interpolate(f - delay, [0, periodFrames], [-0.4, 1.4], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (p <= -0.4 || p >= 1.4) return null;
  return <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen", opacity, background: `linear-gradient(115deg, transparent ${(p - 0.12) * 100}%, rgba(255,255,255,0.9) ${p * 100}%, transparent ${(p + 0.12) * 100}%)` }} />;
};

/** Continuous camera: push 1.0 → `to` across the layer with a gentle lateral drift and micro-rotation. */
export const CameraPush: React.FC<{ to?: number; drift?: number; children: React.ReactNode }> = ({ to = 1.06, drift = 0.012, children }) => {
  const f = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  const t = durationInFrames > 1 ? f / (durationInFrames - 1) : 0;
  const ease = t * t * (3 - 2 * t);
  const s = 1 + (to - 1) * ease;
  const x = (ease - 0.5) * drift * width;
  const r = (ease - 0.5) * 0.4;
  return <AbsoluteFill style={{ transform: `translateX(${x}px) scale(${s}) rotate(${r}deg)`, transformOrigin: "50% 50%" }}>{children}</AbsoluteFill>;
};

/**
 * Procedural atmosphere when no footage plate may be used (lines naming a person): a lit, textured backdrop —
 * smoky crimson/steel light pools that drift, a moving grid and slow light streaks. Never reads as black.
 */
export const Atmosphere: React.FC<{ tint?: string }> = ({ tint = PALETTE.crimsonDeep }) => {
  const f = useCurrentFrame();
  const a = 50 + Math.sin(f / 45) * 12;
  const b = 40 + Math.cos(f / 57) * 10;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${a}% ${b}%, ${tint} 0%, #2a0d10 30%, #11151f 62%, #0b0d13 100%)` }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${100 - a}% ${100 - b}%, rgba(80,110,160,0.45), transparent 45%)`, mixBlendMode: "screen" }} />
      <AbsoluteFill style={{ opacity: 0.16, backgroundImage: "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)", backgroundSize: "80px 80px", transform: `perspective(800px) rotateX(55deg) translateY(${(f * 0.8) % 80}px) scale(2)`, transformOrigin: "50% 100%" }} />
      <AbsoluteFill style={{ opacity: 0.22, background: `repeating-linear-gradient(115deg, transparent 0 180px, rgba(255,210,170,0.35) 200px, transparent 230px)`, transform: `translateX(${((f * 2) % 460) - 230}px)`, mixBlendMode: "screen" }} />
    </AbsoluteFill>
  );
};
