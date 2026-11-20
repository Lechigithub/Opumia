import { z } from "zod";
import { ChannelId } from "./style.js";

/** Human-maintained overrides (data/license-overrides.json): licence whitelists and per-channel caps. */
export const LicenseOverrides = z.object({
  schemaVersion: z.literal(1),
  assets: z.array(
    z.object({
      /** Library-relative glob; `*` matches within one path segment, `**` across segments. */
      glob: z.string().min(1),
      license: z.string().min(1),
      attributionRequired: z.boolean().default(false),
      attributionText: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  channels: z.record(ChannelId, z.object({ maxWpm: z.number().positive().optional() })).default({}),
});
export type LicenseOverrides = z.infer<typeof LicenseOverrides>;

export const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.split("**").map((part) => part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
