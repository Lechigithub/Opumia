import React from "react";
import { Composition } from "remotion";
import { FilmRoot } from "./Film";
import length from "./length.json";
// the film is the narration plus its closing title (seconds, set in length.json; 24 fps is the platform's rate)
export const Root: React.FC = () => <Composition id="Film" component={FilmRoot} width={1920} height={1080} fps={24} durationInFrames={Math.round(length.seconds * 24)} />;
