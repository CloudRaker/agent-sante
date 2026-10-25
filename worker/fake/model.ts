// Fake milliseconds model for local development and tests. The regex layer of
// check A stays real; only the model calls are replaced by simple rules.
import type { EntitySpan } from "../safety/checks";
import type { DecisionModel } from "../safety/milliseconds";

const NAME = /\b(?:je m'appelle|mon nom est|my name is|i am called)\s+([A-ZÀ-Ý][\p{L}'-]+(?:\s+[A-ZÀ-Ý][\p{L}'-]+)?)/giu;
const STREET = /\b\d{1,5},?\s+(?:rue|avenue|av\.|boulevard|boul\.|chemin|street|st\.|road)\s+[\p{L}' -]{2,40}/giu;
const FILE = /\b(?:dossier|file|record)\s*(?:n[o°º]?\.?\s*|#\s*|number\s*)?[A-Z]?\d{5,}/giu;

function spans(text: string, re: RegExp, type: string, group = 0): EntitySpan[] {
  const out: EntitySpan[] = [];
  for (const m of text.matchAll(re)) {
    const value = m[group]!;
    const start = (m.index ?? 0) + m[0].indexOf(value);
    out.push({ type, text: value, probability: 0.96, start, end: start + value.length });
  }
  return out;
}

/** Simple stand-ins for the advice kinds the real hint covers. */
const ADVICE: Record<string, RegExp> = {
  diagnosis: /\b(vous avez probablement|c'est sûrement|you probably have|it is surely)\b/iu,
  dosage: /\b\d+\s?(mg|ml|comprimés?|tablets?|gouttes|drops)\b/iu,
  medication_change: /\b(prenez|arrêtez de prendre|cessez de prendre|take \d|stop taking)\b/iu,
  treatment_instruction: /\b(appliquez|faites un bain|apply|soak)\b/iu,
  care_decision: /\b(pas besoin de consulter|do not need to see|no need to see a doctor)\b/iu,
};

export function fakeModel(options: { delayMs?: number } = {}): DecisionModel {
  const delay = () => new Promise((r) => setTimeout(r, options.delayMs ?? 120));
  return {
    async entities(text) {
      await delay();
      return [
        ...spans(text, NAME, "person_name", 1),
        ...spans(text, STREET, "street_address"),
        ...spans(text, FILE, "file_number"),
      ].toSorted((a, b) => a.start - b.start);
    },
    async yesNoHint(text) {
      await delay();
      return Object.values(ADVICE).some((re) => re.test(text)) ? 0.93 : 0.04;
    },
  };
}
