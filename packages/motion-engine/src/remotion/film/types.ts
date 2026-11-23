import type React from "react";

/** Props every film component receives, besides its own: its box in pixels, the shot's picture slots and the film's tokens. */
export interface FilmComponentProps {
  /** The component's own props, as the scene designer wrote them (text, numbers, slot indexes…). */
  [key: string]: unknown;
}

/**
 * A film's own motion-design kit (build list 2, step 5): written for ONE film by its art director, from a blank slate —
 * its typefaces, its cards, labels, picture frames, number treatments and the transition that bridges its cuts.
 * Nothing in it is shared with another film; only the channel's editing and visual grammar is.
 */
export interface FilmKit {
  /** Named components the scene designer can place (`{ type: "component", name, props }`). */
  components: Record<string, React.FC<FilmComponentProps>>;
  /** Role → component (build list 3): the engine draws chapter cards, stages, charts, maps and documents, and the scene
   * designer every word, through these. Roles: headline, phrase, label, number, quote, chapter, stage, chart, map, document. */
  roles?: Record<string, string>;
  /** Named transitions drawn across a cut; `progress` runs 0 → 1 over the transition, the cut at 0.5. */
  transitions: Record<string, React.FC<{ progress: number }>>;
  /** The transition used where a shot asks for the film's own ("film"). */
  transition?: string;
  /** Frames the transition spans (centred on the cut). */
  transitionFrames?: number;
  /** The film's typefaces (CSS font-family stacks, loaded by the kit): every word the shared primitives draw uses them. */
  fonts?: { display: string; body: string };
  /**
   * Owner, 2026-11-23 (no template look): the film's OWN version of any engine-drawn style, by name — a world kind
   * ("burst", "filmstrip", "contact_grid", "split", "gradient", "paper", …) or a picture frame ("polaroid", "neon",
   * "torn"). When the kit draws one, it replaces the engine's for this film. A world gets { slots, src, t, base, accent,
   * width, height }; a frame gets { src, width, height, children }.
   */
  styles?: Record<string, React.FC<FilmComponentProps>>;
  /** For the scene designer: what each component is for and the props it takes. */
  meta?: Record<string, { use: string; props: string }>;
}
