// TEST FIXTURE for apps/cli/src/dev/smoke.ts only (copied into out/_smoke/design/film/): a minimal film kit that plays every role, so the offline smoke
// render can exercise the engine (stage, scenes, chart, map, document, chapter, transition) without an art director.
// It is never used for a film: every film's kit is written for that film by its art director.
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

type P = Record<string, unknown>;
const INK = "#101418", PAPER = "#efe9dc", HOT = "#e0483a", SOFT = "#9fb4c7";
const FONT = "Georgia, serif";
const arrive = (f: number, fps: number) => spring({ frame: f, fps, config: { damping: 16 } });

const Headline: React.FC<P> = (p) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig(); const s = arrive(f, fps);
  return <div style={{ fontFamily: FONT, fontSize: 96, fontWeight: 700, color: PAPER, opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>{String(p.text ?? "")}</div>;
};
const Phrase: React.FC<P> = (p) => {
  const f = useCurrentFrame();
  const words = (p.words as Array<{ text: string; from: number }> | undefined) ?? String(p.text ?? "").split(" ").map((text, i) => ({ text, from: i * 5 }));
  return <div style={{ fontFamily: FONT, fontSize: 64, color: PAPER }}>{words.map((w, i) => <span key={i} style={{ opacity: f >= w.from ? 1 : 0, marginRight: 16 }}>{w.text}</span>)}</div>;
};
const Label: React.FC<P> = (p) => <div style={{ fontFamily: FONT, fontSize: 40, color: INK, background: PAPER, padding: "8px 18px", display: "inline-block" }}>{String(p.text ?? "")}{p.sub ? <div style={{ fontSize: 26 }}>{String(p.sub)}</div> : null}</div>;
const NumberC: React.FC<P> = (p) => <div style={{ fontFamily: FONT, fontSize: 140, color: HOT }}>{String(p.value ?? "")}<div style={{ fontSize: 34, color: PAPER }}>{String(p.label ?? "")}</div></div>;
const Quote: React.FC<P> = (p) => <div style={{ fontFamily: FONT, fontSize: 56, color: PAPER, fontStyle: "italic" }}>“{String(p.text ?? "")}”<div style={{ fontSize: 30 }}>— {String(p.by ?? "")}</div></div>;
const Chapter: React.FC<P> = (p) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: INK, alignItems: "center", justifyContent: "center", opacity: interpolate(f, [0, 6], [0, 1], { extrapolateRight: "clamp" }) }}><div style={{ fontFamily: FONT, fontSize: 110, color: PAPER }}>{String(p.title ?? "")}</div></AbsoluteFill>;
};
const Stage: React.FC<P> = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: `radial-gradient(ellipse at ${40 + Math.sin(f / 40) * 8}% 40%, #26323d, ${INK} 80%)` }} />;
};
const Chart: React.FC<P> = (p) => {
  const f = useCurrentFrame(); const { width, height } = useVideoConfig();
  const vals = (p.values as number[] | undefined) ?? [];
  const disp = (p.display as string[] | undefined) ?? [];
  const max = Math.max(1, ...vals);
  const grow = interpolate(f, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const bw = (width * 0.7) / Math.max(1, vals.length);
  return (
    <AbsoluteFill style={{ padding: "8%", fontFamily: FONT, color: PAPER }}>
      <div style={{ fontSize: 60 }}>{String(p.title ?? "")}</div>
      <div style={{ display: "flex", alignItems: "flex-end", height: height * 0.55, gap: 20 }}>
        {vals.map((v, i) => <div key={i} style={{ width: bw * 0.7, height: `${(v / max) * 100 * grow}%`, background: i === Number(p.highlight ?? -1) ? HOT : SOFT, position: "relative" }}><div style={{ position: "absolute", top: -50, fontSize: 34 }}>{disp[i] ?? ""}</div></div>)}
      </div>
    </AbsoluteFill>
  );
};
const MapC: React.FC<P> = (p) => {
  const c = (p.canvas as { w: number; h: number } | undefined) ?? { w: 4000, h: 2100 };
  const to = (p.to as [number, number, number, number] | undefined) ?? [0, 0, c.w, c.h];
  const paths = (p.paths as Array<{ d: string; focus: boolean }> | undefined) ?? [];
  const pts = (p.points as Array<{ name: string; x: number; y: number }> | undefined) ?? [];
  return (
    <AbsoluteFill style={{ background: INK }}>
      <svg viewBox={to.join(" ")} style={{ width: "100%", height: "100%" }}>
        {paths.map((x, i) => <path key={i} d={x.d} fill={x.focus ? "#3c4a57" : "#1f2830"} stroke={SOFT} strokeWidth={2} />)}
        {pts.map((x, i) => <circle key={i} cx={x.x} cy={x.y} r={18} fill={HOT} />)}
      </svg>
    </AbsoluteFill>
  );
};
const Doc: React.FC<P> = (p) => {
  const f = useCurrentFrame();
  const on = f >= Number(p.highlightFrom ?? 0);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "60%", background: PAPER, padding: 50, fontFamily: FONT, color: INK }}>
        <div style={{ fontSize: 30 }}>{String(p.masthead ?? "")} · {String(p.date ?? "")}</div>
        <div style={{ fontSize: 56, fontWeight: 700, background: on ? "#f2d16b" : "transparent" }}>{String(p.headline ?? "")}</div>
        <div style={{ fontSize: 30 }}>{String(p.body ?? "")}</div>
      </div>
    </AbsoluteFill>
  );
};
const Cut: React.FC<{ progress: number }> = ({ progress }) => <AbsoluteFill style={{ background: PAPER, opacity: interpolate(progress, [0, 0.5, 1], [0, 0.9, 0]) }} />;

export const FILM = {
  components: { Headline, Phrase, Label, NumberC, Quote, Chapter, Stage, Chart, MapC, Doc },
  roles: { headline: "Headline", phrase: "Phrase", label: "Label", number: "NumberC", quote: "Quote", chapter: "Chapter", stage: "Stage", chart: "Chart", map: "MapC", document: "Doc" },
  transitions: { cut: Cut },
  transition: "cut",
  transitionFrames: 10,
  fonts: { display: FONT, body: FONT },
};
