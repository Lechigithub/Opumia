import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * API keys, loaded into THIS process only (never exported to the shell).
 *
 * Which keys: every name in `.env.example` with an empty value.
 * Where from, first match wins:
 *   1. already set in the environment (e.g. CI, or `op run`)
 *   2. macOS Keychain: generic password, service "opumia", account = variable name
 *   3. legacy plain-text file ~/.opumia_keys (or OPUMIA_KEYS_FILE), until it is deleted
 *
 * Values are never printed or logged. `opumia keys` reports names and sources only.
 */
export const KEYCHAIN_SERVICE = "opumia";

export type KeySource = "env" | "keychain" | "file" | "missing";

export function keyNames(root: string): string[] {
  let text = "";
  try {
    text = readFileSync(path.join(root, ".env.example"), "utf8");
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*$/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

function fromKeychain(name: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000, // leaves time to answer a macOS "allow access" prompt
    });
    const v = out.replace(/\r?\n$/, "");
    return v.length ? v : undefined;
  } catch {
    return undefined; // not in Keychain, or access denied
  }
}

function legacyFile(): Map<string, string> {
  const file = process.env.OPUMIA_KEYS_FILE ?? path.join(os.homedir(), ".opumia_keys");
  const map = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return map;
  }
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let val = m[2]!;
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q) && val.length >= 2) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, "");
    map.set(m[1]!, val);
  }
  return map;
}

/** Fill process.env with the project's keys. Returns where each one came from (names only). */
export function loadKeys(root: string): Record<string, KeySource> {
  const sources: Record<string, KeySource> = {};
  let file: Map<string, string> | undefined;
  for (const name of keyNames(root)) {
    if (process.env[name]) {
      sources[name] = "env";
      continue;
    }
    const kc = fromKeychain(name);
    if (kc !== undefined) {
      process.env[name] = kc;
      sources[name] = "keychain";
      continue;
    }
    file ??= legacyFile();
    const fv = file.get(name);
    if (fv) {
      process.env[name] = fv;
      sources[name] = "file";
      continue;
    }
    sources[name] = "missing";
  }
  return sources;
}
