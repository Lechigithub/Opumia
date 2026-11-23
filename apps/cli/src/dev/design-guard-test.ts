// Build list 5, items 10–14, offline (no model, no network): worlds made valid, no world twice in a row, a card never
// repeated in the next shot, each picture once, and the gate's design checks on a synthetic Nokia-like film.
//   npx tsx apps/cli/src/dev/design-guard-test.ts
import { designProblems, finishOf, repetitionGuard, worldOf, type DesignBand, type DesignLabel } from "@opumia/agents";
import type { SceneSpec } from "@opumia/contracts";

const fails: string[] = [];
const cam = { fromScale: 1, toScale: 1.1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 };
// worldOf: a world needing a picture without one falls to a field; burst never keeps a picture
if (worldOf({ kind: "duotone", slot: -1, slots: [], color: "primary", accent: "accent" }, [], 0).kind !== "flat_field") fails.push("a duotone with no picture must fall to a flat field");
if (worldOf({ kind: "burst", slot: 0, slots: [], color: "primary", accent: "accent" }, [0], 0).slot !== undefined) fails.push("a burst carries no picture of its own");
if (worldOf({ kind: "collage", slot: 0, slots: [], color: "primary", accent: "primary" }, [0], 0).kind !== "duotone") fails.push("a collage of one picture must become a duotone");
if (finishOf(undefined).grain <= 0 || finishOf(undefined).vignette <= 0) fails.push("every shot carries a floor of grain and vignette");

const sc = (id: string, o: Partial<SceneSpec>): SceneSpec => ({ shotId: id, idea: "", backdrop: "world", dim: 0.3, camera: cam, elements: [], ...o }) as SceneSpec;
const head = (t: string) => ({ type: "component" as const, name: "Headline", props: { text: t }, x: 0.1, y: 0.1, w: 0.5, rot: 0, z: 0.5, at: 0, enter: "fade" as const });
const ph = (slot: number, w: number, grade: "natural" | "mono" = "natural") => ({ type: "photo" as const, slot, x: 0.1, y: 0.1, w, rot: 0, z: 0.5, at: 0, enter: "fade" as const, grade });
const ordered = [
  sc("sh1", { world: { kind: "duotone", slot: 0, color: "primary", accent: "accent" }, elements: [head("the burning platform"), ph(1, 0.4)] }),
  sc("sh2", { world: { kind: "duotone", slot: 0, color: "primary", accent: "accent" }, elements: [head("the burning platform"), ph(1, 0.42), head("jump")] }),
  sc("sh3", { world: { kind: "paper", slot: 0, color: "paper", accent: "accent" }, elements: [ph(1, 0.7, "mono")] }),
  sc("sh4", { world: { kind: "flat_field", color: "primary", accent: "accent" }, elements: [ph(1, 0.2, "natural")] }),
];
const refs: Record<string, string> = { "sh1:0": "A", "sh2:0": "B", "sh3:0": "C", "sh1:1": "ELOP", "sh2:1": "ELOP", "sh3:1": "ELOP", "sh4:1": "ELOP" };
const said = repetitionGuard(ordered, (id, slot) => refs[`${id}:${slot}`], () => [0, 1]);
if (ordered[1]!.world!.kind === "duotone") fails.push("the same world twice in a row must change");
if (ordered[1]!.elements.some((e) => e.type === "component" && e.props.text === "the burning platform")) fails.push("a card repeated in the next shot must be removed");
if (ordered[1]!.elements.some((e) => e.type === "photo")) fails.push("Elop's portrait again at the same crop and treatment must be removed");
if (!ordered[2]!.elements.some((e) => e.type === "photo")) fails.push("a second use with another crop AND treatment is allowed");
if (ordered[3]!.elements.some((e) => e.type === "photo")) fails.push("a third use of a picture is never allowed");
if (said.length < 4) fails.push(`the guard should explain each change, said ${said.length}`);

// the gate's checks on a Nokia-like film: one template ground, boxed small labels, raw stock, five bar charts
const band: DesignBand = { schemaVersion: 1, channel: "t", films: 9, frames: 276, worldShare: { plain_stage: 0.26 }, maxOneWorld: { p10: 0.33, p50: 0.42, p90: 0.56 }, variety: { p10: 0.376, p50: 0.42, p90: 0.45 }, treated: { p10: 0.74, p50: 0.93, p90: 1 }, rawStock: { p10: 0, p50: 0.1, p90: 0.26 }, treatmentShare: {}, textArea: { p10: 0.017, p50: 0.092, p90: 0.3 }, boxed: { p10: 0.12, p50: 0.2, p90: 0.5 }, integrated: { p10: 0.33, p50: 0.5, p90: 0.77 }, tilted: 0.08, dataShare: { p10: 0.1, p50: 0.19, p90: 0.27 }, dataKinds: { bar_chart: 0.08, other_chart: 0.04 }, dataPerMin: 3.1, barShareOfData: 0.08, dataHoldS: 6, builtAt: "" };
const shots = Array.from({ length: 24 }, (_, k) => ({ id: `s${k}`, startS: k * 3.8, endS: (k + 1) * 3.8 }));
const L = (o: Partial<DesignLabel>): DesignLabel => ({ world: "footage", treatments: [], rawStock: false, data: "none", text: "none", textTilted: false, ...o });
const labels: Record<string, DesignLabel> = {};
const scenes: SceneSpec[] = [];
shots.forEach((s, k) => {
  const stage = k % 2 === 0;
  labels[s.id] = stage ? L({ world: "plain_stage", text: "boxed_label", data: k < 10 ? "bar_chart" : "none" }) : L({ rawStock: k % 4 === 1 });
  scenes.push(sc(s.id, stage ? { backdrop: "stage", elements: [head(`line ${k}`)] } : { backdrop: "footage" }));
});
const checks = new Set(designProblems({ scenes, shots, durationS: 92, band, labels, textArea: Object.fromEntries(shots.map((s, k) => [s.id, k % 2 === 0 ? 0.027 : 0])), variety: 0.347 }).map((p) => p.check));
for (const c of ["one_world", "template_stage", "world_variety", "untreated", "raw_stock", "small_text", "boxed_labels", "chart_slides"]) if (!checks.has(c)) fails.push(`the Nokia-like film must fail ${c}`);
console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "PASS design guards and checks (worlds, treatment, type, data, repetition)");
process.exit(fails.length ? 1 : 0);
