import React, { useEffect, useMemo, useState } from "react";
import { ThreeCanvas } from "@remotion/three";
import { continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import helvetiker from "three/examples/fonts/helvetiker_bold.typeface.json";
import optimer from "three/examples/fonts/optimer_bold.typeface.json";
import gentilis from "three/examples/fonts/gentilis_bold.typeface.json";
import { PALETTE } from "../types";
import { TYPO } from "../thumb/tokens";

/**
 * Real 3D (Three.js inside the Remotion frame): extruded type and lit picture cards. Each element owns a small
 * canvas at its box, so 3D costs only where it is used. Everything is a pure function of the frame.
 */
const loader = new FontLoader();
const FONTS = { sans: loader.parse(helvetiker as never), humanist: loader.parse(optimer as never), serif: loader.parse(gentilis as never) };

const Lights: React.FC<{ accent: string }> = ({ accent }) => (
  <>
    <ambientLight intensity={0.55} />
    <directionalLight position={[3, 4, 6]} intensity={2.2} />
    <pointLight position={[-4, -1, 3]} intensity={30} color={accent} />
    <pointLight position={[4, 2, -2]} intensity={12} color="#ffffff" />
  </>
);

/** Extruded word: bevelled, lit by the film's accent, turning through `spin` degrees over the shot. */
export const Text3D: React.FC<{ text: string; color: string; spin: number; at: number; w: number; h: number; serif?: boolean }> = ({ text, color, spin, at, w, h, serif }) => {
  const f = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = f - Math.round(at * fps);
  const inP = spring({ frame: t, fps, config: { damping: 14, stiffness: 120, mass: 0.9 } });
  const prog = interpolate(f, [0, Math.max(1, durationInFrames - 1)], [0, 1], { extrapolateRight: "clamp" });
  const label = TYPO.casing === "upper" ? text.toUpperCase() : text;
  const geo = useMemo(() => {
    const g = new TextGeometry(label, { font: serif ? FONTS.serif : FONTS.sans, size: 1, depth: 0.32, curveSegments: 6, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.022, bevelSegments: 3 });
    g.computeBoundingBox();
    g.center();
    return g;
  }, [label, serif]);
  const bb = geo.boundingBox!;
  const width = bb.max.x - bb.min.x;
  // Fit the word to the canvas: distance so its width fills ~86 % of the view.
  const fov = 30;
  const aspect = w / h;
  const dist = (width / 2 / Math.tan(((fov * Math.PI) / 180 / 2) * 1) / aspect) * 1.18 + 0.6;
  const ry = ((-spin / 2 + spin * prog) * Math.PI) / 180;
  if (t < 0) return null;
  return (
    <ThreeCanvas width={Math.round(w)} height={Math.round(h)} camera={{ fov, position: [0, 0, dist], near: 0.1, far: 200 }} style={{ position: "absolute", inset: 0 }}>
      <Lights accent={PALETTE.accent} />
      <group rotation={[-0.12, ry, 0]} scale={0.55 + 0.45 * inP} position={[0, (1 - inP) * -0.6, 0]}>
        <mesh geometry={geo}>
          <meshStandardMaterial attach="material-0" color={color} metalness={0.55} roughness={0.28} />
          <meshStandardMaterial attach="material-1" color={PALETTE.accentDeep} metalness={0.4} roughness={0.5} />
        </mesh>
      </group>
    </ThreeCanvas>
  );
};

/** A picture as a lit card in perspective with a coloured back-light, turning through `spin` degrees. */
export const Card3D: React.FC<{ src: string; tilt: number; spin: number; at: number; w: number; h: number }> = ({ src, tilt, spin, at, w, h }) => {
  const f = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [handle] = useState(() => delayRender(`card3d ${src}`));
  useEffect(() => {
    new THREE.TextureLoader().load(
      staticFile(src),
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        setTex(t);
        continueRender(handle);
      },
      undefined,
      () => continueRender(handle),
    );
  }, [src, handle]);
  const t = f - Math.round(at * fps);
  const inP = spring({ frame: t, fps, config: { damping: 16, stiffness: 110, mass: 0.9 } });
  const prog = interpolate(f, [0, Math.max(1, durationInFrames - 1)], [0, 1], { extrapolateRight: "clamp" });
  if (!tex || t < 0) return null;
  const img = tex.image as { width: number; height: number };
  const ar = img.width / Math.max(1, img.height);
  const cw = ar >= 1 ? 2.4 : 2.4 * ar;
  const chh = ar >= 1 ? 2.4 / ar : 2.4;
  const ry = ((tilt + spin * (prog - 0.5) + (1 - inP) * 50) * Math.PI) / 180;
  return (
    <ThreeCanvas width={Math.round(w)} height={Math.round(h)} camera={{ fov: 32, position: [0, 0, 5.2], near: 0.1, far: 100 }} style={{ position: "absolute", inset: 0 }}>
      <Lights accent={PALETTE.accent} />
      <group rotation={[0.06, ry, 0.015]} position={[0, Math.sin(prog * Math.PI * 2) * 0.05, 0]} scale={0.7 + 0.3 * inP}>
        {/* Card body (gives the edge thickness), picture face, and a soft glow plane behind. */}
        <mesh position={[0, 0, -0.03]}>
          <boxGeometry args={[cw + 0.12, chh + 0.12, 0.05]} />
          <meshStandardMaterial color="#f2efe8" roughness={0.6} />
        </mesh>
        <mesh>
          <planeGeometry args={[cw, chh]} />
          <meshStandardMaterial map={tex} roughness={0.55} metalness={0.05} transparent />
        </mesh>
        <mesh position={[0, 0, -0.5]}>
          <planeGeometry args={[cw * 1.5, chh * 1.5]} />
          <meshBasicMaterial color={PALETTE.primary} transparent opacity={0.16} />
        </mesh>
      </group>
    </ThreeCanvas>
  );
};
