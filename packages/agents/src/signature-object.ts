/** The film's signature object — one real thing from THIS story that returns two or three times. Never one an earlier
 *  film used, never a generic money symbol. Used by the film agent's gate. */
const OBJ_STOP = new Set(["the", "a", "an", "of", "its", "his", "her", "their", "with", "and", "that", "this", "from", "real", "one", "which", "who", "whose", "returns", "return", "times", "twice", "three", "two", "then", "when", "film", "story", "company", "object"]);
export const GENERIC_OBJECTS = ["coin", "coins", "banknote", "banknotes", "money", "cash", "dollar", "dollars", "briefcase", "gavel", "handcuffs", "safe", "vault", "magnifying", "question mark", "chess", "hourglass", "crown", "trophy", "padlock"];
export function objectWords(s: string): string[] {
  const head = s.toLowerCase().split(/[—–:;,.(]/)[0] ?? "";
  return [...new Set(head.split(/[^a-zà-ÿ0-9]+/).filter((w) => w.length >= 3 && !OBJ_STOP.has(w)).map((w) => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1")))];
}
/** True when two signature objects name the same thing (half or more of the shorter one's words shared). */
export function sameObject(a: string, b: string): boolean {
  const A = objectWords(a), B = new Set(objectWords(b));
  if (!A.length || !B.size) return false;
  const shared = A.filter((w) => B.has(w)).length;
  return shared / Math.min(A.length, B.size) >= 0.5;
}
