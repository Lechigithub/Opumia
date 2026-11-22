// H31: Internet Archive moment finding on live searches — how many whole films hold a moment that fits.
//   npx tsx apps/cli/src/dev/archive-moments-test.ts
import { searchStock, archiveMoment } from "@opumia/resolver";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const wants = [["1970s office workers typing", "office workers typing at desks"], ["vintage camera factory", "workers assembling cameras on a factory line"], ["family photographs 1950s", "a family looking at photographs"]];
let found = 0, total = 0;
for (const [q, want] of wants) {
  const cs = await searchStock(q!, { kind: "video", orientation: "landscape", perPage: 4, providers: ["archive"] });
  for (const c of cs) {
    total++;
    const m = await archiveMoment(c, want!, "out/_ia_test");
    if (m) found++;
    console.log(q, "|", c.title.slice(0, 50), "| thumbs", c.moments?.length ?? 0, "→", m ? `${m.atS}s ${m.thumbUrl}` : "no moment");
  }
}
console.log(`moments found in ${found} of ${total} films`);
