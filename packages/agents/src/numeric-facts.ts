import { usableClaims, type FactSheet } from "@opumia/contracts";

/** One number stated by a verified claim. Graphics may only show values from this table. */
export interface NumericFact {
  id: string; // n01…
  claimId: string;
  value: number; // fully scaled (e.g. 63.4 billion → 63_400_000_000)
  unit: "$" | "€" | "£" | "%" | "year" | "";
  display: string; // as written in the claim
  context: string; // the claim sentence
}

/** Currency codes → symbols ("EUR 5.44 billion" → "€5.44 billion") so the narrator says "euros" and parity can match the graphic. */
/**
 * Write for the ear: punctuation a narrator cannot speak is rewritten before the script is used — dashes used
 * as a pause become commas, bracketed asides become comma clauses, semicolons end the sentence. Hyphens inside
 * words ("film-less") are left alone. Applied in code, so no script reaches the voice with them.
 */
export const earPunctuation = (t: string) =>
  t
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+-\s+/g, ", ")
    .replace(/\s*\(([^()]{1,200})\)\s*([.,!?])?/g, (_m, inner: string, end?: string) => `, ${inner.trim()}${end ?? ","} `)
    .replace(/\s*;\s*(\p{L})/gu, (_m, c: string) => `. ${c.toUpperCase()}`)
    .replace(/;/g, ".")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

export const normalizeFigures = (t: string) =>
  t
    .replace(/\bEUR\s?(\d)/g, "€$1")
    .replace(/\bUSD\s?(\d)/g, "$$$1")
    .replace(/\bGBP\s?(\d)/g, "£$1")
    .replace(/(\d)\s?(EUR|euros)\b/g, "$1 euros");

const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, bn: 1e9, b: 1e9, tn: 1e12 };

/** Extract every number a verified/partial claim states, with currency, percent and scale words. */
export function numericFacts(fs: FactSheet): NumericFact[] {
  const out: NumericFact[] = [];
  const re = /([$€£])?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(%|percent|thousand|million|billion|trillion|bn|tn)?(?:\s?(euros?|dollars?|pounds?|usd|eur)\b)?/gi;
  for (const c of usableClaims(fs)) {
    for (const m of normalizeFigures(c.text).matchAll(re)) {
      const raw = m[2]!;
      const num = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(num)) continue;
      const scaleWord = (m[3] ?? "").toLowerCase();
      const isPct = scaleWord === "%" || scaleWord === "percent";
      const isYear = !m[1] && !scaleWord && /^(1[6-9]|20)\d\d$/.test(raw);
      const value = isPct || isYear ? num : num * (SCALE[scaleWord] ?? 1);
      out.push({
        id: `n${String(out.length + 1).padStart(2, "0")}`,
        claimId: c.id,
        value,
        unit: m[1] ? (m[1] as "$" | "€" | "£") : /^(euros?|eur)$/i.test(m[4] ?? "") ? "€" : /^(dollars?|usd)$/i.test(m[4] ?? "") ? "$" : /^pounds?$/i.test(m[4] ?? "") ? "£" : isPct ? "%" : isYear ? "year" : "",
        display: m[0].trim(),
        context: normalizeFigures(c.text),
      });
    }
  }
  return out;
}

export const formatFactTable = (nf: NumericFact[]) => nf.map((n) => `${n.id} = ${n.display} (value ${n.value}${n.unit ? `, unit ${n.unit}` : ""}) — ${n.context}`).join("\n");

/**
 * Bind a designed graphic's numbers to the fact table. Returns the props with values filled
 * from facts, or null when any required number is not a verified fact (the shot must not show it).
 */
export function bindFactProps(kind: string, props: Record<string, unknown>, nf: NumericFact[]): { props: Record<string, unknown>; factIds: string[] } | null {
  const byId = new Map(nf.map((n) => [n.id, n]));
  if (kind === "money_figure") {
    const f = byId.get(String(props.fact ?? ""));
    if (!f) return null;
    const prefix = f.unit === "$" || f.unit === "€" || f.unit === "£" ? f.unit : "";
    const suffix = f.unit === "%" ? "%" : "";
    const { fact: _f, value: _v, ...rest } = props;
    return { props: { ...rest, value: f.value, prefix, suffix }, factIds: [f.id] };
  }
  if (kind === "chart") {
    const ids = Array.isArray(props.facts) ? props.facts.map(String) : [];
    const facts = ids.map((id) => byId.get(id));
    if (!facts.length || facts.some((f) => !f)) return null;
    const labels = Array.isArray(props.labels) ? props.labels.map(String) : [];
    if (labels.length !== facts.length) return null;
    const u0 = facts[0]!.unit;
    const unit = u0 === "$" || u0 === "€" || u0 === "£" || u0 === "%" ? u0 : String(props.unit ?? "");
    const { facts: _x, values: _v, ...rest } = props;
    return { props: { ...rest, unit, values: facts.map((f) => f!.value), labels }, factIds: ids };
  }
  if (kind === "versus") {
    // Values in versus cards must quote fact displays verbatim.
    const l = props.left as { label?: string; fact?: string } | undefined;
    const r = props.right as { label?: string; fact?: string } | undefined;
    const fl = byId.get(String(l?.fact ?? ""));
    const fr = byId.get(String(r?.fact ?? ""));
    if (!fl || !fr) return null;
    return { props: { ...props, left: { label: l?.label ?? "", value: fl.display }, right: { label: r?.label ?? "", value: fr.display } }, factIds: [fl.id, fr.id] };
  }
  return { props, factIds: [] };
}
