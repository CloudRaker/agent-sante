// Agent status lines (custom Run event `status`, tool emit_status): one short sentence in which
// the agent says what it does ("Je cherche dans les pages de Santé Québec sur la fièvre").
// A status line goes to the browser only after a fast check:
// - shape: a plain sentence of 3 to 100 characters, no link, no markup;
// - the dose guard (hasDose, shared with the citations);
// - one milliseconds medical-advice call (same hint and threshold as check B), no rewrite and
//   no strike, inside a 300 ms budget.
// Any failure, error or timeout drops the line. The log keeps the reason only, never the text.
import { hasDose } from "../shared/kb";
import { MED_HINT, MED_THRESHOLD } from "./safety/checks";
import type { DecisionModel } from "./safety/milliseconds";

export const STATUS_BUDGET_MS = 300;
/** Max status lines checked per request: each one costs a milliseconds call. */
export const MAX_STATUS_LINES = 8;

export type StatusDrop = "invalid" | "dose" | "flagged" | "timeout" | "error" | "too_many";
export type StatusVerdict = { ok: true; text: string } | { ok: false; reason: StatusDrop };

/** The status text when its shape is fine, else null. */
export function statusText(data: Record<string, unknown>): string | null {
  if (typeof data.text !== "string") return null;
  const text = data.text.replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 100) return null;
  if (/https?:|www\.|[<>[\]{}`*_#|\\]/i.test(text)) return null;
  return text;
}

export async function checkStatus(
  model: DecisionModel,
  data: Record<string, unknown>,
  budgetMs = STATUS_BUDGET_MS,
): Promise<StatusVerdict> {
  const text = statusText(data);
  if (!text) return { ok: false, reason: "invalid" };
  if (hasDose(text)) return { ok: false, reason: "dose" };
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  try {
    const score = await Promise.race([model.yesNoHint(text, MED_HINT), timeout]);
    if (score === "timeout") return { ok: false, reason: "timeout" };
    return score >= MED_THRESHOLD ? { ok: false, reason: "flagged" } : { ok: true, text };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
