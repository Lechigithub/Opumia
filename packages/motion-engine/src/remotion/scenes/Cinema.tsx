import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Finishing primitives: animated film grain and edge vignette (strengths from the film's design tokens) and a
 * continuous camera push. All deterministic per frame.
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