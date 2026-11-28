// The thumbnail's own Remotion entry: only the ThumbnailScene composition (the film agent's packaging renders through
// it; the film itself is rendered from the job's own project by hand/render-film.ts).
import React from "react";
import { Composition, registerRoot } from "remotion";
import { ThumbnailScene } from "./ThumbnailScene";

const Root: React.FC = () => (
  <Composition
    id="ThumbnailScene"
    component={ThumbnailScene}
    width={1280}
    height={720}
    fps={24}
    durationInFrames={90}
    defaultProps={{ spec: { backdrop: "world" as const, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [] }, slots: {}, w: 1280, h: 720 }}
    calculateMetadata={({ props }) => ({ width: props.w, height: props.h })}
  />
);
registerRoot(Root);
