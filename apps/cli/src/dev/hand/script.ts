// Hand-made film (owner, 2026-11-23): the script, written in the session from the verified fact sheet of
// out/bl5e-ftx-short (claim ids beside each line). No model wrote or edited it.
export interface HandLine { id: string; role: "cold_open" | "hook" | "rise" | "twist" | "climax" | "fall" | "resolution"; text: string; claims: string[]; gapAfter: number;
  /** What each sentence does, in the channel's line kinds (story-measure.ts LINE_KINDS), one per sentence; labelled in the session (the API is off). */
  kinds?: string[] }

export const TITLE = "FTX: four days from fine to bankrupt";
// v2 (2026-11-24): rewritten in the channel's way of telling, measured against real 80 s passages: the narrator
// talks to the viewer (a question, a tease, an aside), explains what the numbers mean, names a fear from the record
// (c22), and quotes twice instead of six times. Same verified facts, same beats. v1 is kept in script-v1.ts.txt.
export const LINES: HandLine[] = [
  { id: "l01", role: "cold_open", text: "It's the seventh of November, 2022, and Sam Bankman-Fried has a message for the world.", claims: ["c25"], gapAfter: 0.12, kinds: ["scene"] },
  { id: "l02", role: "cold_open", text: "FTX is fine. Assets are fine.", claims: ["c25"], gapAfter: 0.4, kinds: ["quote", "quote"] },
  { id: "l03", role: "hook", text: "Four days later, his thirty-two billion dollar empire was bankrupt. So how does a company worth that much vanish in less than a week? It started with one document.", claims: ["c10", "c03"], gapAfter: 0.4, kinds: ["fact", "question", "tease"] },
  { id: "l04", role: "rise", text: "A week earlier, a leaked balance sheet had shown that forty percent of his trading firm's fourteen point six billion dollars was FTT, a token his own exchange had made up.", claims: ["c01", "c23"], gapAfter: 0.2, kinds: ["fact"] },
  { id: "l05", role: "rise", text: "In other words, the money was mostly his own coupons, and coupons are only worth something while people believe in them.", claims: ["c01"], gapAfter: 0.3, kinds: ["explain"] },
  { id: "l06", role: "twist", text: "Then the head of Binance, a rival, said he would sell every FTT on his books. And you can guess what happened next.", claims: ["c12"], gapAfter: 0.2, kinds: ["scene", "address"] },
  { id: "l07", role: "climax", text: "Customers ran. Six billion dollars walked out of FTX in seventy-two hours.", claims: ["c16"], gapAfter: 0.3, kinds: ["story", "fact"] },
  { id: "l08", role: "climax", text: "Binance agreed to buy the company, and one day later it walked away. Whatever it had found was beyond saving.", claims: ["c05", "c06"], gapAfter: 0.4, kinds: ["story", "explain"] },
  { id: "l09", role: "fall", text: "The man brought in to clean up had already wound down Enron. Even by his standards, this was a complete failure.", claims: ["c19", "c15"], gapAfter: 0.35, kinds: ["story", "explain"] },
  { id: "l10", role: "resolution", text: "In March 2024, Bankman-Fried was sentenced to twenty-five years, for stealing eight billion dollars from his own customers.", claims: ["c11"], gapAfter: 0.3, kinds: ["fact"] },
  { id: "l11", role: "resolution", text: "Soon after that tweet, he had started to worry that FTX would not be fine. But in the judge's words, he had made a very bad bet, that he would never get caught.", claims: ["c22", "c31"], gapAfter: 0, kinds: ["motive", "quote"] },
];
