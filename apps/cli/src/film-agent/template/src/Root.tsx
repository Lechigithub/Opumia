import React from "react";
import { Composition } from "remotion";
import { FilmRoot } from "./Film";
import length from "./length.json";
// the film is the narration plus its closing title (seconds and frame size set in length.json; 24 fps is the platform's rate)
const L = length as { seconds: number; width?: number; height?: number };
export const Root: React.FC = () => <Composition id="Film" component={FilmRoot} width={L.width ?? 1920} height={L.height ?? 1080} fps={24} durationInFrames={Math.round(L.seconds * 24)} />;
