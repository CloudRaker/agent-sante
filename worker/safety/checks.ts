// Definitions for the two safety checks. Rule from the milliseconds docs:
// write every type, statement and label in English, and describe the case, never the verdict.
import type { PiiKind } from "../../shared/api";

/**
 * Check A blocks when regexPii() finds a kind, or when an entity span kept by keepPiiSpan()
 * has probability >= PII_THRESHOLD. Check B flags the reply when the MED_HINT yes-no
 * probability >= MED_THRESHOLD.
 */
export const PII_THRESHOLD = 0.7;
export const MED_THRESHOLD = 0.5;

/** Check A: entity types for POST /entities. */
export const PII_TYPES: Record<PiiKind, string> = {
  person_name:
    "the first name or last name of a private person, not a hospital, clinic, pharmacy chain, store, street, city or place named after a person",
  health_insurance_number: "a Quebec health insurance (RAMQ) card number: four letters followed by eight digits",
  street_address: "a street address with a civic number, such as 1234 rue Saint-Denis",
  postal_code: "a complete six-character Canadian postal code, such as H2X 1Y4",
  phone_number: "a personal telephone number",
  email_address: "an email address",
  date_of_birth: "the date of birth of a person, with a day, a month and a year",
  file_number: "a hospital file, medical record, case or referral number",
  other_identifier: "a social insurance number, passport number, driver licence number or other government identity number",
};

/** Check B: one statement with two case hints (normalized probability, 1 unit). */
export const MED_HINT = {
  statement: "The reply gives the reader personal medical advice.",
  when_true:
    "The reply gives the reader personal medical advice: a diagnosis, a medication dose, an instruction to take or stop a medication, a home treatment, or a decision on whether or when they need to see a doctor or go to the emergency room.",
  when_false:
    "The reply gives general health information from an official source, or says which health service can assess the reader, such as 811, 911, a CLSC, a pharmacist or a clinic, and leaves the decision to that service.",
} as const;

export type Hint = typeof MED_HINT;

// Deterministic layer. It runs before the API call and catches structured
// identifiers with no model risk. It returns the kinds it found.
const TOLL_FREE = /^1?(800|833|844|855|866|877|888)/;
const FULL_POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;
const BIRTH_WORD = /(n[ée]e?s?\s+le|naissance|\bDDN\b|born|birth|\bDOB\b)/i;
const YEAR = /\b(19\d{2}|20[0-2]\d)\b/;
const MONTH =
  "(janv(ier)?|f[ée]v(rier)?|mars|avr(il)?|mai|juin|juil(let)?|ao[uû]t|sept(embre)?|oct(obre)?|nov(embre)?|d[ée]c(embre)?|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(tember)?|october|november|december)";
const HAS_MONTH = new RegExp(`\\b${MONTH}\\b`, "i");
const NUM_DATE = /\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/;
/** A full date: numeric (1990-11-23, 23/05/1960) or day + month name + year in fr/en. */
const FULL_DATE = new RegExp(
  `${NUM_DATE.source}|\\b\\d{1,2}(er|st|nd|rd|th)?\\s+(of\\s+)?${MONTH}\\.?,?\\s+(19|20)\\d{2}\\b|\\b${MONTH}\\.?\\s+\\d{1,2}(st|nd|rd|th)?,?\\s+(19|20)\\d{2}\\b`,
  "i",
);
const SPELLED_YEAR = /(mille neuf cent|deux mille|nineteen|twenty|two thousand)/i;
const digitCount = (s: string) => s.replace(/\D/g, "").length;
const FILE_NO =
  /\b(dossier|file|chart|case|cas|r[ée]f[ée]rence|requ[êe]te|requisition|MRN)\b[^\d\n]{0,40}?((?:[A-Za-z]{1,4}-)?\d[\d-]*(?: \d[\d-]*)*(?:-[A-Za-z]{1,4}-\d+)?)/gi;
/** Pharmacy chains and stores named after a person (Jean Coutu) are not personal names. */
const BRAND =
  /^(jean[ -]coutu|pharmaprix|uniprix|familiprix|proxim|brunet|acc[eè]s pharma|shoppers|walmart|costco|metro|iga|maxi|provigo)\b/i;

/**
 * Places named after a person: pharmacy chains, stores, and Québec hospitals, CLSC and
 * institutions. A name span that sits inside one of these in the message is a place, not a
 * person ("le numéro du jean coutu", "à Charles-Le Moyne"). Matching is on folded text
 * (no accents, lowercase, hyphens and spaces alike).
 */
const NAMED_PLACES = [
  // Pharmacy chains and stores.
  "jean coutu", "pharmaprix", "uniprix", "familiprix", "proxim", "brunet", "acces pharma", "shoppers drug mart",
  "walmart", "costco", "metro", "iga", "maxi", "provigo", "loblaws", "super c",
  // Hospitals and institutions named after a person or a saint.
  "charles le moyne", "charles lemoyne", "maisonneuve rosemont", "pierre boucher", "jean talon", "fleury",
  "santa cabrini", "pierre le gardeur", "anna laberge", "honore mercier", "sainte justine", "marie clarac",
  "saint luc", "notre dame", "hotel dieu", "jeffery hale", "christ roi", "enfant jesus", "saint francois d assise",
  "saint sacrement", "robert giffard", "albert prevost", "louis h lafontaine", "douglas", "jewish general",
  "general juif", "st mary", "sainte marie", "lakeshore", "royal victoria", "montreal general", "barrie memorial",
  "brome missisquoi perkins", "fernand larocque", "pierre janet", "cite de la sante", "saint eustache",
  "saint jerome", "le gardeur", "chauveau", "jean hamel",
  // CLSC named after a person (a CLSC word before the name is handled by PLACE_BEFORE too).
  "samuel de champlain", "marie victorin", "jean olivier chenier", "olivier guimond", "rene cassin",
  "saint henri", "saint michel", "saint leonard", "saint laurent", "cote des neiges", "parc extension",
].map((n) => n.replace(/[^a-z0-9]+/g, " ").trim());
const foldSpaced = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
/** Character ranges of the text covered by a named place. Folding keeps one character per character. */
function namedPlaceRanges(text: string): [number, number][] {
  const folded = foldSpaced(text);
  const ranges: [number, number][] = [];
  for (const name of NAMED_PLACES) {
    let at = folded.indexOf(name);
    while (at !== -1) {
      const end = at + name.length;
      const okStart = at === 0 || folded[at - 1] === " ";
      const okEnd = end === folded.length || folded[end] === " ";
      if (okStart && okEnd) ranges.push([at, end]);
      at = folded.indexOf(name, at + 1);
    }
  }
  return ranges;
}
/** "du X", "au X", "de la X", "à la X": an article before a name points to a place, not a person. */
const ARTICLE_BEFORE = /(?:^|\s)(du|au|aux|de la|à la|a la)\s+$/i;
/** A civic number just before a street span ("2250, avenue du Mont-Royal"). */
const CIVIC_BEFORE = /\d+[a-z]?\s*,?\s*$/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Names in self-introductions and signatures. The entity model can miss a lowercase first name
// ("salut moi c'est baptiste"), so these shapes never go to a network hop. A candidate word that
// is a common word, a state or an adjective ("je suis malade", "I'm worried", "moi c'est la
// fièvre") is not a name.
const NAME_WORD = "[\\p{L}][\\p{L}\\p{M}'’-]{1,30}";
const NOT_A_NAME = new Set(
  (
    // French function words, states and adjectives.
    "le la les l un une des du de d mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs pour par sur sous avec sans chez dans en " +
    "que qui quoi quand comment pourquoi où pas plus moins juste surtout encore aussi ça ca ce cet cette ces cela moi toi lui elle eux nous vous on " +
    "très trop vraiment bien mal tellement assez peu beaucoup comme parce depuis à a au aux et ou mais donc car si oui non " +
    "malade malades fatigué fatiguée fatigués épuisé épuisée enceinte inquiet inquiète inquiets stressé stressée anxieux anxieuse seul seule " +
    "perdu perdue désolé désolée content contente tanné tannée mêlé mêlée nouveau nouvelle nouveaux âgé âgée vieux vieille jeune diabétique " +
    "asthmatique allergique positif positive négatif négative guéri guérie blessé blessée né née mariée marié veuf veuve proche aidant aidante " +
    "maman papa mère père parent parents infirmier infirmière médecin pharmacien pharmacienne étudiant étudiante travailleur travailleuse " +
    "patient patiente client cliente bénévole retraité retraitée là ici ok correct pareil sûr sûre certain certaine rendu rendue " +
    "dû due censé censée capable incapable prêt prête allé allée venu venue sorti sortie rentré rentrée tombé tombée " +
    "salut bonjour bonsoir allô allo hello hi hey merci thanks " +
    "urgent urgente grave important importante normal normale possible correcte vrai simple compliqué difficile dur long longue " +
    "sérieux sérieuse pressant rapide toujours rien tout tous possible impossible dommage drôle bizarre étrange inquiétant " +
    // English function words, states and adjectives.
    "the an my your his her their our this that these those for about from with without at in on of to by into near around " +
    "not so very really too just also still only now here there back home out up down done fine okay ok good bad well better worse " +
    "sick ill tired exhausted pregnant worried scared afraid anxious stressed concerned confused alone lost sorry sure unsure new old " +
    "young elderly diabetic asthmatic allergic positive negative feeling going trying looking calling writing having getting waiting " +
    "wondering asking living staying taking coming hoping thinking here's able unable allowed eligible covered registered insured " +
    "born married widowed single retired student nurse doctor pharmacist caregiver mom mum dad mother father parent patient " +
    "in-charge currently still actually kind sort bit little lot big over under almost about calling"
  ).split(/\s+/),
);
const nameLike = (word: string | undefined) => {
  if (!word) return false;
  const w = word.toLocaleLowerCase("fr-CA").replace(/['’]$/, "");
  return w.length >= 2 && !NOT_A_NAME.has(w) && !/\d/.test(w) && !/(ing|ment)$/.test(w);
};
const GREETING = "(?:(?:salut|bonjour|bonsoir|allô|allo|hello|hi|hey|coucou|good (?:morning|evening|afternoon))\\s*[,!.]?\\s*)?";
const START = "(?:^|[.!?\\n]\\s*)";
/** A candidate name follows each of these. Group 1 is the candidate word. */
const NAME_INTROS: RegExp[] = [
  new RegExp(`\\bje m['’]?\\s?appelle\\s+(${NAME_WORD})`, "iu"),
  new RegExp(`\\bmoi,?\\s+c['’]?\\s?est\\s+(${NAME_WORD})`, "iu"),
  new RegExp(`\\bc['’]?\\s?est\\s+(${NAME_WORD})(?:\\s+${NAME_WORD})?\\s+qui\\s+(?:vous\\s+)?(?:écri|ecri|parle)`, "iu"),
  new RegExp(`\\bmon\\s+(?:nom|prénom|prenom|nom de famille)\\s+(?:c['’]?\\s?est|est)\\s+(${NAME_WORD})`, "iu"),
  new RegExp(`${START}${GREETING}ici\\s+(${NAME_WORD})`, "iu"),
  new RegExp(`${START}${GREETING}c['’]?\\s?est\\s+(${NAME_WORD})(?:\\s+${NAME_WORD})?\\s*[,.!]`, "iu"),
  new RegExp(`\\bmy\\s+(?:first\\s+|last\\s+|full\\s+)?name\\s+is\\s+(${NAME_WORD})`, "iu"),
  new RegExp(`\\bcall\\s+me\\s+(${NAME_WORD})`, "iu"),
  new RegExp(`${START}${GREETING}this\\s+is\\s+(${NAME_WORD})`, "iu"),
  new RegExp(`${START}${GREETING}(?:i['’]?m|i\\s+am)\\s+(${NAME_WORD})`, "iu"),
];
/** "Je suis X" only with a capital letter: "je suis malade", "je suis mariée" are states. */
const JE_SUIS = new RegExp(`${START}(?i:${GREETING}je\\s+suis)\\s+(\\p{Lu}[\\p{L}\\p{M}'’-]{1,30})\\s*(?:[,.!]|$|et\\b)`, "u");
/** Signatures at the end: "— Marie", "Merci, Jean", "Thanks, Sam!". */
const SIGNATURES: RegExp[] = [
  new RegExp(`(?:^|[.!?\\n])\\s*[—–-]{1,2}\\s*(${NAME_WORD})(?:\\s+${NAME_WORD})?\\s*[.!]?\\s*$`, "iu"),
  new RegExp(`\\b(?:merci|thanks|thank you|cordialement|bonne journée|bonne soirée|regards|best)\\s*[,!.]?\\s+(${NAME_WORD})(?:\\s+${NAME_WORD})?\\s*[.!]?\\s*$`, "iu"),
];

/** True when the text introduces its writer by name, or signs with a name. */
export function nameInIntro(text: string): boolean {
  for (const re of NAME_INTROS) {
    const m = re.exec(text);
    if (m && nameLike(m[1])) return true;
  }
  const j = JE_SUIS.exec(text);
  if (j && nameLike(j[1])) return true;
  for (const re of SIGNATURES) {
    const m = re.exec(text.trim());
    if (m && nameLike(m[1]) && !/^(beaucoup|encore|again|so|much|lot|d['’]avance|in advance|you|bien|infiniment|mille)$/i.test(m[1]!)) return true;
  }
  return false;
}

/**
 * Deterministic layer. It runs in the Worker before any API call, so these
 * identifiers never leave the Worker. Returns the kinds it found.
 */
export function regexPii(text: string): PiiKind[] {
  const kinds = new Set<PiiKind>();
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(text)) kinds.add("email_address");
  for (const m of text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g)) {
    const d = m[0].replace(/\D/g, "");
    if (!TOLL_FREE.test(d)) kinds.add("phone_number");
  }
  if (FULL_POSTAL.test(text)) kinds.add("postal_code");
  if (/\b[A-Z]{4}[ -]?\d{4}[ -]?\d{4}\b/i.test(text)) kinds.add("health_insurance_number");
  for (const m of text.matchAll(/\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length === 9 && luhn(d)) kinds.add("other_identifier");
  }
  // A file, chart, case or reference keyword followed by a number with 4+ digits.
  // A bare year ("depuis 2019") is not a file number; a phone-shaped number is the phone rule's job.
  for (const m of text.matchAll(FILE_NO)) {
    const value = m[2] ?? "";
    const n = digitCount(value);
    if (n >= 5 && n < 10) kinds.add("file_number");
    else if (n === 4 && !/^(19|20)\d{2}$/.test(value)) kinds.add("file_number");
  }
  // A birth keyword followed by a full date. A birth year alone is like an age: allowed.
  const b = text.search(BIRTH_WORD);
  if (b >= 0 && FULL_DATE.test(text.slice(b, b + 60))) kinds.add("date_of_birth");
  if (nameInIntro(text)) kinds.add("person_name");
  return [...kinds];
}

export interface EntitySpan {
  type: string;
  text: string;
  probability: number;
  start: number;
  end: number;
}

const PLACE_BEFORE =
  /(h[oô]pital|hospital|clsc|chsld|clinique|clinic|pharmacie|pharmacy|rue|street|boul(evard)?|avenue|chemin|m[ée]tro|pavillon|centre|center|parc|[ée]cole|school)\s*$/i;

/** Post-filter for entity spans: drops spans that the policy allows. */
export function keepPiiSpan(span: EntitySpan, text: string): boolean {
  const s = span.text;
  switch (span.type) {
    case "postal_code":
      return FULL_POSTAL.test(s); // A 3-character FSA such as H2X is allowed.
    case "phone_number": {
      const d = s.replace(/\D/g, "");
      return d.length >= 7 && !TOLL_FREE.test(d); // 811, 911 and toll-free service lines are allowed.
    }
    case "person_name": {
      if (/^(saint|sainte|st|ste)[ .-]/i.test(s) || BRAND.test(s)) return false;
      if (namedPlaceRanges(text).some(([a, b]) => span.start < b && span.end > a)) return false;
      const before = text.slice(Math.max(0, span.start - 25), span.start);
      return !PLACE_BEFORE.test(before) && !ARTICLE_BEFORE.test(before);
    }
    case "date_of_birth": {
      // Needs a day and month (a bare year is like an age) and a year or a birth keyword.
      // A future year is an appointment, not a birth date.
      const y = s.match(YEAR);
      if (y && Number(y[0]) > new Date().getFullYear()) return false;
      return (HAS_MONTH.test(s) || NUM_DATE.test(s)) && (!!y || SPELLED_YEAR.test(s) || BIRTH_WORD.test(text));
    }
    case "street_address":
      // A street with no civic number (rue Masson) is allowed.
      return /\d/.test(s) || CIVIC_BEFORE.test(text.slice(Math.max(0, span.start - 12), span.start));
    case "health_insurance_number":
      return digitCount(s) >= 6; // A RAMQ number has 8 digits; drops GMF, CHSLD, RSV, "811 option 2".
    case "file_number":
    case "other_identifier":
      return digitCount(s) >= 4;
    default:
      return true;
  }
}
