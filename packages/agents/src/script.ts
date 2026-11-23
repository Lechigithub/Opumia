import { chaptersFor } from "./film-length.js";
import { type Aspect, type FactClaim, type FactSheet, type ScriptDraft } from "@opumia/contracts";
import type { StylePack } from "./style-pack.js";
import type { ReferenceFilm, StoryBand } from "./story-measure.js";
import { writeScriptAgent, type StoryReport } from "./writer-agent.js";

export interface ScriptOptions {
  pack: StylePack;
  facts: FactSheet;
  aspect: Aspect;
  durationS: number;
  /** Words per minute the TTS voice will actually speak at. */
  narrationWpm: number;
  /** Blueprints this channel used recently (from ProductionMemory) — the chooser must not repeat them. */
  recent?: Array<{ hook: string; ending: string; spine: string; beats?: string[] }>;
  /** The writer agent's material: the channel's measured story band and its real films (both required). */
  storyBand: StoryBand | null;
  films: ReferenceFilm[];
  /** The writer's line to the researcher (verified claims are added to `facts` in place). */
  askResearcher?: (questions: string[]) => Promise<FactClaim[]>;
  memoryDir?: string;
  onStory?: (r: StoryReport) => void;
  /** How recent films opened (first ~20 words each): this film must open differently. */
  recentOpenings?: string[];
  log?: (s: string) => void;
  /** The showrunner sent the script back (writer agent only). */
  brief?: string;
}

/** Chapters for a runtime: 90–150 s each in long-form (3–15), none for shorts. */
export const chapterCount = (durationS: number) => chaptersFor(durationS);

/**
 * The script: written by the writer agent (one author with tools — writer-agent.ts). Build list 3, L13: the five-pass
 * writer was removed; a channel without a story band gets its band built first (dev/channel-bands.ts), never the old
 * writer.
 */
export async function writeScript(o: ScriptOptions): Promise<ScriptDraft> {
  if (!o.storyBand || !o.films.length) throw new Error(`writer: the channel's story band and reference films are needed first (build them with apps/cli/src/dev/channel-bands.ts)`);
  return writeScriptAgent({ ...(o.brief ? { brief: o.brief } : {}), pack: o.pack, facts: o.facts, aspect: o.aspect, durationS: o.durationS, narrationWpm: o.narrationWpm, storyBand: o.storyBand, films: o.films, ...(o.memoryDir ? { memoryDir: o.memoryDir } : {}), ...(o.askResearcher ? { askResearcher: o.askResearcher } : {}), ...(o.recent ? { recent: o.recent } : {}), ...(o.recentOpenings ? { recentOpenings: o.recentOpenings } : {}), ...(o.onStory ? { onStory: o.onStory } : {}), ...(o.log ? { log: o.log } : {}) });
}
