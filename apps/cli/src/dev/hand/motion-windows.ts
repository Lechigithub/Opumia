// Motion and light per 4 s window (same measureLook as the gate), to see where a film moves and where it stands still.
//   npx tsx apps/cli/src/dev/hand/motion-windows.ts <file> [startS] [spanS]
import { measureLook } from "@opumia/senses";
const [file, s0 = "0", span = "80"] = process.argv.slice(2) as [string, string?, string?];
const out: string[] = [];
for (let t = Number(s0); t < Number(s0) + Number(span) - 3.9; t += 4) {
  const l = await measureLook(file, { ss: t, t: 4 });
  out.push(`${Math.round(t)}s m${l.motion} L${l.luma.toFixed(2)} d${l.darkShare.toFixed(2)}`);
}
console.log(out.join(" | "));
