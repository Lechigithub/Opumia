// Pixel half of the watermark check on the Nokia proof film's clips (no model).
import { cornerMarks } from "@opumia/senses";
const dir = "/Users/lechi/Opumia/out/bl4c-nokia/public/media/";
for (const f of process.argv.slice(2).length ? process.argv.slice(2) : ["sh017_6750b5e9.mp4", "sh014_568941cf.mp4", "sh009_33da9cfd.mp4", "sh003_b62fe26a.mp4", "sh004_60e11f74.mp4", "sh005_6ad2e3e6.mp4", "sh021_755d97d2.mp4", "sh024_3d723ed6.mp4"]) {
  const r = await cornerMarks(dir + f);
  console.log(f, r.sceneMotion, r.suspects.join(",") || "-", r.corners.map((c) => `${c.corner}:${c.persistentEdges}/${c.motion}`).join(" "));
}
