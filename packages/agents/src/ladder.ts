import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { budgetLeft, usageLedger } from "./llm.js";

/**
 * Escalation ladders (build list 3, item 11). A failed check becomes a precise PROBLEM — what failed, on which shots,
 * the measured value against the band, the evidence frames — sent to the agent that owns it. Each problem climbs its
 * own ladder: the cheapest fix first, a stronger one each time the same problem is still there, never a weaker look.
 * Every attempt is logged (cause, rung, owner, cost, seconds) to `<job>/ladders.jsonl`, and the outcome of each attempt
 * is logged when the check is measured again.
 */
export interface Problem {
  /** The check that failed (preflight / QA / viewer / judge id). */
  check: string;
  /** Shots it is about (empty = the whole film). */
  shots: string[];
  /** Plain words: what is wrong. */
  what: string;
  measured: string;
  band: string;
  /** Frames that show it (previews, stills), for the owner to look at. */
  evidence?: string[];
}

export interface Rung<A> {
  /** Short name, logged. */
  name: string;
  /** The agent that does this rung's work. */
  owner: string;
  /** The most this rung may cost; skipped when the film has less left. */
  maxUsd: number;
  /** Do the work (or queue it on the act). Returns what was done, or null when this rung cannot act on these problems. */
  run: (problems: Problem[], act: A) => Promise<string | null>;
}

export type LadderTable<A> = Record<string, Array<Rung<A>>>;

interface Attempt { at: string; round: number; check: string; rung: string; level: number; owner: string; shots: string[]; measured: string; band: string; note: string; usd: number; seconds: number }

/** Ladder state for one stage of one film: the level each (check, shot) has reached, and the log. */
export class Ladders<A> {
  private level = new Map<string, number>();
  private pending: Attempt[] = [];
  private round = 0;
  readonly attempts: Attempt[] = [];
  /** Build list 4, item 5: what each owner's rung really cost on this film (the most seen), used over its estimate. */
  private cost = new Map<string, number>();
  /** Rungs (check|owner|rung) that ran on this film and fixed nothing: never bought again for that check. */
  private futile = new Set<string>();
  /** Owners whose whole-film rung failed outright on this film (an agent that did not get its work accepted): their
   *  whole-film rungs are not bought again for any check. */
  private ownerDown = new Set<string>();
  private markFutile(a: { check: string; owner: string; rung: string; shots: string[]; note?: string }) {
    this.futile.add(`${a.check}|${a.owner}|${a.rung}`);
    if (!a.shots.length && /not accepted|did not get|^FAILED|could not act/i.test(a.note ?? "")) this.ownerDown.add(a.owner);
  }
  private loaded = false;
  constructor(private o: { jobDir: string; stage: string; table: LadderTable<A>; log?: (s: string) => void }) {}

  /** A resumed film continues its ladders where they were: levels, measured costs and futile rungs come from ladders.jsonl. */
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = readFileSync(this.file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return;
    }
    const tried = new Map<string, Attempt>();
    for (const r of rows) {
      if (r.stage !== this.o.stage) continue;
      if (r.kind === "attempt") {
        const a = r as unknown as Attempt;
        for (const s of a.shots.length ? a.shots : ["film"]) this.level.set(`${a.check}|${s}`, Math.max(this.level.get(`${a.check}|${s}`) ?? 0, a.level + 1));
        this.cost.set(`${a.owner}|${a.rung}`, Math.max(this.cost.get(`${a.owner}|${a.rung}`) ?? 0, a.usd));
        tried.set(`${a.check}|${a.rung}`, a);
        if (/^could not act$|^FAILED|not accepted|did not get/i.test(a.note)) this.markFutile(a);
      }
      if (r.kind === "outcome" && Array.isArray(r.fixed) && r.fixed.length === 0) {
        const a = tried.get(`${String(r.check)}|${String(r.rung)}`);
        if (a) this.markFutile(a);
      }
    }
  }
  private estimate(r: Rung<A>) {
    return Math.max(r.maxUsd, this.cost.get(`${r.owner}|${r.name}`) ?? 0);
  }

  private keys(p: Problem) {
    return (p.shots.length ? p.shots : ["film"]).map((s) => `${p.check}|${s}`);
  }
  private file() {
    return path.join(this.o.jobDir, "ladders.jsonl");
  }
  private async write(rows: object[]) {
    if (!rows.length) return;
    await mkdir(this.o.jobDir, { recursive: true });
    await appendFile(this.file(), rows.map((r) => JSON.stringify({ stage: this.o.stage, ...r })).join("\n") + "\n");
  }

  /** Has a ladder for this check. */
  owns(check: string) {
    return Boolean(this.o.table[check]?.length);
  }

  /**
   * One round: log the outcome of the last round's attempts against the problems still failing, then run the next rung
   * of every problem's ladder (grouped so one rung runs once for all its shots). Returns what was done; empty when every
   * ladder is exhausted or nothing failed.
   */
  private async settle(problems: Problem[]) {
    const open = new Set(problems.flatMap((p) => this.keys(p)));
    const rows = this.pending.map((a) => ({ kind: "outcome", check: a.check, rung: a.rung, level: a.level, shots: a.shots, fixed: a.shots.length ? a.shots.filter((s) => !open.has(`${a.check}|${s}`)) : open.has(`${a.check}|film`) ? [] : ["film"], still: a.shots.length ? a.shots.filter((s) => open.has(`${a.check}|${s}`)) : open.has(`${a.check}|film`) ? ["film"] : [] }));
    for (let k = 0; k < rows.length; k++) if (!rows[k]!.fixed.length) this.markFutile(this.pending[k]!);
    await this.write(rows);
    this.pending = [];
  }

  async step(problems: Problem[], act: A): Promise<string[]> {
    this.load();
    await this.settle(problems);
    this.round++;
    // group (check, level) → the shots at that level
    const groups = new Map<string, { p: Problem; level: number; shots: string[] }>();
    for (const p of problems) {
      const rungs = this.o.table[p.check];
      if (!rungs?.length) continue;
      for (const k of this.keys(p)) {
        const lv = this.level.get(k) ?? 0;
        if (lv >= rungs.length) continue; // exhausted
        const g = groups.get(`${p.check}#${lv}`) ?? { p, level: lv, shots: [] };
        const shot = k.split("|")[1]!;
        if (shot !== "film") g.shots.push(shot);
        groups.set(`${p.check}#${lv}`, g);
      }
    }
    const done: string[] = [];
    for (const g of groups.values()) {
      const rungs = this.o.table[g.p.check]!;
      const keys = (g.shots.length ? g.shots : ["film"]).map((s) => `${g.p.check}|${s}`);
      for (const k of keys) this.level.set(k, g.level + 1);
      let level = g.level;
      let rung = rungs[level]!;
      // A rung the film cannot afford (by what it really cost here, when it ran before) or that already ran on this film
      // and fixed nothing is passed over for the next one — logged, never silently. With no rung left, the problem is
      // exhausted: it is logged as unresolved and the film goes on.
      const left = budgetLeft();
      const why = (r: Rung<A>) => (this.futile.has(`${g.p.check}|${r.owner}|${r.name}`) ? "it already ran on this film and fixed nothing" : !g.shots.length && this.ownerDown.has(r.owner) ? `the ${r.owner} already failed to get a whole-film change accepted on this film` : left !== null && this.estimate(r) > left * 1.1 + 0.02 ? `needs up to $${this.estimate(r).toFixed(2)}, $${Math.max(0, left).toFixed(2)} left` : null);
      let skip = why(rung);
      while (skip) {
        await this.write([{ kind: "skipped", round: this.round, check: g.p.check, rung: rung.name, level, why: skip }]);
        this.o.log?.(`  ladder ${g.p.check} → rung ${level + 1}/${rungs.length} "${rung.name}" skipped: ${skip}`);
        level++;
        for (const k of keys) this.level.set(k, level + 1);
        if (level >= rungs.length) break;
        rung = rungs[level]!;
        skip = why(rung);
      }
      if (level >= rungs.length) continue;
      const prob: Problem = { ...g.p, shots: g.shots };
      const before = usageLedger().reduce((t, r) => t + r.usd, 0);
      const t0 = Date.now();
      const note = await rung.run([prob], act).catch((e: Error) => `FAILED: ${e.message.slice(0, 200)}`);
      const a: Attempt = { at: new Date().toISOString(), round: this.round, check: g.p.check, rung: rung.name, level, owner: rung.owner, shots: g.shots, measured: g.p.measured, band: g.p.band, note: note ?? "could not act", usd: Math.round((usageLedger().reduce((t, r) => t + r.usd, 0) - before) * 1e4) / 1e4, seconds: Math.round((Date.now() - t0) / 1000) };
      this.attempts.push(a);
      this.cost.set(`${rung.owner}|${rung.name}`, Math.max(this.cost.get(`${rung.owner}|${rung.name}`) ?? 0, a.usd));
      if (note && !/^FAILED/.test(note) && !/not accepted|did not get/i.test(note)) this.pending.push(a);
      else this.markFutile(a);
      await this.write([{ kind: "attempt", ...a }]);
      this.o.log?.(`  ladder ${g.p.check} → rung ${level + 1}/${rungs.length} "${rung.name}" (${rung.owner})${g.shots.length ? ` on ${g.shots.join(", ")}` : ""}: ${a.note.slice(0, 140)}`);
      if (note) done.push(`${g.p.check}:${rung.name}`);
    }
    return done;
  }

  /** Problems whose every rung has been tried and that still fail. */
  exhausted(problems: Problem[]): Problem[] {
    this.load();
    return problems.filter((p) => this.owns(p.check) && this.keys(p).every((k) => (this.level.get(k) ?? 0) >= this.o.table[p.check]!.length));
  }

  /** Log the final outcome (call after the last measurement). */
  async close(problems: Problem[]) {
    await this.settle(problems);
    const open = problems.filter((p) => this.owns(p.check));
    if (open.length) await this.write(open.map((p) => ({ kind: "unresolved", check: p.check, shots: p.shots, measured: p.measured, band: p.band })));
  }
}
