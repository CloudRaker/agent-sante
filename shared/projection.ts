// Cost averages and the yearly projection of the costs page. Pure functions, tested.
// The functions work in any currency: the page converts the stored USD to CAD first (shared/money.ts).
import { COST_CATEGORIES, type CostSums } from "./api";

/**
 * Info-Santé 811 calls per year: "about 2 million calls a year" (CTV News, 2026,
 * https://www.ctvnews.ca/montreal/article/nearly-90-minute-wait-to-speak-with-a-nurse-at-info-sante-811/).
 */
export const CALLS_811_PER_YEAR = 2_000_000;
export const CALLS_811_SOURCE = "https://www.ctvnews.ca/montreal/article/nearly-90-minute-wait-to-speak-with-a-nurse-at-info-sante-811/";

/** Share of the 811 calls in the slider, in percent. */
export const SHARE = { min: 1, max: 50, step: 1, initial: 10 } as const;

export function totalUsd(sums: CostSums): number {
  return COST_CATEGORIES.reduce((sum, c) => sum + (sums.usd[c] ?? 0), 0);
}

/** Average cost per conversation and per message. Null when there is no base yet. */
export function averages(sums: CostSums): { perConversation: number | null; perMessage: number | null } {
  const total = totalUsd(sums);
  return {
    perConversation: sums.conversations > 0 ? total / sums.conversations : null,
    perMessage: sums.turns > 0 ? total / sums.turns : null,
  };
}

/**
 * Yearly AI and service fees if `sharePct` percent of the 811 calls went through an agent like
 * this one, at the average cost per conversation. One call = one conversation. `cost` is in the
 * currency of `perConversation`.
 */
export function projectYear(
  perConversation: number,
  sharePct: number,
  callsPerYear = CALLS_811_PER_YEAR,
): { conversations: number; cost: number } {
  const share = Math.min(SHARE.max, Math.max(SHARE.min, sharePct)) / 100;
  const conversations = Math.round(callsPerYear * share);
  return { conversations, cost: conversations * Math.max(0, perConversation) };
}
