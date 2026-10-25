// Tool API for the agents, under /tools/v1. Run calls it through its egress with the header
// `x-agent-sante-tools: <TOOLS_SECRET>` (agent.yml `network:` template). The browser never calls it.
//
// The model never handles a position or a postal code. It passes `near`, the opaque place
// reference that the Worker wrote in the message marker ("lieu : ref-..."), and the Worker finds
// the position of the session. Results go to the session place store; the chat pipeline sends
// them to the browser with the checked reply. The model gets a short summary only.
import { Hono, type Context } from "hono";
import type { Lang } from "../shared/api";
import { isLang } from "../shared/api";
import type { AppointmentLink, PlaceItem } from "../shared/places";
import { appointmentLink, findServices, searchAvailabilities, serviceOf, ClicSanteError, type ClicSanteApiDeps } from "./places/clicsante";
import { DirectoryError, PLACE_KINDS, searchPlaces, type DirectoryDeps, type PlaceKind } from "./places/directory";
import { leafletSource, readLeaflet, searchDrugs, searchLeaflet } from "./drugs";
import { areaLabel, PLACE_REF, shownLabel, type PostalLookup } from "./places/postal";
import type { PlaceStore, SessionPlace } from "./places/store-core";

export interface ToolsDeps {
  /** Worker secret TOOLS_SECRET. Empty: every call answers 503. */
  secret: string;
  places: PlaceStore;
  directory: DirectoryDeps;
  /** Present only when the Worker var CLICSANTE_API is "on". */
  clicsante?: ClicSanteApiDeps;
  postal?: PostalLookup;
  now: () => number;
  log: (e: Record<string, string | number | boolean | undefined>) => void;
}

type Env = { Variables: { deps: ToolsDeps } };

export const TOOLS_HEADER = "x-agent-sante-tools";

const NOTE = {
  fr: "La personne voit la liste complète (et la carte) sous votre réponse. Ne recopiez pas la liste. Résumez en 1 à 3 phrases.",
  en: "The person sees the full list (and the map) under your reply. Do not copy the list. Summarize in 1 to 3 sentences.",
};
const LINK_NOTE = {
  fr: "La personne voit un bouton vers la page de résultats de Clic Santé sous votre réponse. Ne donnez pas d'adresse web. La réservation se fait sur Clic Santé, par la personne. Ne dites jamais que vous réservez.",
  en: "The person sees a button to the Clic Santé results page under your reply. Do not give a web address. The person books on Clic Santé. Never say that you book.",
};
/** Longest leaflet text sent to the agent. A longer one needs `question` (passages) or is cut. */
const MAX_LEAFLET_CHARS = 12_000;
const DRUG_SEARCH_NOTE = {
  fr: "otc: true = vente libre (drug_info donne la notice). prescription: true = sur ordonnance : dites seulement ce que c'est (nom, ingrédient) et que le médecin ou le pharmacien décide. Ne proposez jamais un médicament sur ordonnance.",
  en: "otc: true = over the counter (drug_info gives the leaflet). prescription: true = prescription only: say only what it is (name, ingredient) and that a doctor or pharmacist decides. Never suggest a prescription drug.",
};
const RX_NOTE = {
  fr: "Médicament sur ordonnance : pas de notice ici. Dites ce que c'est (nom, ingrédient) et dirigez la personne vers son pharmacien ou son médecin. Ne le proposez pas comme option.",
  en: "Prescription drug: no leaflet here. Say what it is (name, ingredient) and direct the person to their pharmacist or doctor. Do not suggest it as an option.",
};
const NO_LEAFLET = {
  fr: "La notice de ce produit n'est pas encore disponible. Dirigez la personne vers son pharmacien, qui peut répondre sans rendez-vous.",
  en: "The leaflet of this product is not available yet. Direct the person to their pharmacist, who can answer without an appointment.",
};
const LEAFLET_NOTE = {
  fr: 'Citez la notice mot pour mot avec <citation src="cite_src">texte exact</citation>. La personne voit sous la citation que l\'information vient de la notice et qu\'elle doit demander conseil à son pharmacien.',
  en: 'Quote the leaflet word for word with <citation src="cite_src">exact text</citation>. Under the quote, the person sees that the information comes from the leaflet and that they should ask their pharmacist.',
};
const DRUGS_DOWN = {
  fr: "La base de données des médicaments ne répond pas. Dirigez la personne vers son pharmacien.",
  en: "The drug database does not answer. Direct the person to their pharmacist.",
};

const NO_PLACE = {
  error: "unknown_place",
  message: "No place for this reference. Ask the person for their postal code (only the postal code, nothing else).",
};

/** Constant-time compare of two strings. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < u.length; i++) diff |= u[i]! ^ v[i]!;
  return diff === 0;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
const num = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

const hhmm = (p: PlaceItem["next"]) => (p ? (p.now ? `open now until ${p.closes}` : `${p.date} ${p.opens}-${p.closes}`) : null);

async function body(c: Context<Env>): Promise<Record<string, unknown>> {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

async function resolvePlace(deps: ToolsDeps, near: unknown): Promise<{ ref: string; place: SessionPlace } | null> {
  const ref = typeof near === "string" ? near.trim().toLowerCase() : "";
  if (!PLACE_REF.test(ref)) return null;
  const place = await deps.places.get(ref);
  return place ? { ref, place } : null;
}

export function createTools(makeDeps: (c: Context<Env>) => ToolsDeps) {
  const app = new Hono<Env>().basePath("/tools/v1");

  app.use("*", async (c, next) => {
    const deps = makeDeps(c);
    c.set("deps", deps);
    if (!deps.secret) {
      deps.log({ event: "tools_misconfigured", alert: true });
      return c.json({ error: "unavailable" }, 503);
    }
    if (!(await sameSecret(c.req.header(TOOLS_HEADER) ?? "", deps.secret))) {
      deps.log({ event: "tools_forbidden" });
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
    c.header("cache-control", "no-store");
    deps.log({ event: "tool_call", route: new URL(c.req.url).pathname, status: c.res.status });
  });

  /** Health directory places near the session position. */
  app.post("/places_search", async (c) => {
    const deps = c.get("deps");
    const b = await body(c);
    const found = await resolvePlace(deps, b.near);
    if (!found) return c.json(NO_PLACE, 404);
    const lang: Lang = isLang(b.lang) ? b.lang : found.place.lang;
    const query = str(b.query, 120);
    const service = str(b.service, 120);
    const kind = (PLACE_KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as PlaceKind) : undefined;
    const radiusKm = num(b.radius_km, 1, 50, 10);
    const limit = Math.round(num(b.limit, 1, 20, 10));
    let items: PlaceItem[];
    try {
      items = await searchPlaces(deps.directory, { lat: found.place.lat, lng: found.place.lng, kind, query, service, radiusKm, limit });
    } catch (error) {
      const code = error instanceof DirectoryError ? error.code : "directory_unavailable";
      return c.json(
        {
          error: code,
          message:
            "The directory is not available. Give the official directory link instead: https://sante.gouv.qc.ca/repertoire-ressources/",
        },
        code === "directory_bad_query" ? 400 : 503,
      );
    }
    const area = areaLabel(found.place);
    // The person sees their full postal code; the agent answer keeps the area only.
    if (items.length) await deps.places.add(found.ref, { kind: "places", at: deps.now(), area: shownLabel(found.place), items });
    return c.json({
      area,
      radius_km: radiusKm,
      count: items.length,
      nearest: items.slice(0, 3).map((i) => ({ name: i.name, city: i.city, distance_km: i.distanceKm, next_opening: hhmm(i.next) })),
      shown_to_person: items.length > 0,
      note: items.length
        ? NOTE[lang]
        : lang === "fr"
          ? "Aucun résultat. Proposez un rayon plus grand ou un autre mot."
          : "No result. Offer a larger radius or another word.",
    });
  });

  /** Clic Santé services that match a query (no position needed). */
  app.post("/appointments_services", async (c) => {
    const b = await body(c);
    const query = str(b.query, 120);
    if (!query) return c.json({ error: "invalid_params", message: "query is required" }, 400);
    const lang: Lang = isLang(b.lang) ? b.lang : "fr";
    return c.json({
      services: findServices(query).map((s) => ({ service: s.slug, name: lang === "en" ? s.en : s.fr, list_page: s.id !== null })),
    });
  });

  /** A link to the Clic Santé list page of a service near the session (FSA centroid). */
  app.post("/appointments_link", async (c) => {
    const deps = c.get("deps");
    const b = await body(c);
    const entry = typeof b.service === "string" || typeof b.service === "number" ? serviceOf(String(b.service)) : null;
    if (!entry) return c.json({ error: "unknown_service", message: "Use appointments_services to find the service." }, 400);
    const found = await resolvePlace(deps, b.near);
    if (!found) return c.json(NO_PLACE, 404);
    const lang: Lang = isLang(b.lang) ? b.lang : found.place.lang;
    const area = `${found.place.fsa}${found.place.municipality ? ` (${found.place.municipality})` : ""}`;
    const link: AppointmentLink = appointmentLink(entry, lang, { lat: found.place.lat, lng: found.place.lng }, area);
    await deps.places.add(found.ref, { kind: "appointments", at: deps.now(), link: forPerson(link, found.place) });
    return c.json({
      service: lang === "en" ? entry.en : entry.fr,
      area,
      near_list_page: entry.id !== null,
      link_shown_to_person: true,
      note: LINK_NOTE[lang],
    });
  });

  /** Places with free slots (Clic Santé read API). Off until Clic Santé gives permission. */
  app.post("/appointments_search", async (c) => {
    const deps = c.get("deps");
    if (!deps.clicsante) return c.json({ error: "disabled", message: "Use appointments_link." }, 404);
    const b = await body(c);
    const entry = typeof b.service === "string" || typeof b.service === "number" ? serviceOf(String(b.service)) : null;
    if (!entry || entry.id === null)
      return c.json({ error: "unknown_service", message: "Use appointments_services to find the service." }, 400);
    const found = await resolvePlace(deps, b.near);
    if (!found) return c.json(NO_PLACE, 404);
    const lang: Lang = isLang(b.lang) ? b.lang : found.place.lang;
    const area = areaLabel(found.place);
    // The full-code position (or the FSA centroid when the code is unknown), 3 decimals in the request.
    const centroid = { lat: found.place.lat, lng: found.place.lng };
    const link = appointmentLink(entry, lang, centroid, area);
    try {
      link.places = await searchAvailabilities(deps.clicsante, {
        serviceId: entry.id,
        ...centroid,
        radiusKm: Math.round(num(b.radius_km, 1, 100, 25)),
        lang,
      });
    } catch (error) {
      deps.log({ event: "clicsante_failed", code: error instanceof ClicSanteError ? error.code : "unknown" });
      // Link-only fallback on any error.
    }
    await deps.places.add(found.ref, { kind: "appointments", at: deps.now(), link: forPerson(link, found.place) });
    return c.json({
      service: lang === "en" ? entry.en : entry.fr,
      area,
      places_with_slots: link.places?.length ?? null,
      link_shown_to_person: true,
      note: LINK_NOTE[lang],
    });
  });

  /** Marketed drugs by brand name or ingredient (Health Canada). Any product, prescription included. */
  app.post("/drug_search", async (c) => {
    const deps = c.get("deps");
    const b = await body(c);
    const name = str(b.name, 80);
    if (!name || name.length < 2) return c.json({ error: "invalid_params", message: "name is required (2 characters or more)" }, 400);
    const lang: Lang = isLang(b.lang) ? b.lang : "fr";
    const otcOnly = b.otc_only === true;
    const limit = Math.round(num(b.limit, 1, 15, 8));
    try {
      const items = await searchDrugs(deps.directory, { name, otcOnly, limit, lang });
      return c.json({ count: items.length, otc_only: otcOnly, products: items, note: DRUG_SEARCH_NOTE[lang] });
    } catch {
      return c.json({ error: "drugs_unavailable", message: DRUGS_DOWN[lang] }, 503);
    }
  });

  /**
   * The consumer part of the leaflet of a non-prescription product. A prescription product gets
   * no text: the agents never present a prescription drug as an option.
   */
  app.post("/drug_info", async (c) => {
    const deps = c.get("deps");
    const b = await body(c);
    const code = typeof b.drug_code === "string" || typeof b.drug_code === "number" ? String(b.drug_code).trim() : "";
    if (!/^\d{1,10}$/.test(code)) return c.json({ error: "invalid_params", message: "drug_code from drug_search is required" }, 400);
    const lang: Lang = isLang(b.lang) ? b.lang : "fr";
    const question = str(b.question, 200);
    try {
      let leaflet = await readLeaflet(deps.directory, code, lang);
      if (!leaflet) return c.json({ error: "unknown_drug", message: "Use drug_search to find the drug_code." }, 404);
      if (!leaflet.drug.otc) return c.json({ error: "prescription_drug", product: leaflet.drug, message: RX_NOTE[lang] }, 403);
      // No leaflet text in the conversation language: try the other language.
      let leafletLang: Lang = lang;
      if (!leaflet.text) {
        const other: Lang = lang === "fr" ? "en" : "fr";
        const alt = await readLeaflet(deps.directory, code, other);
        if (alt?.text) [leaflet, leafletLang] = [alt, other];
      }
      if (!leaflet.text) return c.json({ product: leaflet.drug, status: leaflet.status, leaflet: null, message: NO_LEAFLET[lang] });
      let text = leaflet.text;
      let passages: string[] | undefined;
      if (text.length > MAX_LEAFLET_CHARS && question && leaflet.documents[0]) {
        passages = await searchLeaflet(deps.directory, leaflet.documents[0], question).catch(() => undefined);
      }
      const truncated = !passages && text.length > MAX_LEAFLET_CHARS;
      if (truncated) text = text.slice(0, MAX_LEAFLET_CHARS);
      return c.json({
        product: leaflet.drug,
        status: "available",
        leaflet_lang: leafletLang,
        cite_src: leafletSource(code, leafletLang),
        ...(passages ? { passages } : { leaflet: text, truncated }),
        note: LEAFLET_NOTE[lang],
      });
    } catch {
      return c.json({ error: "drugs_unavailable", message: DRUGS_DOWN[lang] }, 503);
    }
  });

  // Deploy check (not in the agents' OpenAPI file): seeds a place from an FSA
  // centroid (never a full code) and reads the results back. Same secret as the tools.
  app.post("/check/place", async (c) => {
    const deps = c.get("deps");
    const b = await body(c);
    const fsa = typeof b.fsa === "string" ? b.fsa.trim().toUpperCase() : "";
    if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]$/.test(fsa) || !deps.postal) return c.json({ error: "invalid_params" }, 400);
    // A code that is not in the file gives the FSA centroid.
    const point = await deps.postal.lookup(`${fsa}0A0`);
    if (!point) return c.json({ error: "unknown_fsa" }, 404);
    const letters = crypto.getRandomValues(new Uint8Array(12));
    const ref = `ref-${Array.from(letters, (x) => String.fromCharCode(97 + (x % 26))).join("")}`;
    await deps.places.set(ref, {
      ...point,
      lat: point.fsaLat,
      lng: point.fsaLng,
      clsc: null,
      precision: "fsa",
      lang: isLang(b.lang) ? b.lang : "fr",
      at: deps.now(),
    });
    return c.json({ ref, area: areaLabel(point) });
  });

  app.post("/check/results", async (c) => {
    const deps = c.get("deps");
    const b = await body(c);
    const ref = typeof b.ref === "string" && PLACE_REF.test(b.ref) ? b.ref : "";
    if (!ref) return c.json({ error: "invalid_params" }, 400);
    return c.json({ results: await deps.places.take(ref, 0) });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((_error, c) => {
    c.get("deps")?.log({ event: "tools_unhandled" });
    return c.json({ error: "unavailable" }, 503);
  });
  return app;
}

/**
 * The copy of a Clic Santé link that the person sees: their full postal code in the label and
 * in the portal search (the person opens the link in their own browser). The agent never gets it.
 */
function forPerson(link: AppointmentLink, place: { fsa: string; municipality: string | null; code?: string }): AppointmentLink {
  if (!place.code) return link;
  const url = new URL(link.url);
  if (url.searchParams.has("serviceId")) url.searchParams.set("postalCode", place.code.replace(" ", ""));
  return { ...link, area: shownLabel(place), url: url.toString() };
}
