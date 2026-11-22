// Whole-film score of a planned or finished job against the channel profile (no render, no model call unless the
// taste model is present).  npx tsx apps/cli/src/dev/film-score.ts out/<job> [channel]
import path from "node:path";
import { filmScoreText, scoreFilm } from "@opumia/agents";
import type { ChannelId } from "@opumia/contracts";
const [job, channel = "magnates-media"] = process.argv.slice(2);
if (!job) throw new Error("usage: film-score.ts out/<job> [channel]");
const s = await scoreFilm({ root: path.resolve("."), data: path.resolve("data"), jobDir: path.resolve(job), channel: channel as ChannelId, log: () => {} });
console.log(filmScoreText(s));
