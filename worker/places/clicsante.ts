// Clic Santé: service catalog, deep links to the portal list page, and the read API client.
//
// Rules:
// - We never book and never go past the portal list page. Each result is a link that the person
//   opens to book on Clic Santé.
// - A link and an API search carry the position of the full postal code rounded to 3 decimals
//   (about 100 m), or the FSA centroid when the code is not in the postal file. Never the postal
//   code itself.
// - api3.clicsante.ca forbids robots (robots.txt "Disallow: /") and the terms forbid
//   republication. The API client below stays OFF (Worker var CLICSANTE_API) until Clic Santé
//   gives written permission. When on: honest User-Agent, cache, global rate limit, GET only.
import catalog from "../../shared/clicsante-catalog.json";
import type { Lang } from "../../shared/api";
import type { AppointmentLink, AppointmentPlace } from "../../shared/places";
import type { JsonCache } from "./cache";

export const PORTAL = "https://portal3.clicsante.ca";

/** Service template ids that the portal hard-codes, with names and search words. */
export const KNOWN_SERVICES: { id: number; slug: string; fr: string; en: string; words: string }[] = [
  {
    id: 3161,
    slug: "vaccination-virus-respiratoires",
    fr: "Vaccination contre les virus respiratoires (grippe et COVID-19)",
    en: "Respiratory virus vaccination (flu and COVID-19)",
    words: "grippe influenza flu covid virus respiratoires respiratory vaccin vaccine vaccination",
  },
  {
    id: 195,
    slug: "vaccination-contre-l-influenza",
    fr: "Vaccination contre la grippe (influenza)",
    en: "Flu vaccination",
    words: "grippe influenza flu vaccin vaccine",
  },
  {
    id: 204,
    slug: "vaccination-contre-la-covid-19",
    fr: "Vaccination contre la COVID-19",
    en: "COVID-19 vaccination",
    words: "covid covid-19 coronavirus vaccin vaccine",
  },
  {
    id: 3079,
    slug: "vaccination-contre-le-virus-respiratoire-syncytial-vrs",
    fr: "Vaccination contre le VRS",
    en: "RSV vaccination",
    words: "vrs rsv syncytial vaccin vaccine adulte aine senior",
  },
  {
    id: 3157,
    slug: "immunisation-vrs-bebes",
    fr: "Immunisation contre le VRS des bébés",
    en: "RSV immunization for babies",
    words: "vrs rsv bebe bebes baby babies nourrisson infant immunisation",
  },
  {
    id: 1000,
    slug: "vaccination-contre-la-rougeole-la-rubeole-la-varicelle-et-les-oreillons",
    fr: "Vaccination contre la rougeole, la rubéole, la varicelle et les oreillons",
    en: "Measles, mumps, chickenpox and rubella vaccination",
    words: "rougeole rubeole varicelle oreillons measles mumps rubella chickenpox rro mmr vaccin vaccine",
  },
  { id: 227, slug: "prise-de-sang", fr: "Prise de sang", en: "Blood test", words: "prise sang prelevement blood test sample analyse" },
  {
    id: 3034,
    slug: "consultation-en-sante-mentale",
    fr: "Consultation en santé mentale",
    en: "Mental health consultation",
    words: "sante mentale mental health anxiete depression",
  },
  {
    id: 3166,
    slug: "therapeute-relation-d-aide",
    fr: "Thérapeute en relation d'aide",
    en: "Therapist",
    words: "therapeute therapist relation aide counselling",
  },
  { id: 3169, slug: "psychologue", fr: "Psychologue", en: "Psychologist", words: "psychologue psychologist psychologie" },
  { id: 3185, slug: "psychiatre", fr: "Psychiatre", en: "Psychiatrist", words: "psychiatre psychiatrist" },
  {
    id: 2446,
    slug: "consultation-avec-une-travailleuse-sociale",
    fr: "Consultation avec une travailleuse sociale",
    en: "Social worker consultation",
    words: "travailleuse travailleur social sociale social worker",
  },
];

interface CatalogEntry {
  slug: string;
  slugEn: string;
  id: number | null;
  fr: string;
  en: string;
  words: string;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_-]+/g, " ")
    .trim();

/** "vaccination-contre-l-influenza" -> "Vaccination contre l'influenza" (display only). */
export function slugTitle(slug: string, lang: Lang): string {
  let s = slug.replace(/[_-]+/g, " ").trim();
  s = lang === "fr" ? s.replace(/\b([ldjs]|qu) (?=[a-zàâéèêëîïôûüç])/g, "$1'") : s.replace(/ s\b/g, "'s");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const known = new Map(KNOWN_SERVICES.map((k) => [k.slug, k]));

export const CATALOG: CatalogEntry[] = (catalog.services as { fr: string; en: string }[]).map(({ fr, en }) => {
  const k = known.get(fr);
  return {
    slug: fr,
    slugEn: en,
    id: k?.id ?? null,
    fr: k?.fr ?? slugTitle(fr, "fr"),
    en: k?.en ?? slugTitle(en, "en"),
    words: fold(`${fr} ${en} ${k?.words ?? ""}`),
  };
});
// A known service missing from the sitemap still gets an entry.
for (const k of KNOWN_SERVICES) {
  if (!CATALOG.some((c) => c.slug === k.slug))
    CATALOG.push({ slug: k.slug, slugEn: k.slug, id: k.id, fr: k.fr, en: k.en, words: fold(`${k.slug} ${k.words}`) });
}

const STOP = new Set([
  "de",
  "la",
  "le",
  "les",
  "des",
  "du",
  "un",
  "une",
  "et",
  "a",
  "au",
  "aux",
  "pour",
  "en",
  "contre",
  "the",
  "of",
  "and",
  "for",
  "to",
  "a",
  "an",
  "rendez",
  "vous",
  "rdv",
  "appointment",
  "appointments",
  "clic",
  "sante",
]);

/** Catalog services that match the words of a query, best first (known ids first on ties). */
export function findServices(query: string, limit = 6): CatalogEntry[] {
  const words = fold(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return [];
  return CATALOG.map((c) => {
    const tokens = c.words.split(" ");
    const score = words.reduce(
      (n, w) =>
        n + (tokens.includes(w) ? 2 : tokens.some((t) => t.startsWith(w) || (w.length > 4 && t.startsWith(w.slice(0, -1)))) ? 1 : 0),
      0,
    );
    return { c, score: score + (c.id !== null && score > 0 ? 0.5 : 0) };
  })
    .filter((x) => x.score > 0.5)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

/** The catalog entry for a slug (fr or en) or a numeric id. */
export function serviceOf(key: string): CatalogEntry | null {
  const k = key.trim().toLowerCase();
  if (/^\d{1,6}$/.test(k)) return CATALOG.find((c) => c.id === Number(k)) ?? null;
  return CATALOG.find((c) => c.slug === k || c.slugEn === k) ?? null;
}

const round3 = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The portal list page for a service near a position (3 decimals). A service without a known id gets
 * its portal service page (the person enters a location there).
 */
export function portalLink(entry: CatalogEntry, lang: Lang, centroid: { lat: number; lng: number } | null): string {
  if (entry.id === null) return lang === "en" ? `${PORTAL}/en/services/${entry.slugEn}` : `${PORTAL}/services/${entry.slug}`;
  const params = new URLSearchParams({ serviceId: String(entry.id) });
  if (centroid) {
    params.set("latitude", round3(centroid.lat));
    params.set("longitude", round3(centroid.lng));
  }
  params.set("fees", "0");
  params.set("performSearch", "true");
  return `${PORTAL}${lang === "en" ? "/en" : "/"}?${params}`;
}

export function appointmentLink(
  entry: CatalogEntry,
  lang: Lang,
  centroid: { lat: number; lng: number } | null,
  area: string | null,
): AppointmentLink {
  return {
    serviceId: entry.id,
    slug: entry.slug,
    name: { fr: entry.fr, en: entry.en },
    area: centroid ? area : null,
    url: portalLink(entry, lang, centroid),
  };
}

// ---------------------------------------------------------------------------------------------
// Read API client. The Worker var CLICSANTE_API turns it on or off. Never called while it is off.

export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ClicSanteApiDeps {
  fetcher: typeof fetch;
  cache: JsonCache;
  /** Global rate limit, about 1 request per second for the whole site (rate limit binding). */
  limiter?: Limiter;
  now: () => number;
  log: (e: Record<string, string | number | boolean | undefined>) => void;
}

export const API_BASE = "https://api3.clicsante.ca";
export const USER_AGENT = "AgentSante/1.0 (+https://agentsante.ca)";
const API_CACHE_SECONDS = 600;

export class ClicSanteError extends Error {
  constructor(readonly code: "clicsante_rate_limited" | "clicsante_unavailable" | "clicsante_bad_answer") {
    super(code);
  }
}

type Counts = { t02?: number; t07?: number; ta7?: number };

// The API answers in snake_case (name_fr, formatted_address, is_physical_location,
// is_virtual), and the counts sit on each service of a place. The
// camelCase names come from the portal code and are kept as a fallback.
interface RawAvailabilityPage {
  places?: {
    id?: number;
    name_fr?: string;
    name_en?: string;
    nameFr?: string;
    nameEn?: string;
    address?: string;
    city?: string;
    formatted_address?: string;
    formattedAddress?: string;
    latitude?: number;
    longitude?: number;
    is_physical_location?: boolean;
    isPhysicalLocation?: boolean;
    is_virtual?: number | boolean;
    openToPublic?: boolean;
    settings?: { setting?: number; value?: string }[];
    services?: { st_id?: number; availabilities?: Counts }[];
    availabilities?: Record<string, Counts> | null;
  }[];
  distanceByPlaces?: Record<string, number | string>;
}

/** The counts of a place for a service: the services of that template, else every service, else the place counts. */
function countsOf(p: NonNullable<RawAvailabilityPage["places"]>[number], serviceId?: number): Counts {
  const services = (p.services ?? []).filter((x) => x.availabilities);
  const own = services.filter((x) => x.st_id === serviceId);
  const pick = (own.length ? own : services).map((x) => x.availabilities ?? {});
  if (pick.length) {
    const max = (k: keyof Counts) => Math.max(0, ...pick.map((c) => Number(c[k] ?? 0)));
    return { t02: max("t02"), t07: max("t07"), ta7: max("ta7") };
  }
  const a = p.availabilities ?? {};
  return a.sunull ?? Object.values(a)[0] ?? {};
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Turns one availability page into places with slot counts, nearest first. Never returns booking URLs. */
export function parseAvailabilities(page: RawAvailabilityPage, lang: Lang, limit = 10, serviceId?: number): AppointmentPlace[] {
  const out: AppointmentPlace[] = [];
  for (const p of page.places ?? []) {
    if (typeof p.id !== "number" || typeof p.latitude !== "number" || typeof p.longitude !== "number") continue;
    const physical = p.is_physical_location ?? p.isPhysicalLocation;
    if (physical === false || p.openToPublic === false || p.is_virtual === 1 || p.is_virtual === true) continue;
    const a = countsOf(p, serviceId);
    const slots = { days2: a.t02 ?? 0, days7: a.t07 ?? 0, later: a.ta7 ?? 0 };
    if (!slots.days7 && !slots.later) continue;
    const hidden = (p.settings ?? []).some((s) => s.setting === 198 && s.value === "1");
    const raw = page.distanceByPlaces?.[String(p.id)];
    const d = typeof raw === "string" ? Number.parseFloat(raw) : raw;
    out.push({
      id: String(p.id),
      name: (lang === "en" ? p.name_en || p.nameEn || p.name_fr || p.nameFr : p.name_fr || p.nameFr || p.name_en || p.nameEn) ?? "",
      address: p.formatted_address ?? p.formattedAddress ?? [p.address, p.city].filter(Boolean).join(", "),
      lat: p.latitude,
      lng: p.longitude,
      distanceKm: !hidden && typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.round(d * 10) / 10 : null,
      slots,
    });
  }
  return out.toSorted((x, y) => (x.distanceKm ?? 1e9) - (y.distanceKm ?? 1e9)).slice(0, limit);
}

/** First page of places with free slots for a service near a position. */
export async function searchAvailabilities(
  deps: ClicSanteApiDeps,
  q: { serviceId: number; lat: number; lng: number; radiusKm: number; lang: Lang },
): Promise<AppointmentPlace[]> {
  const start = isoDay(deps.now());
  const stop = isoDay(deps.now() + 120 * 86_400_000);
  const params = new URLSearchParams({
    dateStart: start,
    dateStop: stop,
    serviceTemplate: String(q.serviceId),
    latitude: round3(q.lat),
    longitude: round3(q.lng),
    maxDistance: String(q.radiusKm),
    page: "0",
    gapMode: "false",
    placeSettings: "188,198,222,243",
  });
  const path = `/v3/availabilitiesByGeolocalisation?${params}`;
  const key = `cs${path}`;
  const cached = await deps.cache.get<RawAvailabilityPage>(key);
  if (cached) return parseAvailabilities(cached, q.lang, 10, q.serviceId);
  if (deps.limiter) {
    let ok = true;
    try {
      ok = (await deps.limiter.limit({ key: "clicsante" })).success;
    } catch {
      ok = false; // Fail closed: no limiter answer, no call to a third party.
    }
    if (!ok) throw new ClicSanteError("clicsante_rate_limited");
  }
  const started = deps.now();
  let res: Response;
  try {
    res = await deps.fetcher(`${API_BASE}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        product: "clicsante",
        "x-trimoz-role": "public",
        "x-trimoz-access-token": "public",
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    deps.log({ event: "clicsante_call", status: 0, ms: deps.now() - started });
    throw new ClicSanteError("clicsante_unavailable");
  }
  deps.log({ event: "clicsante_call", status: res.status, ms: deps.now() - started });
  if (res.status === 204) {
    await deps.cache.put(key, { places: [] }, API_CACHE_SECONDS);
    return [];
  }
  if (!res.ok) throw new ClicSanteError("clicsante_unavailable");
  let page: RawAvailabilityPage;
  try {
    page = (await res.json()) as RawAvailabilityPage;
  } catch {
    throw new ClicSanteError("clicsante_bad_answer");
  }
  await deps.cache.put(key, page, API_CACHE_SECONDS);
  return parseAvailabilities(page, q.lang, 10, q.serviceId);
}
