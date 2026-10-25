// Direct routing of the first message: one milliseconds classify call over the specialists of
// the language, plus "unclear". A clear winner starts that specialist at once; any other case
// starts the concierge. Routing is not a safety check: on any failure the concierge answers.
// A message that names a vaccine goes to the vaccines agent with no call.
import type { Agents } from "../../shared/agents";
import type { Lang } from "../../shared/api";

/**
 * Direct route rule: the winner goes direct when its probability is at least ROUTE_THRESHOLD,
 * or at least ROUTE_LOW and ROUTE_RATIO times the second score. The classify scores of French
 * questions spread over many labels, so a clear winner can have a low probability but a wide
 * margin.
 */
export const ROUTE_THRESHOLD = 0.5;
export const ROUTE_LOW = 0.3;
export const ROUTE_RATIO = 2.5;

export const UNCLEAR = "unclear";

export const ROUTE_QUESTION = "Which health information assistant should answer this first message from a person in Quebec?";

const UNCLEAR_DESCRIPTION = "a greeting, a thank-you, a question about this website, or a message with no clear health topic";

/**
 * Router descriptions in English (the milliseconds docs recommend English text), keyed by the
 * English agent id. They are more precise than the one-line agent descriptions of agents.json.
 * An agent with no entry here uses the English description from agents.json.
 */
export const ROUTE_DESCRIPTIONS: Record<string, string> = {
  "en/viruses-vaccines":
    'any vaccine or vaccination, for any age: which vaccines, who can get one, if it is free, where and when to get vaccinated, vaccination appointments near me. Not for being sick. Examples: "where can I get a flu shot", "is the flu vaccine free", "book a COVID vaccine near me", "when can my baby get the RSV vaccine"',
  "en/flu":
    'being sick with the flu, COVID-19, RSV or a cold: fever, cough, sore throat, body aches, home care, when to see a doctor, antivirals, contagion and staying home. Examples: "I think I have the flu", "I have a fever and a cough", "can I get an antiviral", "what can I do at home for the flu", "I tested positive for COVID"',
  "en/gastro":
    'gastroenteritis (gastro, stomach flu) in adults, children and babies: vomiting, diarrhea, staying hydrated, rehydration solutions, what to eat, contagion and when to see a doctor. Examples: "I have vomiting and diarrhea", "my baby is throwing up", "my kid has diarrhea", "how do I keep my family from catching gastro"',
  "en/seniors":
    'older people and their caregivers: home care and help at home, respite, residences and long-term care (CHSLD), palliative and end-of-life care. Examples: "my mother is 85 and needs help at home", "a place in a CHSLD", "respite for a caregiver"',
  "en/mental-health":
    'mental health: anxiety, depression, stress, grief, suicide, addiction, and psychosocial help such as 811 option 2. Examples: "I feel anxious all the time", "I need to talk to someone", "my son drinks too much"',
  "en/pregnancy-children":
    'pregnancy, birth, breastfeeding, and the health of babies, children and teenagers. Examples: "my child has a fever", "my baby coughs", "I am pregnant, where do I get follow-up"',
  "en/illness-medication":
    'a common health problem or disease that is not the flu, COVID-19, a cold or gastro, its symptoms, and what a pharmacist can do. Examples: "urinary tract infection", "renew my prescription", "sore throat for 3 days", "can a pharmacist treat pink eye"',
  "en/medications":
    'a specific medication or drug product, by its brand or ingredient name: what it is, what it is for, how to take it and the dose on the leaflet, warnings, side effects, or which over-the-counter product exists for a common need. Examples: "what is the dose of Tylenol for an adult", "does Advil have side effects", "what can I take over the counter for a headache", "what is amoxicillin for"',
  "en/access-to-care":
    'where to go and how to get care or an appointment, except vaccination: 811, family doctor (GAMF), GAP, CLSC, GMF, walk-in clinics, pharmacies near me, emergency rooms, blood tests, health card. Examples: "a pharmacy near me", "walk-in clinic open tonight", "where do I get a blood test", "how do I get a family doctor"',
  "en/prevention-environment":
    'healthy habits, screening tests, quitting smoking, alcohol, heat waves, air and water quality, ticks and diseases from animals. Examples: "how do I quit smoking", "a tick bit me", "boil-water advisory"',
  "en/sexual-health":
    'contraception, the morning-after pill, sexually transmitted infections (STBBI) and their testing, sexual and reproductive health. Examples: "where can I get tested for STIs", "morning-after pill", "I forgot my pill"',
};

/** A first message about a vaccine goes straight to the vaccines agent, with no classify call. */
const VACCINE = /vaccin|vaccine|vaccinat|flu shot|covid shot/i;

/** The vaccines specialist of the language when the message names a vaccine, else undefined. */
export function keywordRoute(agents: Agents, lang: Lang, text: string): string | undefined {
  if (!VACCINE.test(text)) return undefined;
  const en = agents.get("en/viruses-vaccines");
  const id = lang === "en" ? en?.id : en?.counterpart;
  const agent = id ? agents.get(id) : undefined;
  return agent && agent.lang === lang ? agent.id : undefined;
}

/** Labels for the classify call: every specialist of the language (agent id -> description), plus "unclear". */
export function routeLabels(agents: Agents, lang: Lang): Record<string, string> {
  const labels: Record<string, string> = {};
  const entry = agents.entry(lang);
  for (const a of agents.catalog.agents) {
    if (a.lang !== lang || a.id === entry) continue;
    const english = a.lang === "en" ? a : agents.get(a.counterpart);
    labels[a.id] = (english && ROUTE_DESCRIPTIONS[english.id]) || english?.description || a.description;
  }
  labels[UNCLEAR] = UNCLEAR_DESCRIPTION;
  return labels;
}

export interface Classified {
  label: string;
  probability: number;
  /** Second best score of the classify call, when it gave the scores. */
  second?: number;
}

/** The specialist to start, or undefined when the concierge must answer first. */
export function pickRoute(agents: Agents, lang: Lang, result: Classified | null): string | undefined {
  if (!result || result.label === UNCLEAR) return undefined;
  const p = result.probability;
  const wide = result.second !== undefined && p >= ROUTE_LOW && p >= ROUTE_RATIO * result.second;
  if (!(p >= ROUTE_THRESHOLD) && !wide) return undefined;
  const agent = agents.get(result.label);
  // Only a specialist of the same language. Never trust a label the call did not send.
  if (!agent || agent.lang !== lang || agent.id === agents.entry(lang)) return undefined;
  return agent.id;
}
