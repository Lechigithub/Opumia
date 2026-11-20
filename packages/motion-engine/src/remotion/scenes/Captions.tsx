import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, type CaptionGroup } from "../types";

/** Word-synced captions: the group pops in, the spoken word is highlighted on its exact frame. */
export const Captions: React.FC<{ groups: CaptionGroup[]; accent: string }> = ({ groups, accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  const g = groups.find((x) => f >= x.startFrame && f < x.endFrame);
  if (!g) return null;
  const pop = spring({ frame: f - g.startFrame, fps, config: { damping: 12, stiffness: 220, mass: 0.5 } });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: portrait ? height * 0.27 : height * 0.08, pointerEvents: "none" }}>
      <div style={{ maxWidth: width * (portrait ? 0.86 : 0.7), display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: portrait ? 26 : 20, rowGap: 4, transform: `scale(${0.85 + 0.15 * pop})`, lineHeight: 1.12 }}>
        {g.words.map((w, i) => {
          const active = f >= w.startFrame && f < Math.max(w.endFrame, w.startFrame + 3);
          const spoken = f >= w.startFrame;
          return (
            <span
              key={i}
              style={{
                fontFamily: FONT,
                fontSize: portrait ? 76 : 58,
                textTransform: "uppercase",
                color: active ? accent : spoken ? "#ffffff" : "rgba(255,255,255,0.88)",
                WebkitTextStroke: portrait ? "3px #000" : "2px #000",
                paintOrder: "stroke fill",
                textShadow: "0 6px 18px rgba(0,0,0,0.85)",
                display: "inline-block",
                transformOrigin: "center bottom",
                transform: active ? "scale(1.06) translateY(-4px)" : undefined,
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
