// Clarifying questions of the agents (Run `ask` with suggested answers).
// The model text is cleaned to plain text, then the medical-advice check reads the question and
// its choices together with the reply text. The person sees a question card with buttons.
import type { AgentQuestion, Lang } from "../shared/api";
import { LIMITS } from "../shared/api";
import type { RunQuestion } from "./run/client";

/** A question that passed the clean step: the Run id, and the plain text the person sees. */
export interface CleanQuestion extends AgentQuestion {
  id: string;
}

/** Plain text: no tag, no Markdown link target, no emphasis, one line. */
function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cleans the question of a Run `question` event. Returns null when nothing usable is left.
 * Choices: strings only, plain text, at most `LIMITS.choiceChars` characters (a longer one is
 * dropped, never cut), no duplicates, the first `LIMITS.choices`.
 */
export function cleanQuestion(q: RunQuestion | undefined): CleanQuestion | null {
  if (!q || typeof q.question_id !== "string" || !q.question_id || q.question_id.length > 64) return null;
  let text = plain(String(q.text ?? ""));
  if (!text) return null;
  if (text.length > LIMITS.questionChars) text = `${text.slice(0, LIMITS.questionChars - 1).trimEnd()}…`;
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const raw of Array.isArray(q.choices) ? q.choices : []) {
    if (typeof raw !== "string") continue;
    const choice = plain(raw);
    const key = choice.toLowerCase();
    if (!choice || choice.length > LIMITS.choiceChars || seen.has(key)) continue;
    seen.add(key);
    choices.push(choice);
    if (choices.length === LIMITS.choices) break;
  }
  return { id: q.question_id, text, choices };
}

/**
 * The question as text, for the medical-advice check and for the transcript (its hash chain,
 * and the input of a new run). The choices follow the question, one per line.
 */
export function questionText(q: AgentQuestion, lang: Lang): string {
  if (!q.choices.length) return q.text;
  const label = lang === "fr" ? "Réponses proposées :" : "Suggested answers:";
  return `${q.text}\n${label}\n${q.choices.map((c) => `- ${c}`).join("\n")}`;
}

const fold = (s: string) =>
  plain(s)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’']/g, "'")
    .replace(/\s*([?!.:;,])\s*$/, "")
    .trim();

/**
 * Drops the last paragraph of the reply text when it ends with the question: the card shows the
 * question, so the person must not read it twice. Other text stays as it is.
 */
export function dropEchoedQuestion(text: string, question: string): string {
  const q = fold(question);
  if (!q) return text;
  const paragraphs = text.trim().split(/\n{2,}/);
  const last = paragraphs.at(-1) ?? "";
  if (!fold(last).endsWith(q)) return text;
  return paragraphs.slice(0, -1).join("\n\n");
}

/** True when the message is exactly one of the suggested answers of the open question. */
export function isStoredChoice(open: { c: string[] } | undefined, message: string): boolean {
  return !!open && open.c.includes(message);
}
