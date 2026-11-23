/**
 * Number parity: the figure on screen must be the figure the narrator says, in the same precision
 * ("$7.2 billion" spoken → "$7.2B" shown; never "$7.20B", "$7B" or "7.2B").
 */
export interface SpokenNumber {
  /** Fully scaled value (7.2 billion → 7.2e9; 49.4% → 49.4). */
  value: number;
  unit: "$" | "€" | "£" | "%" | "";
  /** Mantissa as spoken ("7.2") and its scale letter ("B"). */
  mantissa: string;
  scale: "" | "K" | "M" | "B" | "T";
  startS: number;
  text: string;
}

const SCALE: Record<string, [number, SpokenNumber["scale"]]> = { thousand: [1e3, "K"], million: [1e6, "M"], billion: [1e9, "B"], trillion: [1e12, "T"], bn: [1e9, "B"], b: [1e9, "B"], t: [1e12, "T"], m: [1e6, "M"], k: [1e3, "K"] };

const clean = (w: string) => w.replace(/^[("“'‘]+|[)"”'’,.;:!?]+$/g, "");

/** Parse every number the narration speaks, with currency, percent and scale words ("$7.2", "billion", "euros"). */
export function spokenNumbers(words: Array<{ word: string; startS: number }>): SpokenNumber[] {
  const out: SpokenNumber[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = clean(words[i]!.word);
    const m = /^([$€£])?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(%|bn|[kmbt])?$/i.exec(w);
    if (!m) continue;
    const prev = clean(words[i - 1]?.word ?? "").toUpperCase();
    let unit: SpokenNumber["unit"] = (m[1] as SpokenNumber["unit"]) ?? (prev === "EUR" ? "€" : prev === "USD" ? "$" : prev === "GBP" ? "£" : "");
    let mult = 1;
    let scale: SpokenNumber["scale"] = "";
    let used = [w];
    if (m[3] === "%") unit = "%";
    else if (m[3]) [mult, scale] = SCALE[m[3].toLowerCase()] ?? [1, ""];
    const next = clean(words[i + 1]?.word ?? "").toLowerCase();
    if (!m[3] && SCALE[next]) {
      [mult, scale] = SCALE[next]!;
      used.push(next);
    } else if (!m[3] && (next === "percent" || next === "per")) {
      unit = "%";
      used.push(next);
    }
    const after = clean(words[i + used.length]?.word ?? "").toLowerCase();
    if (!unit && /^(euros?)$/.test(after)) unit = "€";
    else if (!unit && /^(dollars?)$/.test(after)) unit = "$";
    else if (!unit && /^(pounds?)$/.test(after)) unit = "£";
    const mantissa = m[2]!;
    const n = Number(mantissa.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push({ value: unit === "%" ? n : n * mult, unit, mantissa, scale, startS: words[i]!.startS, text: used.join(" ") });
  }
  return out;
}

/** On-screen string for a spoken number: prefix, mantissa exactly as spoken, scale letter, suffix. */
export const displayOf = (s: SpokenNumber) => `${s.unit === "$" || s.unit === "€" || s.unit === "£" ? s.unit : ""}${s.mantissa}${s.scale}${s.unit === "%" ? "%" : ""}`;

/** Does a spoken number state this fact value (same unit family; equal within the spoken precision)? */
export function matchesFact(s: SpokenNumber, value: number, unit: string): boolean {
  const cur = (u: string) => u === "$" || u === "€" || u === "£";
  if (unit === "%" ? s.unit !== "%" : s.unit === "%") return false;
  if (cur(unit) && s.unit && s.unit !== unit) return false;
  if (unit === "year") return s.scale === "" && !s.unit && s.value === value;
  const decimals = (s.mantissa.split(".")[1] ?? "").length;
  const step = (s.scale ? SCALE[{ K: "k", M: "m", B: "bn", T: "trillion" }[s.scale] ?? ""]?.[0] ?? 1 : 1) * Math.pow(10, -decimals);
  return Math.abs(s.value - value) <= step / 2 + 1e-9 * Math.abs(value);
}

/** The spoken number in [fromS, toS] that states `value`, nearest to `nearS`. */
export function spokenMatch(spoken: SpokenNumber[], value: number, unit: string, fromS: number, toS: number, nearS = fromS): SpokenNumber | undefined {
  return spoken
    .filter((s) => s.startS >= fromS && s.startS <= toS && matchesFact(s, value, unit))
    .sort((a, b) => Math.abs(a.startS - nearS) - Math.abs(b.startS - nearS))[0];
}

/** Parse an on-screen figure ("$7.2B", "49.4%", "€31 billion") back into value + unit. */
export function parseShown(t: string): { value: number; unit: string } | null {
  const sp = spokenNumbers(t.split(/\s+/).map((word) => ({ word, startS: 0 })));
  return sp[0] ? { value: sp[0].value, unit: sp[0].unit } : null;
}

/** Compact on-screen form of a fact value when the narration does not say it (no trailing zeros: "€31B", "$7.2B"). */
export function compactOf(value: number, unit: string): string {
  const a = Math.abs(value);
  const [d, l] = unit === "%" || unit === "year" ? [1, ""] : a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1, ""];
  const n = d === 1 ? (Number.isInteger(value) ? value.toLocaleString("en-US").replace(/,/g, unit === "year" ? "" : ",") : String(+value.toFixed(2))) : String(+(value / d).toFixed(a / d >= 100 ? 0 : 1));
  return `${unit === "$" || unit === "€" || unit === "£" ? unit : ""}${n}${l}${unit === "%" ? "%" : ""}`;
}

/** The precision a spoken number carries ("7.2 billion" → 0.1 billion). */
export function stepOf(s: SpokenNumber): number {
  const decimals = (s.mantissa.split(".")[1] ?? "").length;
  return (s.scale ? SCALE[{ K: "k", M: "m", B: "bn", T: "trillion" }[s.scale] ?? ""]?.[0] ?? 1 : 1) * Math.pow(10, -decimals);
}

/**
 * Build list 5, item 13: the inputs of `figureParity` (@opumia/agents) for a film — per shot, the figures it shows
 * (parsed from its on-screen strings) and the figures spoken within ±1.5 s of it.
 */
export function figureInputs(shots: Array<{ id: string; startS: number; endS: number; shown: string[] }>, words: Array<{ word: string; startS: number }>): Array<{ id: string; shown: Array<{ value: number; unit: string; text: string }>; spoken: Array<{ value: number; unit: string; text: string; step: number }> }> {
  const spoken = spokenNumbers(words);
  return shots.map((sh) => ({
    id: sh.id,
    shown: sh.shown.flatMap((t) => spokenNumbers(t.split(/\s+/).map((word) => ({ word, startS: 0 }))).filter((x) => !(x.unit === "" && x.scale === "" && x.value >= 1800 && x.value <= 2100 && Number.isInteger(x.value))).map((x) => ({ value: x.value, unit: x.unit, text: displayOf(x) }))),
    // a year said aloud is a date, never a figure a chart must show or add up to
    spoken: spoken.filter((s) => !(s.unit === "" && s.scale === "" && s.value >= 1800 && s.value <= 2100 && Number.isInteger(s.value))).filter((s) => s.startS >= sh.startS - 1.5 && s.startS <= sh.endS + 1.5).map((s) => ({ value: s.value, unit: s.unit, text: s.text, step: stepOf(s) })),
  }));
}
