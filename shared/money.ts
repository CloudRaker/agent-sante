// Money on the site: the Worker stores provider costs in US dollars, and the site shows Canadian
// dollars only. One fixed rate converts them. Pure functions, tested (test/money.test.ts).
import type { Lang } from "./api";

/** Fixed conversion rate from the stored USD values to the CAD amounts on the site. */
export const USD_TO_CAD = 1.46;

export const toCad = (usd: number): number => (Number.isFinite(usd) ? usd * USD_TO_CAD : 0);

/**
 * Decimals that show an amount: 2 from one cent up, and 4 significant digits under one cent
 * (0.004567 has 6 decimals). Zero has 2.
 */
export function cadDecimals(value: number): number {
  const v = Math.abs(value);
  if (v === 0 || v >= 0.01) return 2;
  return Math.min(10, 3 - Math.floor(Math.log10(v)));
}

/** "0,12 $" in fr-CA, "$0.12" in en-CA. The value is already in CAD. */
export function formatCad(value: number, lang: Lang, decimals = cadDecimals(value)): string {
  return new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", {
    style: "currency",
    currency: "CAD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Prefix or suffix for an animated counter: "0,12 $" in fr-CA, "$0.12" in en-CA. */
export function cadAffix(lang: Lang): { prefix: string } | { suffix: string } {
  // A no-break space: a plain one collapses at the edge of the counter span.
  return lang === "fr" ? { suffix: " $" } : { prefix: "$" };
}
