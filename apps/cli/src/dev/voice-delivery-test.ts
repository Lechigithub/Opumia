// Build list 5, items 23–25, offline (no model, no speech):
//  - a stop inside a sentence after an unpunctuated word is a run-on pause; one at a comma is not;
//  - delivery problems are found by kind (rising end, missed stress, run-on pause);
//  - an act told "grave" is heard so when it is lower with less travel; one colour across acts is caught;
//  - the voice's craft measures;
//  - a Wikipedia lead's IPA is read ({{IPAc-en}}), and the name check needs the stressed vowel (EH-lop ≠ EE-lop).
//   npx tsx apps/cli/src/dev/voice-delivery-test.ts
import { actColours, deliveryIssues, heardAs, runOnPauses, toneVariety, voiceCraftMeasures, type LineMeasure, type VoiceLine } from "@opumia/agents";
import { ipaFromWikitext, judgeName, stressedVowel } from "@opumia/narration";

export async function voiceDeliveryTest(): Promise<string[]> {
  const fails: string[] = [];
  const w = (word: string, s: number, e: number) => ({ word, startS: s, endS: e });
  const p = runOnPauses([w("Nokia", 0, 0.4), w("had", 0.75, 0.9), w("won,", 0.95, 1.2), w("then", 1.6, 1.8), w("lost.", 1.85, 2.2)]);
  if (p.length !== 1 || p[0]!.after !== "Nokia") fails.push(`run-on pauses: expected one after "Nokia", got ${JSON.stringify(p)}`);

  const m = (o: Partial<LineMeasure>): LineMeasure => ({ seconds: 3, wpm: 170, f0Hz: 110, rangeSt: 8, melodySt: 2, dynamicsDb: 6, emphasis: null, endingSt: -2, contour: [], innerPauses: [], ...o });
  const line = (text: string, act = 0): VoiceLine => ({ text, role: "context", pace: "normal", emphasis: "", question: false, act });
  const typical = { rangeSt: 8, melodySt: 2 };
  const kinds = deliveryIssues(line("The platform had already burned by then."), m({ endingSt: 2.4, emphasis: { word: "burned", liftDb: 0.1, liftSt: 0.2 }, innerPauses: [{ after: "had", gapS: 0.4 }] }), null, typical).map(([k]) => k);
  for (const k of ["rising_end", "stress_missed", "run_on_pause"]) if (!kinds.includes(k as never)) fails.push(`delivery: ${k} not found (${kinds.join(",")})`);
  if (deliveryIssues({ ...line("Why did it fail?"), question: true }, m({ endingSt: 3 }), null, typical).length) fails.push("a question ending rising is not a problem");

  // tone: act 1 grave (lower, less travel) vs act 0 dry baseline
  const lines = [line("a b c d e f", 0), line("a b c d e f", 0), line("a b c d e f", 1), line("a b c d e f", 1)];
  const ms = [m({ f0Hz: 120, rangeSt: 9 }), m({ f0Hz: 122, rangeSt: 9 }), m({ f0Hz: 104, rangeSt: 6 }), m({ f0Hz: 102, rangeSt: 6 })];
  const ac = actColours(lines, ms);
  if (heardAs("grave", ac[1]!) !== true) fails.push(`act 1 should be heard as grave: ${JSON.stringify(ac[1])}`);
  if (heardAs("urgent", ac[1]!) !== false) fails.push("act 1 is not urgent");
  if (toneVariety(ac) < 0.8) fails.push(`two different acts should be more than one colour (${toneVariety(ac)})`);
  const same = actColours(lines, lines.map(() => m({})));
  if (toneVariety(same) >= 0.8) fails.push("identical acts must read as one colour");
  const cm = voiceCraftMeasures(lines, ms);
  if (cm.toneVariety === undefined || cm.risingEnds !== 0) fails.push(`craft measures: ${JSON.stringify(cm)}`);

  // names: the man says EE-lop
  const ipa = ipaFromWikitext("'''Stephen Elop''' ({{IPAc-en|ˈ|iː|l|ɒ|p}}; born 1963) is a Canadian businessman");
  if (ipa[0] !== "ˈiːlɒp") fails.push(`IPAc-en read as ${JSON.stringify(ipa)}`);
  if (stressedVowel("ˈiːlɒp") !== "i") fails.push(`stressed vowel of ˈiːlɒp: ${stressedVowel("ˈiːlɒp")}`);
  if (judgeName("ˈiːlɒp", "ɛ l ɒ p").ok) fails.push('"EH-lop" must fail a target of EE-lop (the vowel)');
  if (!judgeName("ˈiːlɒp", "i l ɑ p").ok) fails.push('"EE-lahp" should pass EE-lop');
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await voiceDeliveryTest();
  console.log(f.length ? `FAIL\n${f.join("\n")}` : "PASS voice delivery");
  process.exit(f.length ? 1 : 0);
}
