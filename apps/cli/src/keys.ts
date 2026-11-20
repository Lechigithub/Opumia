import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Load API keys into this process only, from ~/.opumia_keys (or OPUMIA_KEYS_FILE).
 * Keys are no longer exported into every shell, so agents and unrelated tools
 * don't inherit them. Variables already set in the environment win.
 * Accepts `KEY=value` and `export KEY=value`, with optional quotes and # comments.
 */
export function loadKeys(file = process.env.OPUMIA_KEYS_FILE ?? path.join(os.homedir(), ".opumia_keys")): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return 0; // no keys file: stages that need a key report it themselves
  }
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q) && val.length >= 2) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, "");
    if (process.env[key] === undefined) {
      process.env[key] = val;
      n++;
    }
  }
  return n;
}
