// Client for the health directory API (sante.gouv.qc.ca répertoire, synced by CloudRaker).
// GET /v1/resources?lat&lon&radius_km&q&service&limit gives places sorted by distance.
// GET /v1/resources/{id}/hours?from&to gives the dated opening hours.
// The Worker sends a position rounded to 3 decimals (about 100 m), never a postal code.
import type { PlaceItem, PlaceOpening } from "../../shared/places";
import type { JsonCache } from "./cache";

export interface DirectoryDeps {
  baseUrl: string;
  fetcher: typeof fetch;
  cache: JsonCache;
  now: () => number;
  log: (e: Record<string, string | number | boolean | undefined>) => void;
}

/** Kinds of place that places_search can filter on. Most map to a directory `type` (GET /v1/types). */
export const PLACE_KINDS = [
  "pharmacy",
  "clsc",
  "clinic",
  "specialized_clinic",
  "hospital",
  "crisis_centre",
  "community",
  "rehab",
  "residence",
  "public_health",
  "vaccination",
  "home_care",
  "lab",
] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/**
 * How each kind is found. The directory API has no category, and its `q` matches words in the
 * name and the services, so it returns noise (a residence or a lab for "pharmacie"). The Worker
 * sends a hint (`q` or `service`) to get the right area of the index, then keeps only the places
 * whose folded name (or services) match the kind.
 */
const PHARMACY = /^(pharmacie|pharmaprix|jean[- ]coutu|uniprix|familiprix|proxim|brunet|acces pharma)\b/;
const CLSC = /^(aire ouverte )?clsc\b|^centre local de services communautaires|^point de service (du )?clsc/;
const CLINIC = (n: string) =>
  /\bgmf\b|groupe de medecine|\bclinique medicale\b|\bcentre medical\b|\bpolyclinique\b|\bsuperclinique\b|\bgroupe medical\b|cooperative de (solidarite )?sante|clinique (familiale|sans rendez-vous|de medecine)|\bips\b|infirmieres? praticiennes?/.test(n) &&
  !/dentaire|dentiste|laboratoire|physio|chiropra|optometr|audiolog|veterinaire/.test(n);

const ANY = () => true;

/**
 * A kind with a `type` uses the directory filter (the API classifies each place). The other
 * kinds have no directory type: a hint (`q` or `service`) plus a name or service match.
 */
export const KIND_RULES: Record<
  PlaceKind,
  { type?: string; q?: string; service?: string; keep: (name: string, services: string[]) => boolean }
> = {
  pharmacy: { type: "pharmacie", keep: ANY },
  clsc: { type: "clsc", keep: ANY },
  clinic: { type: "clinique", keep: ANY },
  specialized_clinic: { type: "clinique-specialisee", keep: ANY },
  hospital: { type: "hopital", keep: ANY },
  crisis_centre: { type: "centre-crise", keep: ANY },
  community: { type: "organisme-communautaire", keep: ANY },
  rehab: { type: "readaptation", keep: ANY },
  residence: { type: "hebergement", keep: ANY },
  public_health: { type: "sante-publique", keep: ANY },
  // Residences and CHSLD vaccinate their own residents: keep the places open to the public.
  vaccination: {
    service: "vaccination",
    keep: (n, s) => s.some((x) => /vaccination/.test(fold(x))) && (PHARMACY.test(n) || CLSC.test(n) || CLINIC(n) || /vaccination/.test(n)),
  },
  home_care: { service: "soutien à domicile", keep: (_n, s) => s.some((x) => /domicile/.test(fold(x))) },
  lab: { q: "prélèvements", keep: (n) => /laboratoire|\bbiron\b|\bcdl\b|centre de prelevement/.test(n) },
};

export interface PlaceQuery {
  lat: number;
  lng: number;
  /** A kind filter. With it, `query` and `service` are ignored. */
  kind?: PlaceKind;
  query?: string;
  service?: string;
  radiusKm: number;
  limit: number;
}

interface RawResource {
  id: string;
  name: string;
  address?: { street?: string | null; city?: string | null; raw?: string | null };
  location?: { latitude?: number | null; longitude?: number | null } | null;
  services?: string[];
  source_url?: string;
  distance_km?: number | null;
}

interface RawSchedule {
  date: string;
  status: string;
  intervals?: { opens: string; closes: string; end_day_offset?: number }[];
}

const TIMEOUT_MS = 5000;
const CACHE_SECONDS = 300;
/** Hours are fetched for this many places at most (one request each, cached). */
const HOURS_FOR = 10;

export class DirectoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Local Québec date and time: ["2026-10-24", "14:05"]. */
export function quebecNow(nowMs: number): [string, string] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(nowMs);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}`];
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The next opening from now in dated schedules, or null. */
export function nextOpening(schedules: RawSchedule[], nowMs: number): PlaceOpening | null {
  const [today, time] = quebecNow(nowMs);
  const sorted = schedules.filter((s) => s.status === "open" && s.date >= today).toSorted((a, b) => a.date.localeCompare(b.date));
  for (const s of sorted) {
    for (const i of (s.intervals ?? []).toSorted((a, b) => a.opens.localeCompare(b.opens))) {
      const overnight = (i.end_day_offset ?? 0) > 0;
      if (s.date === today) {
        if (overnight || i.closes > time) return { date: s.date, opens: i.opens, closes: i.closes, now: i.opens <= time };
        continue;
      }
      return { date: s.date, opens: i.opens, closes: i.closes, now: false };
    }
  }
  return null;
}

/** GET a directory API path, cached for CACHE_SECONDS. Also used by the drug tools (worker/drugs.ts). */
export async function getJson<T>(deps: DirectoryDeps, path: string): Promise<T> {
  const cached = await deps.cache.get<T>(`dir${path}`);
  if (cached !== undefined) return cached;
  let res: Response;
  const started = deps.now();
  try {
    res = await deps.fetcher(`${deps.baseUrl.replace(/\/$/, "")}${path}`, {
      headers: { accept: "application/json", "user-agent": "AgentSante/1.0 (+https://agentsante.ca)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    deps.log({ event: "directory_call", status: 0, ms: deps.now() - started });
    throw new DirectoryError("directory_unavailable");
  }
  deps.log({ event: "directory_call", status: res.status, ms: deps.now() - started });
  if (!res.ok) throw new DirectoryError(res.status === 400 ? "directory_bad_query" : "directory_unavailable");
  const body = (await res.json()) as T;
  await deps.cache.put(`dir${path}`, body, CACHE_SECONDS);
  return body;
}

const fold = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Up to 4 services, the ones that match the search words first. */
export function topServices(services: string[], words: string[]): string[] {
  const hit = (s: string) => words.some((w) => fold(s).includes(w));
  return [...services.filter(hit), ...services.filter((s) => !hit(s))].slice(0, 4);
}

function toItem(r: RawResource, words: string[] = []): PlaceItem | null {
  const lat = r.location?.latitude;
  const lng = r.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number" || !r.id || !r.name) return null;
  const street = r.address?.street?.trim() ?? "";
  const city = r.address?.city?.trim() || null;
  return {
    id: String(r.id),
    name: r.name,
    address: [street, city].filter(Boolean).join(", "),
    city,
    lat,
    lng,
    distanceKm: typeof r.distance_km === "number" ? Math.round(r.distance_km * 10) / 10 : null,
    services: topServices(r.services ?? [], words),
    next: null,
    sourceUrl: r.source_url?.startsWith("https://sante.gouv.qc.ca/") ? r.source_url : "https://sante.gouv.qc.ca/repertoire-ressources/",
  };
}

/** Places near a position, nearest first, each with its next opening when known. */
export async function searchPlaces(deps: DirectoryDeps, q: PlaceQuery): Promise<PlaceItem[]> {
  const rule = q.kind ? KIND_RULES[q.kind] : undefined;
  const query = rule ? rule.q : q.query;
  const service = rule ? rule.service : q.service;
  const params = new URLSearchParams({
    lat: String(round3(q.lat)),
    lon: String(round3(q.lng)),
    radius_km: String(q.radiusKm),
    // A kind without a directory type asks for a full page: the filter below drops the noise.
    limit: String(rule && !rule.type ? 100 : q.limit),
  });
  if (rule?.type) params.set("type", rule.type);
  if (query) params.set("q", query);
  if (service) params.set("service", service);
  const page = await getJson<{ data?: RawResource[] }>(deps, `/v1/resources?${params}`);
  const words = fold(`${query ?? ""} ${service ?? ""}`)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  const items = (page.data ?? [])
    .filter((r) => !rule || rule.keep(fold(r.name ?? ""), r.services ?? []))
    .map((r) => toItem(r, words))
    .filter((x): x is PlaceItem => x !== null)
    .filter((x) => x.distanceKm === null || x.distanceKm <= q.radiusKm)
    .slice(0, q.limit);
  const [today] = quebecNow(deps.now());
  const to = addDays(today, 6);
  await Promise.all(
    items.slice(0, HOURS_FOR).map(async (item) => {
      try {
        const hours = await getJson<{ schedules?: RawSchedule[] }>(
          deps,
          `/v1/resources/${encodeURIComponent(item.id)}/hours?from=${today}&to=${to}`,
        );
        item.next = nextOpening(hours.schedules ?? [], deps.now());
      } catch {
        item.next = null; // Hours are a bonus: the place still shows.
      }
    }),
  );
  return items;
}
