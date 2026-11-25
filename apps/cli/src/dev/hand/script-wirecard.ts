// Hand film 2 (2026-11-25): Wirecard, a new story from scratch. Written in the session from facts checked on the
// sources beside each line (no model wrote or edited it). Only the cold open (≈ 70 s) is built first: the minute that
// teaches motion. "reportedly" marks what rests on a reported police document.
import type { HandLine } from "./script.js";

export const TITLE = "Wirecard: the €24 billion company built on money that wasn't there";
export const SOURCES: Record<string, string> = {
  dax: "https://www.deutsche-boerse.com/dbg-en/media/press-releases/Wirecard-AG-to-be-included-in-DAX-new-composition-for-TecDAX-MDAX-and-SDAX-1406616",
  founding: "https://www.euronews.com/business/2018/09/05/germanys-commerzbank-gets-the-boot-from-the-dax-index",
  peak: "https://fortune.com/2020/06/18/high-flying-german-fintech-wirecard-plunges-as-millions-go-missing/",
  deutsche: "https://www.munich-startup.de/en/39483/wirecard-more-valuable-than-deutsche-bank/",
  ban: "https://www.bloomberg.com/news/articles/2019-02-18/bafin-bans-new-wirecard-net-short-positions-and-increases",
  ft: "https://cpj.org/2020/10/qa-financial-times-reporters-dan-mccrum-and-stefania-palma-on-wirecard-and-pressures-on-business-journalists/",
  missing: "https://www.aljazeera.com/economy/2020/6/23/germany-arrests-ex-ceo-of-wirecard-over-missing-2-1bn",
  banks: "https://www.theregister.com/2020/06/24/exwirecard_ceo_arrested_over_missing/",
  arrest: "https://fortune.com/2020/06/23/wirecard-ceo-arrest-accounting-scandal/",
  insolvency: "https://www.aljazeera.com/economy/2020/6/25/in-swift-spectacular-implosion-wirecard-officially-goes-bust",
  jet: "https://www.bloomberg.com/news/articles/2021-01-25/as-wirecard-collapsed-key-player-fled-by-private-jet-to-belarus",
};

export const LINES: HandLine[] = [
  { id: "w01", role: "cold_open", text: "In September 2018, a payments company from a suburb of Munich did something almost nobody thought was possible.", claims: ["dax"], gapAfter: 0.1, kinds: ["scene"] },
  { id: "w02", role: "cold_open", text: "It pushed Commerzbank, one of the thirty founding members, out of Germany's DAX index.", claims: ["dax", "founding"], gapAfter: 0.1, kinds: ["fact"] },
  { id: "w03", role: "rise", text: "Wirecard was worth around twenty-four billion euros, more than Deutsche Bank, and Germany finally had a tech champion of its own.", claims: ["peak", "deutsche"], gapAfter: 0.1, kinds: ["fact", "explain"] },
  { id: "w04", role: "twist", text: "But when a reporter at the Financial Times kept asking where the money actually was, Germany didn't go after the company.", claims: ["ft"], gapAfter: 0.1, kinds: ["story"] },
  { id: "w05", role: "twist", text: "Its regulator banned bets against the stock, and prosecutors investigated the reporter.", claims: ["ban", "ft"], gapAfter: 0.1, kinds: ["fact"] },
  { id: "w06", role: "climax", text: "Then, in June 2020, the auditors went looking for one point nine billion euros that was supposed to be sitting in two banks in the Philippines.", claims: ["missing"], gapAfter: 0.1, kinds: ["scene"] },
  { id: "w07", role: "climax", text: "Both banks said they had nothing to do with Wirecard.", claims: ["banks"], gapAfter: 0.1, kinds: ["fact"] },
  { id: "w08", role: "fall", text: "Within a week, its chief executive was arrested, Wirecard became the first DAX company ever to go bust, and its chief operating officer, Jan Marsalek, had reportedly boarded a private jet to Minsk, paid for in cash.", claims: ["arrest", "insolvency", "jet"], gapAfter: 0.1, kinds: ["fact", "fact", "story"] },
  { id: "w09", role: "hook", text: "So how does a company worth twenty-four billion euros turn out to be built on money that was never there?", claims: ["missing"], gapAfter: 0.1, kinds: ["question"] },
];
