// Hand-made film (owner, 2026-11-23): the script, written in the session from the verified fact sheet of
// out/bl5e-ftx-short (claim ids beside each line). No model wrote or edited it.
export interface HandLine { id: string; role: "cold_open" | "hook" | "rise" | "twist" | "climax" | "fall" | "resolution"; text: string; claims: string[]; gapAfter: number }

export const TITLE = "FTX: four days from fine to bankrupt";
export const LINES: HandLine[] = [
  { id: "l01", role: "cold_open", text: "On the seventh of November, 2022, Sam Bankman-Fried sent the world a message.", claims: ["c25"], gapAfter: 0.12 },
  { id: "l02", role: "cold_open", text: "FTX is fine. Assets are fine.", claims: ["c25"], gapAfter: 0.4 },
  { id: "l03", role: "hook", text: "Four days later, his thirty-two billion dollar empire was bankrupt.", claims: ["c10", "c03"], gapAfter: 0.45 },
  { id: "l04", role: "rise", text: "The crack had appeared a week before, when a leaked balance sheet showed that forty percent of his trading firm's fourteen point six billion dollars in assets was FTT, a token his own exchange had made up.", claims: ["c01", "c23"], gapAfter: 0.2 },
  { id: "l05", role: "rise", text: "In other words, the money was mostly his own coupons.", claims: ["c01"], gapAfter: 0.3 },
  { id: "l06", role: "twist", text: "Then the head of Binance, Changpeng Zhao, said he would sell every FTT on his books.", claims: ["c12"], gapAfter: 0.15 },
  { id: "l07", role: "climax", text: "And customers ran. Six billion dollars walked out of FTX in seventy-two hours.", claims: ["c16"], gapAfter: 0.3 },
  { id: "l08", role: "climax", text: "Binance agreed to buy the company, and one day later it walked away, saying the problems were beyond its control or ability to help.", claims: ["c05", "c06"], gapAfter: 0.4 },
  { id: "l09", role: "fall", text: "The man sent in to clean up had already wound down Enron. Even he wrote that he had never seen such a complete failure of corporate controls.", claims: ["c19", "c15"], gapAfter: 0.35 },
  { id: "l10", role: "resolution", text: "In March 2024, Bankman-Fried was sentenced to twenty-five years, for stealing eight billion dollars from his own customers.", claims: ["c11"], gapAfter: 0.3 },
  { id: "l11", role: "resolution", text: "And the judge put it simply. He knew it was criminal. He just made a very bad bet that he would not get caught.", claims: ["c31"], gapAfter: 0 },
];
