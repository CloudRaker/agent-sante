// Québec calendar dates. The counters and the daily cap use the Québec day.

/** Québec calendar date ("2026-10-23") of an instant. */
export function quebecDate(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(nowMs);
}

/** The day `n` days before `day` ("2026-10-23", 1 gives "2026-10-22"). */
export function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - n)).toISOString().slice(0, 10);
}
