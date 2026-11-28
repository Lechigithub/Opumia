// On-device OCR (macOS Vision, tools/ocr/ocr.swift), compiled once into <data>/.cache/ocr/ocr. Returns the binary, or
// null where it cannot be built (no swiftc, not macOS).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
export async function ocrBinary(root: string, data = path.join(root, "data")): Promise<string | null> {
  const bin = path.join(data, ".cache", "ocr", "ocr");
  if (existsSync(bin)) return bin;
  const src = path.join(root, "tools", "ocr", "ocr.swift");
  if (!existsSync(src)) return null;
  await mkdir(path.dirname(bin), { recursive: true });
  return pexec("swiftc", ["-O", src, "-o", bin], { timeout: 180_000 }).then(() => bin, () => null);
}
