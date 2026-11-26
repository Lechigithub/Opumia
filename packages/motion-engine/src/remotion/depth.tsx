/**
 * DepthPlate (build list 6, F1): a real still made into a 3D surface and filmed by a real camera. The picture is a dense
 * plane whose every vertex is pushed toward the camera by the still's own depth map (tools/depth/depth.py, Depth Anything
 * V2, local), so a dolly, drift or orbit shows true parallax and occlusion — the channel's layered 2.5D photo move, not
 * a zoom on a flat picture. A plain building block: the grade, type and look stay the film's own.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { camAt, type CamKey } from "./craft";

const src = (s: string) => (/^(https?:|data:|\/)/.test(s) ? s : staticFile(s));
const VERT = `uniform sampler2D dmap; uniform float k; varying vec2 vUv;
void main() { vUv = uv; float d = texture2D(dmap, uv).r; vec3 p = position + vec3(0.0, 0.0, d * k);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`;
const FRAG = `uniform sampler2D map; uniform float dim; varying vec2 vUv;
void main() { vec4 c = texture2D(map, vUv); gl_FragColor = vec4(c.rgb * dim, 1.0); }`;

function useTex(path: string) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [h] = useState(() => delayRender(`depth texture ${path}`));
  useEffect(() => {
    new THREE.TextureLoader().load(src(path), (t) => { t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; setTex(t); continueRender(h); }, undefined, () => continueRender(h));
  }, [path, h]);
  return tex;
}

const Rig: React.FC<{ keys: CamKey[]; dist: number; planeW: number; planeH: number }> = ({ keys, dist, planeW, planeH }) => {
  const { camera } = useThree(); const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const c = camAt(keys, f / fps);
  camera.position.set(c.x * planeW * 0.5, -c.y * planeH * 0.5, dist / Math.max(0.2, c.s));
  camera.lookAt(c.x * planeW * 0.35, -c.y * planeH * 0.35, 0);
  camera.rotateZ((c.r * Math.PI) / 180);
  return null;
};

export const DepthPlate: React.FC<{ image: string; depth: string; aspect: number; keys: CamKey[]; strength?: number; dim?: number; fov?: number }> = (p) => {
  const { width: W, height: H } = useVideoConfig();
  const map = useTex(p.image), dmap = useTex(p.depth);
  const fov = p.fov ?? 36, frameAspect = W / H;
  // the plane covers the frame from the camera's farthest point with room to travel
  const planeH = 2, planeW = planeH * p.aspect;
  const coverH = p.aspect >= frameAspect ? planeH : planeW / frameAspect;
  const dist = (coverH / 2 / Math.tan(((fov / 2) * Math.PI) / 180)) * 0.86;
  const uniforms = useMemo(() => ({ map: { value: null as THREE.Texture | null }, dmap: { value: null as THREE.Texture | null }, k: { value: (p.strength ?? 0.35) * planeH }, dim: { value: p.dim ?? 1 } }), [p.strength, p.dim]);
  uniforms.map.value = map; uniforms.dmap.value = dmap;
  if (!map || !dmap) return null;
  return <ThreeCanvas width={W} height={H} camera={{ fov, position: [0, 0, dist], near: 0.01, far: 100 }} style={{ position: "absolute", inset: 0 }}>
    <Rig keys={p.keys} dist={dist} planeW={planeW} planeH={planeH} />
    <mesh>
      <planeGeometry args={[planeW, planeH, 320, Math.round(320 / p.aspect)]} />
      <shaderMaterial vertexShader={VERT} fragmentShader={FRAG} uniforms={uniforms} />
    </mesh>
  </ThreeCanvas>;
};
