import type { ChannelId } from "@opumia/contracts";

export interface ChannelConfig {
  id: ChannelId;
  displayName: string;
  /** Folder under Reference/. */
  dir: string;
  /** done*.txt that tracks this channel; null when the channel has none (Big Company). */
  doneFile: string | null;
  /** File prefix used in Reference/.analysis/meta. */
  metaPrefix: string | null;
  layout: "standard" | "big-company";
}

export const CHANNELS: ChannelConfig[] = [
  { id: "magnates-media", displayName: "MagnatesMedia", dir: "MagnatesMedia", doneFile: "done.txt", metaPrefix: "MM", layout: "standard" },
  { id: "logically-answered", displayName: "Logically Answered", dir: "Logically Answered", doneFile: "done_LogicallyAnswered.txt", metaPrefix: "LA", layout: "standard" },
  { id: "big-company", displayName: "Big Company", dir: "Big Company", doneFile: null, metaPrefix: null, layout: "big-company" },
  { id: "modern-mba", displayName: "Modern MBA", dir: "Modern MBA", doneFile: "done_ModernMBA.txt", metaPrefix: "MBA", layout: "standard" },
  { id: "how-money-works", displayName: "How Money Works", dir: "How Money Works", doneFile: "done_HowMoneyWorks.txt", metaPrefix: "HMW", layout: "standard" },
  { id: "moon", displayName: "Moon", dir: "Moon", doneFile: "done_moon-real.txt", metaPrefix: "MOON", layout: "standard" },
];
