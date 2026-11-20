import React from "react";
import { Composition, registerRoot } from "remotion";
import { Documentary, Thumbnail } from "./Documentary";
import type { DocProps } from "./types";

const emptyManifest = {
  schemaVersion: 1,
  id: "empty",
  scriptId: "empty",
  aspect: "9:16",
  width: 1080,
  height: 1920,
  fps: 30,
  durationFrames: 30,
  video: [],
  audio: [],
  captions: [],
  loudnessTargetLufs: -14,
  output: { path: "out.mp4", codec: "h264", crf: 18 },
  credits: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as DocProps["manifest"];

const Root: React.FC = () => (
  <>
    <Composition
      id="Documentary"
      component={Documentary}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      defaultProps={{ manifest: emptyManifest, look: { accent: "#f5c518", saturate: 1.05, contrast: 1.06, vignette: 0.55, grain: 0.25 } } satisfies DocProps}
      calculateMetadata={({ props }) => ({ durationInFrames: props.manifest.durationFrames, width: props.manifest.width, height: props.manifest.height, fps: props.manifest.fps })}
    />
    <Composition
      id="Thumbnail"
      component={Thumbnail}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={1}
      defaultProps={{ bg: "thumb_bg.png", headline: "", accent: "#f5c518", placement: "bottom" as const, w: 1080, h: 1920 }}
      calculateMetadata={({ props }) => ({ width: props.w, height: props.h })}
    />
  </>
);

registerRoot(Root);
