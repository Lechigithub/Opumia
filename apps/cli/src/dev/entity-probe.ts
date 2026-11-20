// Probe archive-first entity search (names only; keys loaded by keys.ts like the CLI).
import { loadKeys } from "../keys.js";
import { searchStock, namesEntity, anachronistic } from "@opumia/resolver";
loadKeys(process.cwd());
for (const [name, type, year] of [["Stephen Elop", "person", 2011], ["Nokia", "company", 2007], ["Espoo", "place", 0]] as const) {
  const q = `${name}${year ? ` ${year}` : ""}`;
  for (const kind of ["image", "video"] as const) {
    const r = await searchStock(q, { kind, orientation: "landscape", perPage: 6, providers: kind === "image" ? ["commons", "nara", "europeana"] : ["commons", "nara"] });
    const named = r.filter((c) => namesEntity(`${c.title} ${c.tags.join(" ")} ${c.attributionText ?? ""}`, { name, type }));
    const anach = named.filter((c) => anachronistic(`${c.title} ${c.tags.join(" ")}`, { min: 2001 }));
    console.log(q, kind, "found", r.length, "named", named.length, "anachronistic", anach.length, "|", named.slice(0, 2).map((c) => `${c.provider}:${c.title.slice(0, 50)}`).join(" ; "));
  }
}
