// The recipe lab (2026-11-26): a scene treatment is proven by the referee, not by taste. Real frames are rendered with
// each treatment by Remotion and the stills scored by the referee's production model (corners masked); a recipe goes
// into the agents' craft only if it scores above what our agents built and near the channel.
//   npx tsx apps/cli/src/dev/recipe-lab.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd(), DATA = path.join(ROOT, "data");
const LAB = path.join(DATA, "referee", "work", "lab");
for (const d of ["src", "public", "stills"]) mkdirSync(path.join(LAB, d), { recursive: true });

// real footage: one frame of each of Juicero's stock clips, with the words its narration said over it
const J = path.join(ROOT, "out", "agent-juicero-2", "public", "v");
const WORDS = ["BARE HANDS", "$120 MILLION", "SUSPENDED", "4 PEOPLE NEVER TOLD", "7 NEVER KNEW", "4 TONS", "SEPTEMBER 2017", "LOST TO A PAIR OF HANDS", "EIGHT OUNCES", "THE PRESS", "SILICON VALLEY", "SQUEEZED"];
const clips = readdirSync(J).filter((f) => f.endsWith(".mp4")).sort();
const items = clips.map((c, i) => {
  const out = path.join(LAB, "public", `f${i}.jpg`);
  if (!existsSync(out)) spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", "1.5", "-i", path.join(J, c), "-frames:v", "1", "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080", "-q:v", "2", out]);
  return { img: `f${i}.jpg`, words: WORDS[i % WORDS.length]! };
}).filter((x) => existsSync(path.join(LAB, "public", x.img)));
const VARIANTS = ["raw", "app", "card", "dark", "recipe", "recipe_lit"] as const;
writeFileSync(path.join(LAB, "src", "items.json"), JSON.stringify(items));
writeFileSync(path.join(LAB, "src", "index.ts"), `import { registerRoot } from "remotion";\nimport { Root } from "./Root";\nregisterRoot(Root);\n`);
writeFileSync(path.join(LAB, "src", "Root.tsx"), `import React from "react";\nimport { Composition } from "remotion";\nimport { Lab } from "./Lab";\nimport items from "./items.json";\nexport const Root: React.FC = () => <Composition id="Film" component={Lab} width={1920} height={1080} fps={24} durationInFrames={items.length * ${VARIANTS.length} * 24} />;\n`);
writeFileSync(path.join(LAB, "src", "Lab.tsx"), `import React from "react";
import { AbsoluteFill, Img, Sequence, staticFile } from "remotion";
import { GlowCaption, DarkPlate } from "@craft";
import { loadFont as shoulders } from "@remotion/google-fonts/BigShoulders";
import { loadFont as dm } from "@remotion/google-fonts/DMSans";
import { loadFont as plex } from "@remotion/google-fonts/IBMPlexMono";
import items from "./items.json";
const BIG = shoulders("normal", { weights: ["900"], subsets: ["latin"] }).fontFamily;
const SANS = dm("normal", { weights: ["700"], subsets: ["latin"] }).fontFamily;
const MONO = plex("normal", { weights: ["600"], subsets: ["latin"] }).fontFamily;
const V = ${JSON.stringify(VARIANTS)};
const One: React.FC<{ img: string; words: string; v: string }> = ({ img, words, v }) => {
  if (v === "raw") return <AbsoluteFill><Img src={staticFile(img)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></AbsoluteFill>;
  if (v === "app") return <AbsoluteFill><Img src={staticFile(img)} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "saturate(0.6) brightness(0.85)" }} /><div style={{ position: "absolute", left: 120, top: 90, fontFamily: SANS, fontWeight: 700, fontSize: 110, color: "#D4204F", letterSpacing: "-0.01em" }}>{words}</div></AbsoluteFill>;
  if (v === "card") return <AbsoluteFill style={{ background: "linear-gradient(180deg,#1b2128,#0e1216)" }}><div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", padding: "50px 80px", borderRadius: 28, background: "linear-gradient(180deg,#e8455f,#b3163a)", boxShadow: "0 30px 80px rgba(0,0,0,.6)", fontFamily: SANS, fontWeight: 700, fontSize: 96, color: "#fff" }}>{words}</div><div style={{ position: "absolute", left: "50%", top: "28%", transform: "translateX(-50%)", fontFamily: SANS, fontSize: 26, letterSpacing: "0.3em", color: "#9aa4ae" }}>JUICERO · PRESSED</div></AbsoluteFill>;
  if (v === "dark") return <DarkPlate src={img} dim={0.55} />;
  return <AbsoluteFill><DarkPlate src={img} dim={v === "recipe" ? 0.55 : 0.75} /><GlowCaption text={words} font={BIG} y={0.5} size={words.length > 14 ? 150 : 210} glow="rgba(255,90,110,.65)" sub="JUICERO · 2017" subFont={MONO} /></AbsoluteFill>;
};
export const Lab: React.FC = () => <AbsoluteFill>{items.flatMap((it, i) => V.map((v, j) => <Sequence key={i + v} from={(i * V.length + j) * 24} durationInFrames={24}><One img={it.img} words={it.words} v={v} /></Sequence>))}</AbsoluteFill>;
`);
const times = items.flatMap((_, i) => VARIANTS.map((_, j) => (((i * VARIANTS.length + j) * 24 + 20) / 24).toFixed(4)));
const r = spawnSync("npx", ["tsx", path.join(ROOT, "packages/motion-engine/src/hand/render-film.ts"), LAB, "--stills", times.join(","), "--stills-dir", "stills"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
if (r.status !== 0) { console.log(r.stderr.slice(-1500)); process.exit(1); }
const files = times.map((t) => path.join(LAB, "stills", `t${Number(t).toFixed(2)}.jpg`));
const agents = await import("@opumia/agents");
const m = JSON.parse(readFileSync(path.join(DATA, "referee", "magnates-media-taste.json"), "utf8"));
const vs = await agents.embedPictures({ root: ROOT, data: DATA, items: files.map((file) => ({ file, degrade: "corners" })) });
const res: Record<string, number[]> = Object.fromEntries(VARIANTS.map((v) => [v, []]));
files.forEach((_, k) => { const v = VARIANTS[k % VARIANTS.length]!; if (vs[k]) res[v]!.push(agents.tasteOf(m, vs[k]!)); });
const cfg = JSON.parse(readFileSync(path.join(DATA, "referee", "magnates-media.json"), "utf8")) as { bars: { film: number; stretch: number } };
console.log(`\n${items.length} real frames × ${VARIANTS.length} treatments, referee score (corners masked; channel films ≥ ${cfg.bars.film}, its weakest tenth of moments ${cfg.bars.stretch}):`);
for (const v of VARIANTS) { const xs = res[v]!; const mean = xs.reduce((a, b) => a + b, 0) / xs.length; console.log(`  ${v.padEnd(11)} ${mean.toFixed(2)}  (min ${Math.min(...xs).toFixed(2)}, max ${Math.max(...xs).toFixed(2)})`); }
writeFileSync(path.join(LAB, "result.json"), JSON.stringify(res));
spawnSync("ffmpeg", ["-v", "error", "-y", ...files.slice(0, VARIANTS.length * 2).flatMap((f) => ["-i", f]), "-filter_complex", `${files.slice(0, VARIANTS.length * 2).map((_, k) => `[${k}:v]scale=480:270[s${k}]`).join(";")};${files.slice(0, VARIANTS.length * 2).map((_, k) => `[s${k}]`).join("")}xstack=inputs=${VARIANTS.length * 2}:layout=${files.slice(0, VARIANTS.length * 2).map((_, k) => `${(k % VARIANTS.length) * 480}_${Math.floor(k / VARIANTS.length) * 270}`).join("|")}`, "-frames:v", "1", path.join(LAB, "sheet.jpg")]);
console.log(`sheet (two frames, treatments left to right: ${VARIANTS.join(", ")}): ${path.join(LAB, "sheet.jpg")}`);
