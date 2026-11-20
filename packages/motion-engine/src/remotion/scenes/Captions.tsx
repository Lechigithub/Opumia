import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, SAFE, type CaptionGroup } from "../types";

/** Word-synced captions: the group pops in, the spoken word is highlighted on its exact frame. */
export const Captions: React.FC<{ groups: CaptionGroup[]; accent: string }> = ({ groups, accent }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  const g = groups.find((x) => f >= x.startFrame && f < x.endFrame);
  if (!g) return null;
  const pop = spring({ frame: f - g.startFrame, fps, config: { damping: 12, stiffness: 220, mass: 0.5 } });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: portrait ? height * SAFE.captionBottom916 : height * SAFE.captionBottom169, pointerEvents: "none" }}>
      {/* Crisp dark translucent pill: legible on bright footage, never a flat opaque box. */}
      <div style={{ maxWidth: width * (portrait ? 0.86 : 0.7), display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: portrait ? 22 : 16, rowGap: 2, transform: `scale(${0.9 + 0.1 * pop})`, lineHeight: 1.12, background: "rgba(8,8,10,0.62)", backdropFilter: "blur(8px)", borderRadius: portrait ? 22 : 16, padding: portrait ? "14px 28px 16px" : "10px 24px 12px", boxShadow: "0 10px 30px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.08)" }}>
        {g.words.map((w, i) => {
          const active = f >= w.startFrame && f < Math.max(w.endFrame, w.startFrame + 3);
          const spoken = f >= w.startFrame;
          return (
            <span
              key={i}
              style={{
                fontFamily: FONT,
                fontSize: portrait ? 58 : 46,
                textTransform: "uppercase",
                color: active ? accent : spoken ? "#ffffff" : "rgba(255,255,255,0.88)",
                WebkitTextStroke: "1.5px rgba(0,0,0,0.9)",
                paintOrder: "stroke fill",
                textShadow: active ? `0 0 18px ${accent}88, 0 2px 4px rgba(0,0,0,0.9)` : "0 2px 4px rgba(0,0,0,0.9)",
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
