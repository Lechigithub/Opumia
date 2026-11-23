/**
 * Build list 5, items 2 and 31: ONE table that scales every length-dependent number with the film's length.
 * Nothing else in the platform may assume 90 s: budgets, caps, agent time, shot counts, music cues, chart quotas,
 * chapters, re-hooks and the research depth all come from `lengthPlan(durationS)`.
 *
 * Cost and time are set per minute of film (owner, 2026-11-23): a 90 s film ≤ $3 and ≤ 30 min; a longer film scales by
 * the same per-minute figures ($2 and 20 min per minute of film). A shorter film keeps the 90 s figures as its floor:
 * research, the kit and the package cost the same whatever the length.
 */

/** Per-minute figures (owner). */
export const USD_PER_MIN = 2;
export const MINUTES_PER_MIN = 20;

/**
 * Each stage's share of the film's target spend and time, and how much of it is fixed per film (research, the kit, the
 * package) rather than per minute of film (narration, shots, scenes, the render). A stage over its share is a test
 * failure (the reliability report), not a note. The stage CAP — what its optional work may spend — is the share times
 * `CAP_HEADROOM`, so ladders and revisions have room before the film's limit stops them.
 */
export const STAGE_SHARE: Record<string, { usd: number; time: number; fixed: number }> = {
  A1: { usd: 0.11, time: 0.07, fixed: 0.6 }, // research
  A2: { usd: 0.09, time: 0.05, fixed: 0.3 }, // writer
  A3: { usd: 0.15, time: 0.1, fixed: 0.1 }, // narration (speech is billed per character)
  B1: { usd: 0.08, time: 0.07, fixed: 0.2 }, // director
  B2: { usd: 0.03, time: 0.07, fixed: 0.2 }, // sourcing
  B2d: { usd: 0.11, time: 0.08, fixed: 0.85 }, // art director (one kit per film)
  B2s: { usd: 0.02, time: 0.04, fixed: 0.2 }, // picture researcher
  B3: { usd: 0.09, time: 0.09, fixed: 0.1 }, // scene designer
  B4e: { usd: 0.015, time: 0.03, fixed: 0.1 }, // editor
  B4k: { usd: 0, time: 0.02, fixed: 0.1 }, // compositor (no model)
  B4c: { usd: 0.015, time: 0.03, fixed: 0.2 }, // colourist
  B5: { usd: 0.015, time: 0.03, fixed: 0.2 }, // sound designer
  B5s: { usd: 0.035, time: 0.03, fixed: 0.5 }, // showrunner
  B6: { usd: 0.07, time: 0.06, fixed: 0.3 }, // preflight + ladders + judge tells on previews
  C1: { usd: 0, time: 0.02, fixed: 0 }, // manifest
  C2: { usd: 0, time: 0.06, fixed: 0.05 }, // render
  C3: { usd: 0.09, time: 0.04, fixed: 0.9 }, // packaging (beside the render)
  C4: { usd: 0.01, time: 0.02, fixed: 0.3 }, // QA
  C4v: { usd: 0.015, time: 0.02, fixed: 0.2 }, // viewer QA
  C4j: { usd: 0.025, time: 0.02, fixed: 0.2 }, // final-cut judge
  C5: { usd: 0.03, time: 0.05, fixed: 0.2 }, // finished-film ladders
};
export const CAP_HEADROOM = 2.6;

export interface LengthPlan {
  durationS: number;
  minutes: number;
  /** Per-minute scale against a 90 s film, floored at 1 (a shorter film keeps the 90 s figures). */
  scale: number;
  /** Long-form chapters (0 = one continuous film). */
  chapters: number;
  targetUsd: number;
  targetMinutes: number;
  /** The film's hard spend limit, the reserve kept for the finish (package, QA, viewer, judge) and the pool kept for
   *  repairs (ladder rungs and the showrunner's send-backs). First passes may not spend either. */
  limitUsd: number;
  reserveUsd: number;
  repairUsd: number;
  /** What a stage should spend and take (its share), and what its optional work may spend (its cap). */
  stage(code: string): { usd: number; seconds: number; capUsd: number } | null;
  /** Multiplier for an agent's own caps (turn money and seconds) by how much of its work scales with length. */
  agentScale(fixed: number): number;
  /** Shots the film should have at the channel's cut rate (lo–hi). */
  shots(cutsPerMin: { p25: number; p50: number; p75: number }): { lo: number; mid: number; hi: number };
  /** Data shots allowed at the channel's rate per minute (at least one). */
  dataShots(perMin: number): number;
  /** Music cues: at least one per act or story turn, never fewer than the chapters. */
  musicCues(turns: number): number;
  /** Seconds between re-hooks (long-form) and the longest stretch without a turn. */
  rehookEveryS: number;
  maxGapS: number;
  /** The opening and ending windows the writer studies on real films (any length works from these). */
  openingS: number;
  endingS: number;
  /** Verified claims research must gather. */
  minClaims: number;
  /** Longest a single shot may hold. */
  maxShotS: number;
}

export function chaptersFor(durationS: number): number {
  // a chapter runs 90–150 s; a film too short for two chapters is one continuous film
  return durationS < 240 ? 0 : Math.max(2, Math.min(15, Math.round(durationS / 120)));
}

export function lengthPlan(durationS: number): LengthPlan {
  const d = Math.max(5, durationS);
  const minutes = d / 60;
  const scale = Math.max(1, d / 90);
  const targetUsd = Math.round(USD_PER_MIN * Math.max(1.5, minutes) * 100) / 100;
  const targetMinutes = Math.round(MINUTES_PER_MIN * Math.max(1.5, minutes));
  const chapters = chaptersFor(d);
  const share = (fixed: number) => fixed + (1 - fixed) * scale;
  return {
    durationS: d,
    minutes,
    scale,
    chapters,
    targetUsd,
    targetMinutes,
    limitUsd: Number(process.env.OPUMIA_MAX_USD) || Math.round(targetUsd * (5 / 3) * 100) / 100,
    // proof film (Blockbuster): the package stopped mid-thumbnail and the viewer and judge got $0 — the finish costs about
    // $0.70 for 90 s; every repair rung was skipped — a quarter of the target is kept for repairs
    reserveUsd: Math.round(0.27 * targetUsd * 100) / 100,
    repairUsd: Math.round(0.25 * targetUsd * 100) / 100,
    stage(code) {
      const s = STAGE_SHARE[code];
      if (!s) return null;
      // the share is of the 90 s target, grown by the part of the stage that scales with length
      const base = USD_PER_MIN * 1.5 * s.usd * share(s.fixed);
      const seconds = MINUTES_PER_MIN * 1.5 * 60 * s.time * share(s.fixed);
      return { usd: Math.round(base * 1000) / 1000, seconds: Math.round(seconds), capUsd: Math.round(base * CAP_HEADROOM * 1000) / 1000 };
    },
    agentScale: (fixed) => share(Math.max(0, Math.min(1, fixed))),
    shots(c) {
      return { lo: Math.max(3, Math.round(c.p25 * 0.85 * minutes)), mid: Math.max(3, Math.round(c.p50 * minutes)), hi: Math.max(4, Math.round(c.p75 * 1.15 * minutes)) };
    },
    dataShots: (perMin) => Math.max(1, Math.round(perMin * minutes)),
    musicCues: (turns) => Math.max(chapters || 1, Math.min(Math.max(2, Math.round(minutes * 2)), turns + 1)),
    rehookEveryS: chapters ? 30 : Math.min(30, d / 3),
    maxGapS: Math.max(20, Math.min(50, d / 2)),
    openingS: Math.min(20, d / 4),
    endingS: Math.min(20, d / 4),
    minClaims: Math.min(60, Math.max(10, Math.round(8 + minutes * 4))),
    maxShotS: d <= 120 ? 5.5 : 7,
  };
}
