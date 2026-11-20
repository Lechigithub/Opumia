import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_SERIF } from "../types";

export interface DocumentProps {
  style?: "newspaper" | "filing" | "letter";
  masthead?: string;
  date?: string;
  headline?: string;
  body?: string;
  highlight?: string;
  paperSrc?: string;
  accent: string;
}

/** Renders text with a marker sweep behind the `highlight` substring. */
const Highlighted: React.FC<{ text: string; highlight?: string; progress: number; color: string }> = ({ text, highlight, progress, color }) => {
  const i = highlight ? text.toLowerCase().indexOf(highlight.toLowerCase()) : -1;
  if (i < 0 || !highlight) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span style={{ backgroundImage: `linear-gradient(${color}, ${color})`, backgroundRepeat: "no-repeat", backgroundSize: `${progress * 100}% 82%`, backgroundPosition: "0 70%", padding: "0 4px", boxDecorationBreak: "clone" }}>{text.slice(i, i + highlight.length)}</span>
      {text.slice(i + highlight.length)}
    </>
  );
};

/** Document & headline highlighter: paper sheet, slight 3D tilt, push-in, marker sweep on the key phrase. */
export const DocumentScene: React.FC<DocumentProps> = ({ style = "newspaper", masthead, date, headline = "", body = "", highlight, paperSrc, accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const portrait = height > width;
  const enter = spring({ frame: f, fps, config: { damping: 22, stiffness: 80 } });
  const push = interpolate(f, [0, durationInFrames], [1, 1.12]);
  const hl = interpolate(f, [fps * 0.5, fps * 1.3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sheetW = portrait ? width * 0.9 : width * 0.62;
  const serif = style !== "filing";
  return (
    <AbsoluteFill style={{ backgroundColor: "#111", alignItems: "center", justifyContent: "center", perspective: 1600 }}>
      <div
        style={{
          width: sheetW,
          minHeight: portrait ? height * 0.55 : height * 0.82,
          padding: portrait ? "60px 56px" : "56px 64px",
          position: "relative",
          backgroundColor: "#efe8d8",
          boxShadow: "0 50px 120px rgba(0,0,0,0.7)",
          transform: `translateY(${(1 - enter) * 300}px) rotateX(${8 - enter * 4}deg) rotateZ(${-1.5 + enter * 0.8}deg) scale(${push})`,
          overflow: "hidden",
        }}
      >
        {paperSrc ? <Img src={staticFile(paperSrc)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.85, mixBlendMode: "multiply" }} /> : null}
        <div style={{ position: "relative", color: "#1a1712" }}>
          {masthead ? <div style={{ fontFamily: serif ? FONT_SERIF : FONT_BODY, fontWeight: 900, fontSize: portrait ? 64 : 56, textAlign: "center", borderBottom: "4px double #1a1712", paddingBottom: 12, letterSpacing: serif ? 1 : 4, textTransform: serif ? "none" : "uppercase" }}>{masthead}</div> : null}
          {date ? <div style={{ fontFamily: FONT_BODY, fontSize: portrait ? 26 : 22, textAlign: "center", padding: "10px 0 18px", borderBottom: "1px solid #1a1712", textTransform: "uppercase", letterSpacing: 3 }}>{date}</div> : null}
          <div style={{ fontFamily: serif ? FONT_SERIF : FONT_BODY, fontWeight: 800, fontSize: portrait ? 74 : 64, lineHeight: 1.08, margin: "26px 0 22px" }}>
            <Highlighted text={headline} highlight={highlight} progress={hl} color={accent} />
          </div>
          <div style={{ fontFamily: FONT_SERIF, fontSize: portrait ? 34 : 28, lineHeight: 1.45, columnCount: portrait ? 1 : 2, columnGap: 36, textAlign: "justify" }}>
            <Highlighted text={body} highlight={headline.toLowerCase().includes((highlight ?? "").toLowerCase()) ? undefined : highlight} progress={hl} color={accent} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
