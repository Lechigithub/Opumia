import React from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import * as THREE from "three";
import { PALETTE } from "../types";

/**
 * Build list 5, items 10–11: the worlds a designed shot is built in, and the finish laid over every shot.
 *
 * Learned from the reference: its designed shots are almost never a plain stage. They are a REAL picture treated
 * (black and white with a colour accent, duotone), a cut-out over a burst, a collage of real pictures, a bold flat field
 * that changes with the idea, paper and print, or a terminal / UI. Everything here is deterministic: real pictures
 * through CSS/SVG filters, and designed shapes (gradients, rays, rules, scanlines). No generated imagery; a face is never
 * altered beyond a whole-picture grade.
 */
export type WorldKind = "mono_accent" | "duotone" | "burst" | "collage" | "flat_field" | "paper" | "terminal" | "filmstrip" | "contact_grid" | "split" | "gradient" | "room3d";
type Token = "primary" | "primarySoft" | "accent" | "accentDeep" | "surface" | "surfaceAlt" | "paper" | "marker" | "text" | "textMuted" | "black" | "white";
export interface WorldSpec { kind: WorldKind; slot?: number; slots?: number[]; color?: Token; accent?: Token }
export interface FinishSpec { grain?: number; vignette?: number; leak?: number; halftone?: number }

export const tokenColor = (t: Token | undefined, d: string): string =>
  t === "black" ? "#0a0a0a" : t === "white" ? "#f5f3ee" : t ? ((PALETTE as unknown as Record<string, string>)[t] ?? d) : d;

const hexRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** A stable id per shot so SVG filters of two scenes on screen together never collide. */
const useId = (kind: string) => `w${kind}${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;

/** Duotone: shadows in one colour, highlights in another (a real picture through a colour-table filter). */
const DuotoneFilter: React.FC<{ id: string; dark: string; light: string }> = ({ id, dark, light }) => {
  const [d, l] = [hexRgb(dark), hexRgb(light)];
  return (
    <svg width={0} height={0} style={{ position: "absolute" }}>
      <filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={`${d[0]} ${l[0]}`} />
          <feFuncG type="table" tableValues={`${d[1]} ${l[1]}`} />
          <feFuncB type="table" tableValues={`${d[2]} ${l[2]}`} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
};

/** A lit 3D room: floor, back wall carrying the real picture, a side wall; the camera dollies in. */
const Room3D: React.FC<{ src?: string; accent: string; base: string; t: number; w: number; h: number }> = ({ src, accent, base, t, w, h }) => {
  const [tex, setTex] = React.useState<THREE.Texture | null>(null);
  const [handle] = React.useState(() => (src ? delayRender(`room3d ${src}`) : null));
  React.useEffect(() => {
    if (!src || handle === null) return;
    new THREE.TextureLoader().load(staticFile(src), (x) => { x.colorSpace = THREE.SRGBColorSpace; setTex(x); continueRender(handle); }, undefined, () => continueRender(handle));
  }, [src, handle]);
  return (
    <ThreeCanvas width={w} height={h} camera={{ fov: 42, position: [0, 2.05, 6.2 - 2.2 * t], near: 0.1, far: 60 }} style={{ position: "absolute", inset: 0 }}>
      <ambientLight intensity={0.35} />
      <spotLight position={[0, 5, 4]} angle={0.7} penumbra={0.6} intensity={60} />
      <pointLight position={[-3, 2, 1]} intensity={14} color={accent} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}><planeGeometry args={[14, 14]} /><meshStandardMaterial color="#1a1714" roughness={0.85} /></mesh>
      <mesh position={[0, 2.2, -3]}><planeGeometry args={[14, 6]} /><meshStandardMaterial color={base} roughness={0.9} /></mesh>
      <mesh position={[-4.5, 2.2, 0]} rotation={[0, Math.PI / 2, 0]}><planeGeometry args={[8, 6]} /><meshStandardMaterial color="#26221d" roughness={0.9} /></mesh>
      {tex ? <mesh position={[0, 2.1, -2.95]}><planeGeometry args={[3.6, 2.25]} /><meshStandardMaterial map={tex} roughness={0.6} /></mesh> : null}
      <mesh position={[0, 2.1, -2.97]}><planeGeometry args={[3.8, 2.45]} /><meshStandardMaterial color="#0d0c0b" /></mesh>
    </ThreeCanvas>
  );
};

const Picture: React.FC<{ src: string; filter?: string; scale?: number; style?: React.CSSProperties }> = ({ src, filter, scale = 1, style }) => (
  <Img src={staticFile(src)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter, transform: `scale(${scale})`, ...style }} />
);

export const World: React.FC<{ world: WorldSpec; slots: Record<string, string> }> = ({ world, slots }) => {
  const f = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const t = interpolate(f, [0, Math.max(1, durationInFrames - 1)], [0, 1], { extrapolateRight: "clamp" });
  const base = tokenColor(world.color, PALETTE.primary);
  const acc = tokenColor(world.accent, PALETTE.accent);
  const id = useId(world.kind);
  const src = world.slot !== undefined ? slots[String(world.slot)] : undefined;
  const drift = 1.04 + 0.05 * t;
  switch (world.kind) {
    case "mono_accent":
      // a real picture in black and white, with one bar of the accent colour cutting through it
      return (
        <AbsoluteFill style={{ background: "#111" }}>
          {src ? <Picture src={src} filter="grayscale(1) contrast(1.25) brightness(0.82)" scale={drift} /> : null}
          <AbsoluteFill style={{ background: `linear-gradient(90deg, transparent 0%, transparent 62%, ${acc} 62%, ${acc} 70%, transparent 70%)`, mixBlendMode: "multiply", opacity: 0.9, transform: `translateX(${(t - 0.5) * 40}px)` }} />
          <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)` }} />
        </AbsoluteFill>
      );
    case "duotone":
      return (
        <AbsoluteFill style={{ background: base }}>
          <DuotoneFilter id={id} dark={base} light={acc} />
          {src ? <Picture src={src} filter={`url(#${id}) contrast(1.1)`} scale={drift} /> : null}
        </AbsoluteFill>
      );
    case "burst": {
      // rays turning slowly behind the subject (the designer places the cut-out over it)
      const rays = 18;
      const stops = Array.from({ length: rays }, (_, k) => `${k % 2 ? acc : base} ${(k / rays) * 360}deg ${((k + 1) / rays) * 360}deg`).join(", ");
      return (
        <AbsoluteFill style={{ background: base, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: width / 2 - width, top: height / 2 - width, width: width * 2, height: width * 2, background: `conic-gradient(from ${t * 25}deg, ${stops})`, opacity: 0.85 }} />
          <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 50%, rgba(255,255,255,0.28) 0%, transparent 38%, rgba(0,0,0,0.5) 100%)` }} />
        </AbsoluteFill>
      );
    }
    case "collage": {
      const list = [world.slot, ...(world.slots ?? [])].filter((s): s is number => s !== undefined).map((s) => slots[String(s)]).filter((s): s is string => Boolean(s)).slice(0, 5);
      const cells = [
        { x: 0.04, y: 0.08, w: 0.42, r: -4 }, { x: 0.5, y: 0.05, w: 0.44, r: 3 }, { x: 0.12, y: 0.5, w: 0.38, r: 2 }, { x: 0.55, y: 0.48, w: 0.4, r: -3 }, { x: 0.33, y: 0.28, w: 0.34, r: 1 },
      ];
      return (
        <AbsoluteFill style={{ background: tokenColor("paper", "#e9e4d8") }}>
          <PaperGrain />
          {list.map((s, k) => {
            const c = cells[k]!;
            return (
              <div key={k} style={{ position: "absolute", left: c.x * width + Math.sin(f / 40 + k) * 4, top: c.y * height, width: c.w * width, height: c.w * width * 0.62, transform: `rotate(${c.r + Math.sin(f / 60 + k) * 0.4}deg)`, background: "#f7f4ec", padding: width * 0.006, boxShadow: "0 14px 30px rgba(0,0,0,0.45)" }}>
                <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
                  <Picture src={s} filter={k % 2 ? "grayscale(1) contrast(1.15)" : "saturate(0.85) contrast(1.05)"} scale={1.02 + 0.03 * t} />
                </div>
              </div>
            );
          })}
        </AbsoluteFill>
      );
    }
    case "filmstrip": {
      // craft inventory: the channel's filmstrip / contact sheet — real pictures as frames on a strip with sprocket
      // holes, sliding frame to frame
      const list = [world.slot, ...(world.slots ?? [])].filter((s): s is number => s !== undefined).map((s) => slots[String(s)]).filter((s): s is string => Boolean(s)).slice(0, 5);
      const fw = width * 0.46;
      const fh = fw * 0.62;
      const gap = width * 0.05;
      const slide = -t * Math.max(0, list.length - 1.6) * (fw + gap);
      const holes = Array.from({ length: Math.ceil(width / 40) + 4 }, (_, k) => k);
      return (
        <AbsoluteFill style={{ background: "#0c0b09" }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: height / 2 - fh / 2 - height * 0.07, height: fh + height * 0.14, background: "#16130f" }}>
            {[0, 1].map((row) => (
              <div key={row} style={{ position: "absolute", left: (slide % 40) - 40, top: row ? undefined : height * 0.02, bottom: row ? height * 0.02 : undefined, display: "flex", gap: 22 }}>
                {holes.map((k) => <div key={k} style={{ width: 18, height: height * 0.028, borderRadius: 3, background: "#e9e1cf", opacity: 0.85 }} />)}
              </div>
            ))}
            {list.map((s, k) => (
              <div key={k} style={{ position: "absolute", top: height * 0.07, left: width * 0.27 + k * (fw + gap) + slide, width: fw, height: fh, overflow: "hidden", border: "3px solid #2a241c" }}>
                <Picture src={s} filter={k % 2 ? "grayscale(1) contrast(1.2)" : "sepia(0.35) contrast(1.1)"} scale={1.03} />
              </div>
            ))}
          </div>
        </AbsoluteFill>
      );
    }
    case "contact_grid": {
      // craft inventory: the channel's contact-sheet grid — rounded cells with thick grout, neighbours cut off at the
      // frame edges, the grid sliding so the next cell comes to the centre
      const list = [world.slot, ...(world.slots ?? [])].filter((s): s is number => s !== undefined).map((s) => slots[String(s)]).filter((s): s is string => Boolean(s));
      if (!list.length) return <AbsoluteFill style={{ background: base }} />;
      const cw = width * 0.38, ch = cw * 0.62, g = width * 0.03;
      const cols = 5, rows = 4;
      const ox = width / 2 - cw / 2 - t * (cw + g) * Math.min(1.5, list.length - 1), oy = height / 2 - ch / 2 - (ch + g);
      return (
        <AbsoluteFill style={{ background: "#d9d3c7" }}>
          {Array.from({ length: cols * rows }, (_, k) => {
            const c = (k % cols) - 1, r = Math.floor(k / cols);
            const s = list[(k + Math.floor(k / cols)) % list.length]!;
            const centre = r === 1 && c >= 0;
            return (
              <div key={k} style={{ position: "absolute", left: ox + c * (cw + g), top: oy + r * (ch + g), width: cw, height: ch, borderRadius: width * 0.012, overflow: "hidden", boxShadow: "0 6px 18px rgba(0,0,0,0.25)" }}>
                <Picture src={s} filter={centre ? "contrast(1.08)" : "grayscale(0.6) brightness(0.8)"} scale={1.04} />
              </div>
            );
          })}
        </AbsoluteFill>
      );
    }
    case "split": {
      // craft inventory: split screen — two real pictures side by side, a bar between them (a paired contrast)
      const a = world.slot !== undefined ? slots[String(world.slot)] : undefined;
      const b = (world.slots ?? []).map((s) => slots[String(s)]).find(Boolean);
      const open = interpolate(f, [0, 12], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
      return (
        <AbsoluteFill style={{ background: "#0b0b0b" }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: width / 2 - 4, height, overflow: "hidden", transform: `translateX(${(open - 1) * width * 0.2}px)` }}>{a ? <Picture src={a} filter="contrast(1.08)" scale={drift} /> : null}</div>
          <div style={{ position: "absolute", left: width / 2 + 4, top: 0, width: width / 2 - 4, height, overflow: "hidden", transform: `translateX(${(1 - open) * width * 0.2}px)` }}>{b ? <Picture src={b} filter="contrast(1.08)" scale={drift} /> : null}</div>
          <div style={{ position: "absolute", left: width / 2 - 4, top: 0, width: 8, height: height * open, background: acc }} />
        </AbsoluteFill>
      );
    }
    case "gradient":
      // craft inventory: a stylised gradient / nebula ground, a real picture as a dark silhouette skyline along its foot
      return (
        <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${30 + 30 * t}% 30%, ${acc} 0%, transparent 45%), radial-gradient(ellipse at 75% 70%, ${base} 0%, transparent 60%), linear-gradient(180deg, #07060d 0%, ${base} 120%)` }}>
          {src ? <Picture src={src} filter="grayscale(1) contrast(4) brightness(0.18)" style={{ top: "auto", height: "38%", bottom: 0 }} scale={1.02} /> : null}
        </AbsoluteFill>
      );
    case "room3d":
      // craft inventory: a built 3D set (Three.js): the real picture on the back wall of a lit room, the camera dollying in
      return <Room3D src={src} accent={acc} base={base} t={t} w={width} h={height} />;
    case "flat_field":
      // one bold colour field with a soft light falling across it — it changes with the idea (the colour is per shot)
      return (
        <AbsoluteFill style={{ background: base }}>
          <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${30 + 40 * t}% 35%, rgba(255,255,255,0.22) 0%, transparent 55%), linear-gradient(160deg, transparent 50%, rgba(0,0,0,0.35) 100%)` }} />
          <AbsoluteFill style={{ background: `linear-gradient(90deg, ${acc} 0, ${acc} ${width * 0.012}px, transparent ${width * 0.012}px)` }} />
        </AbsoluteFill>
      );
    case "paper":
      return (
        <AbsoluteFill style={{ background: tokenColor("paper", "#ece5d3") }}>
          <PaperGrain strong />
          {src ? <Picture src={src} filter="grayscale(1) contrast(1.3) sepia(0.25)" style={{ mixBlendMode: "multiply", opacity: 0.85 }} scale={drift} /> : null}
          <AbsoluteFill style={{ background: `repeating-linear-gradient(180deg, transparent 0, transparent ${height / 28 - 1}px, rgba(60,40,20,0.07) ${height / 28 - 1}px, rgba(60,40,20,0.07) ${height / 28}px)` }} />
          <AbsoluteFill style={{ boxShadow: `inset 0 0 ${width * 0.08}px rgba(80,50,20,0.45)` }} />
        </AbsoluteFill>
      );
    case "terminal": {
      const pad = width * 0.05;
      return (
        <AbsoluteFill style={{ background: "#07090b" }}>
          <div style={{ position: "absolute", left: pad, top: pad, right: pad, bottom: pad, border: `2px solid ${acc}`, borderRadius: width * 0.008, background: "rgba(10,18,14,0.96)", overflow: "hidden" }}>
            <div style={{ height: height * 0.05, borderBottom: `2px solid ${acc}`, display: "flex", alignItems: "center", gap: width * 0.008, paddingLeft: width * 0.012 }}>
              {[0, 1, 2].map((k) => <div key={k} style={{ width: height * 0.018, height: height * 0.018, borderRadius: "50%", background: k === 0 ? acc : "rgba(255,255,255,0.25)" }} />)}
            </div>
            {src ? <Picture src={src} filter="grayscale(1) contrast(1.4) brightness(0.55)" style={{ top: height * 0.05, mixBlendMode: "screen", opacity: 0.55 }} /> : null}
            <AbsoluteFill style={{ background: `repeating-linear-gradient(0deg, rgba(0,0,0,0) 0, rgba(0,0,0,0) 2px, rgba(0,0,0,0.28) 3px)` }} />
            <AbsoluteFill style={{ background: `linear-gradient(90deg, ${acc}22 1px, transparent 1px), linear-gradient(0deg, ${acc}22 1px, transparent 1px)`, backgroundSize: `${width / 24}px ${width / 24}px`, opacity: 0.6 }} />
          </div>
        </AbsoluteFill>
      );
    }
  }
};

/** Fine paper fibre and dust (SVG noise, deterministic). */
const PaperGrain: React.FC<{ strong?: boolean }> = ({ strong }) => {
  const id = useId("paper");
  return (
    <AbsoluteFill style={{ opacity: strong ? 0.5 : 0.3, mixBlendMode: "multiply" }}>
      <svg width="100%" height="100%">
        <filter id={id}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={3} seed={7} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.35  0 0 0 0 0.22  0 0 0 0.55 0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${id})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** The finish over the whole shot: film grain (changes every frame), vignette, a light leak sweeping across. */
export const Finish: React.FC<{ finish: FinishSpec }> = ({ finish }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const id = useId("grain");
  const t = interpolate(f, [0, Math.max(1, durationInFrames - 1)], [0, 1], { extrapolateRight: "clamp" });
  const g = Math.max(0, Math.min(1, finish.grain ?? 0));
  const v = Math.max(0, Math.min(1, finish.vignette ?? 0));
  const l = Math.max(0, Math.min(1, finish.leak ?? 0));
  const ht = Math.max(0, Math.min(1, finish.halftone ?? 0));
  return (
    <>
      {ht > 0 ? <AbsoluteFill style={{ background: "radial-gradient(circle, rgba(0,0,0,0.55) 30%, transparent 32%)", backgroundSize: "7px 7px", mixBlendMode: "multiply", opacity: 0.25 + 0.5 * ht, pointerEvents: "none" }} /> : null}
      {g > 0 ? (
        <AbsoluteFill style={{ opacity: 0.12 + 0.35 * g, mixBlendMode: "overlay", pointerEvents: "none" }}>
          <svg width="100%" height="100%">
            <filter id={id}>
              <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={f % 23} />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter={`url(#${id})`} />
          </svg>
        </AbsoluteFill>
      ) : null}
      {v > 0 ? <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent ${55 - 20 * v}%, rgba(0,0,0,${0.35 + 0.45 * v}) 100%)`, pointerEvents: "none" }} /> : null}
      {l > 0 ? <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${-10 + 120 * t}% 30%, rgba(255,170,80,${0.45 * l}) 0%, rgba(255,90,40,${0.2 * l}) 25%, transparent 55%)`, mixBlendMode: "screen", pointerEvents: "none" }} /> : null}
    </>
  );
};

/** A placed picture's own grade (photo elements). */
export const gradeFilter = (g: string | undefined): string | undefined =>
  // craft inventory: the channel's high-contrast black and white, a split tone (cool shadows, warm light), a negative,
  // and a low-key moody grade
  g === "warm_glow" ? "sepia(0.25) saturate(1.35) brightness(1.12) contrast(0.95)" : g === "thermal" ? "grayscale(1) invert(1) sepia(1) saturate(6) hue-rotate(-50deg) contrast(1.4)" : g === "solarise" ? "contrast(2.1) saturate(1.5) invert(0.2) brightness(1.1)" :
  g === "contrast_bw" ? "grayscale(1) contrast(1.55) brightness(0.95)" : g === "split" ? "sepia(0.35) hue-rotate(-12deg) saturate(1.3) contrast(1.15)" : g === "invert" ? "invert(1) hue-rotate(180deg) contrast(1.1)" : g === "lowkey" ? "saturate(0.6) contrast(1.35) brightness(0.72)" :
  g === "mono" ? "grayscale(1) contrast(1.12)" : g === "duotone" ? "grayscale(1) sepia(0.6) hue-rotate(160deg) saturate(1.6) contrast(1.1)" : g === "punch" ? "contrast(1.22) saturate(1.25)" : g === "sepia" ? "sepia(0.75) contrast(1.08)" : undefined;
