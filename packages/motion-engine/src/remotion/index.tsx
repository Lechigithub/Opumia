import React from "react";
import { Composition, registerRoot } from "remotion";
import { Documentary } from "./Documentary";
import { ThumbnailScene } from "./scenes/ThumbnailScene";
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
      id="ThumbnailScene"
      component={ThumbnailScene}
      width={1280}
      height={720}
      fps={30}
      durationInFrames={90}
      defaultProps={{ spec: { backdrop: "world" as const, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [] }, slots: {}, w: 1280, h: 720 }}
      calculateMetadata={({ props }) => ({ width: props.w, height: props.h })}
    />
  </>
);

registerRoot(Root);
