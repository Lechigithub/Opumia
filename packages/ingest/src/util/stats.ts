import type { Stat } from "@opumia/contracts";

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(values: Array<number | null | undefined>): Stat | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: xs.length,
    mean: round(mean),
    p25: round(quantile(xs, 0.25)),
    p50: round(quantile(xs, 0.5)),
    p75: round(quantile(xs, 0.75)),
    min: round(xs[0]!),
    max: round(xs[xs.length - 1]!),
  };
}

export function median(values: number[]): number | null {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  return xs.length ? quantile(xs, 0.5) : null;
}
