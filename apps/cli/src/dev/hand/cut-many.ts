import path from "node:path"; import { removeBackground } from "@opumia/senses";
const [, , ...pairs] = process.argv;
for (const p of pairs) { const [i, o] = p.split("="); const r = await removeBackground(i!, o!, path.join(process.cwd(), "data")); console.log(o, JSON.stringify((r as any).box ?? {})); }
