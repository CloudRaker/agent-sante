// Verbatim citations: text normalization, source URL normalization and citation markup.
// The build script (scripts/sync-kb.mjs) and the Worker use the same functions, so a quote and
// the official text are normalized the same way. Erasable TypeScript only: Node runs this file
// directly with type stripping.

/** Apostrophe and single quote variants. */
const APOSTROPHES = /[‘’‚‛ʼʹ`´′＇]/g;
/** Double quote and guillemet variants. */
const QUOTES = /[“”„‟«»″‹›＂]/g;
/** Hyphen and dash variants. */
const DASHES = /[‐‑‒–—―−﹘﹣－]/g;
/** Space variants that NFKC can keep (zero-width and soft hyphen are removed). */
const SPACES = /[   -   　\t\r\n\f\v]/g;
const INVISIBLE = /[­​-‍⁠﻿]/g;

/**
 * Normalizes Markdown or plain text for a verbatim comparison: removes Markdown syntax (link
 * targets, emphasis, heading marks, list bullets, table pipes, block quote marks), applies NFKC,
 * maps every apostrophe, quote and dash variant to one character, collapses whitespace and
 * folds the case. The result is a single line.
 */
export function normalizeText(input: string): string {
  let s = input
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(SPACES, (c) => (c === "\n" ? "\n" : " "));
  s = s.replace(/\r\n?/g, "\n");
  // Images and links keep their text only. Bare autolinks keep the address.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  s = s
    .split("\n")
    .map(
      (line) =>
        line
          .replace(/^\s{0,3}>+\s?/, "") // block quote
          .replace(/^\s{0,3}#{1,6}\s+/, "") // heading
          .replace(/^\s*(?:[-*+•▪◦]|\d{1,3}[.)])\s+/, "") // list bullet
          .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*$/, "") // table separator row
          .replace(/\|/g, " "), // table pipes
    )
    .join("\n");
  s = s
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1") // Markdown escapes
    .replace(/`+/g, "")
    .replace(/\*+/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=$|[^\p{L}\p{N}])/gu, "$1");
  s = s.replace(APOSTROPHES, "'").replace(QUOTES, '"').replace(DASHES, "-");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The comparison key: the normalized text without any space. Spaces are dropped because the
 * crawled PDF text has spacing artifacts ("particulière ment") and Markdown changes the
 * spacing around punctuation. Words and their order still must match exactly.
 */
export function matchKey(normalized: string): string {
  return normalized.replace(/ /g, "");
}

/**
 * Normalizes a source URL for the index lookup: https scheme kept, host in lower case, no
 * fragment, no utm_* parameters, no trailing slash. Returns null for a value that is not an
 * http(s) URL.
 */
export function normalizeSourceUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  for (const key of Array.from(u.searchParams.keys())) if (/^utm_/i.test(key)) u.searchParams.delete(key);
  const search = u.searchParams.toString();
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}${search ? `?${search}` : ""}`;
}

/** The index the build writes to public/kb/index.json. */
export interface KbIndex {
  version: 1;
  /** Normalized source URL -> its knowledge text files (under /kb/) and the retrieval date. */
  urls: Record<string, { files: string[]; retrieved?: string }>;
  /** Text file -> the language of its knowledge file (front matter `lang`), when known. */
  langs?: Record<string, KbLang>;
}

/** The languages of the knowledge files. */
export type KbLang = "fr" | "en";

/** Maps a front matter `lang` value ("fr-CA", "en", ...) to a knowledge language. */
export function kbLang(value: unknown): KbLang | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(fr|en)(?:[-_][a-z]{2})?$/i.exec(value.trim());
  return m ? (m[1]!.toLowerCase() as KbLang) : undefined;
}

/** A citation the agent wrote, as found in the reply. */
export interface RawCitation {
  /** Offsets of the whole markup in the reply. */
  start: number;
  end: number;
  src: string;
  /** The inner text exactly as the agent wrote it (trimmed). */
  text: string;
}

/** `<citation src="...">...</citation>`, with single or double quotes around the address. */
const CITATION = /<citation\s+src\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>([\s\S]*?)<\/citation\s*>/gi;
/** A citation tag that has no pair (it is removed, the text stays). */
const STRAY_TAG = /<\/?citation\b[^>]*>/gi;

export function findCitations(text: string): RawCitation[] {
  const out: RawCitation[] = [];
  for (const m of text.matchAll(CITATION)) {
    out.push({ start: m.index, end: m.index + m[0].length, src: (m[1] ?? m[2] ?? "").trim(), text: (m[3] ?? "").trim() });
  }
  return out;
}

export function stripStrayTags(text: string): string {
  return text.replace(STRAY_TAG, "");
}

/** Splits a quote on the omission marks `[…]` and `[...]` (after NFKC, `…` is `...`). */
export function quoteFragments(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/\[\s*\.{3}\s*\]|\(\s*\.{3}\s*\)/)
    .map((f) => normalizeText(f))
    .filter((f) => f.length > 0);
}

/** Min characters of each normalized fragment. Shorter pieces are too common to prove a quote. */
export const MIN_FRAGMENT = 20;
/** Max verified citations in one reply. Extra ones count as not verified. */
export const MAX_CITATIONS = 3;
/** Max characters of one quote as the agent wrote it (the prompts ask for about 700). */
export const MAX_QUOTE_CHARS = 1000;

/** True when each fragment is in `haystack` (a match key), in order, with no overlap. */
export function fragmentsInOrder(fragments: string[], haystack: string): boolean {
  let from = 0;
  for (const f of fragments) {
    const key = matchKey(f);
    const at = haystack.indexOf(key, from);
    if (at < 0) return false;
    from = at + key.length;
  }
  return true;
}

/**
 * Dosing text. The prompts forbid doses, also in a quote, and a quote that holds one does not
 * verify, so the medical-advice check sees it. Four shapes, in French and in English:
 * - an amount with a unit or a dose form: "500 mg", "2,5 mL", "1 à 2 comprimés", "one tablet";
 * - an intake frequency: "toutes les 4 à 6 heures", "every 6 hours", "3 fois par jour",
 *   "twice a day", "once daily";
 * - a number per day or per 24 hours: "8 par jour", "maximum 8 in 24 hours";
 * - an intake verb with a number: "prendre 2", "donnez deux", "take two", "give 1" ("un" and
 *   "une" after a verb are articles: "donner une réponse" is not a dose).
 * Numbers can be digits, fractions ("1/2", "½") or words ("un", "deux", "one", "two", "half").
 * Wide on purpose: a false match only sends the quote to the medical-advice check.
 */
const NUM_WORDS =
  "un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|douze|demi|demie|one|two|three|four|five|six|seven|eight|nine|ten|twelve|half";
const NUM = String.raw`(?:\d+(?:[.,]\d+)?(?:\s*[/⁄]\s*\d+)?|(?:${NUM_WORDS})(?![\p{L}]))`;
const RANGE = String.raw`${NUM}(?:\s*(?:à|a|-|to|or|ou)\s*${NUM})?`;
const UNITS =
  String.raw`mg|mcg|µg|μg|ml|cc|ui|iu|g\/kg|mg\/kg|mg\/ml|` +
  String.raw`comprimés?|capsules?|gélules?|gouttes?|sachets?|suppositoires?|bouffées?|inhalations?|vaporisations?|timbres?|pastilles?|ampoules?|` +
  String.raw`cuillères?(?:\s+(?:à|a)\s+(?:thé|café|soupe))?|c\.\s*à\s*(?:thé|soupe)|` +
  String.raw`tablets?|pills?|caplets?|drops?|sachets?|suppositor(?:y|ies)|puffs?|sprays?|patch(?:es)?|lozenges?|teaspoons?|tablespoons?|tsp|tbsp`;
const DOSE_PATTERNS = [
  // An amount with a unit or a dose form.
  new RegExp(String.raw`(?<![\p{L}\p{N}])${RANGE}[\s-]*(?:${UNITS})(?![\p{L}])`, "iu"),
  // An intake frequency.
  new RegExp(String.raw`(?<![\p{L}])(?:toutes\s+les|tous\s+les|chaque|every)\s+(?:${RANGE}\s*)?(?:heures?|h|hours?|hrs?)(?![\p{L}])`, "iu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}])${RANGE}\s*fois\s+(?:par|au|chaque)\s+(?:jour|journée|24\s*h(?:eures)?)`, "iu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}])${RANGE}\s*times?\s+(?:a|per|each|every)\s+(?:day|24\s*h(?:ours)?)`, "iu"),
  new RegExp(
    String.raw`(?<![\p{L}])(?:once|twice|thrice)\s+(?:a|per|each|every)\s+day|(?<![\p{L}])(?:once|twice|thrice)\s+daily(?![\p{L}])`,
    "iu",
  ),
  // A number per day or per 24 hours.
  new RegExp(
    String.raw`(?<![\p{L}\p{N}])${RANGE}\s+(?:(?!(?:heures?|hours?|hrs?|h|minutes?|min)(?![\p{L}]))[\p{L}'’-]+\s+){0,2}(?:par|per|a|in|within|en|sur)\s+(?:jour|day|24\s*h(?:eures|ours)?)(?![\p{L}])`,
    "iu",
  ),
  // An intake verb with a number.
  new RegExp(
    String.raw`(?<![\p{L}])(?:prendre|prenez|prends|donner|donnez|donne|administrer|administrez|take|taking|give|giving|administer)\s+(?:(?:au\s+plus|jusqu'à|up\s+to|no\s+more\s+than)\s+)?(?!(?:un|une)(?![\p{L}]))${NUM}(?![\p{L}])`,
    "iu",
  ),
];

export function hasDose(text: string): boolean {
  const t = text.normalize("NFKC").replace(/[’‘]/g, "'");
  return DOSE_PATTERNS.some((re) => re.test(t));
}

/** A verified citation, as the API returns it. */
export interface Citation {
  src: string;
  /** The exact quote as the agent wrote it. */
  text: string;
  verified: true;
  /** Date the official page was retrieved ("2026-10-23"), when known. */
  retrieved?: string;
  /** Language of the official text, from the knowledge file that verified the quote. */
  lang?: KbLang;
  /**
   * "leaflet": a quote of the consumer leaflet of a non-prescription drug (Health Canada). The UI
   * adds a notice to ask a pharmacist. Absent: a quote of an official health page.
   */
  kind?: "leaflet";
  /** The official text holds a dose: the UI adds a notice to ask a pharmacist. */
  dose?: true;
  /**
   * Machine translation of `text` into the conversation language, when `lang` is another
   * language. The Worker translates only the verified official text, never agent text.
   */
  translation?: { text: string; lang: KbLang };
  /** True when `lang` is another language and the translation failed: the original shows alone. */
  untranslated?: true;
}

/** The marker line that holds the place of verified citation `i` in the reply text. */
export const citationMarker = (i: number) => `[[citation:${i}]]`;
export const CITATION_MARKER = /^\[\[citation:(\d)\]\]$/;
