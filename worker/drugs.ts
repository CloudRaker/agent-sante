// Drug information from the directory API (Health Canada Drug Product Database, synced by CloudRaker).
// GET /v1/drugs?q=&dispensing=otc&limit= finds marketed products by brand name or ingredient.
// GET /v1/drugs/{code}/consumer-info?language= gives the consumer part of the product leaflet.
//
// Rules: any product can be found by name, but only a non-prescription (OTC) product gives its
// leaflet text, so the agents never present a prescription drug as an option.
import type { KbLang } from "../shared/kb";
import { getJson, type DirectoryDeps } from "./places/directory";

interface RawIngredient {
  name?: string;
  name_fr?: string | null;
  strength?: string | null;
  strength_unit?: string | null;
}

export interface RawDrug {
  drug_code: string;
  din?: string | null;
  brand_name?: string | null;
  brand_name_fr?: string | null;
  dispensing_status?: string;
  is_otc?: boolean;
  is_prescription?: boolean;
  ingredients?: RawIngredient[];
  forms?: { en?: string; fr?: string }[];
  routes?: { en?: string; fr?: string }[];
  company?: string | null;
}

interface RawConsumerInfo {
  drug?: RawDrug;
  status?: string;
  data?: { document_id?: string; text?: string }[];
}

/** One product as the agents see it. */
export interface DrugSummary {
  drug_code: string;
  din: string | null;
  name: string;
  ingredients: string[];
  form: string | null;
  route: string | null;
  company: string | null;
  /** True for a non-prescription product: its leaflet can be read with drug_info. */
  otc: boolean;
  prescription: boolean;
}

export interface Leaflet {
  drug: DrugSummary;
  /** "available", or why there is no text yet ("pending_discovery", "no_monograph", ...). */
  status: string;
  /** The consumer part of the leaflet, when available. */
  text: string | null;
  /** Directory document ids of the leaflet, for a question search in a long leaflet. */
  documents: string[];
}

/** The Health Canada product page that links the leaflet: the citation source of leaflet quotes. */
export function leafletSource(code: string, lang: KbLang): string {
  return `https://${lang === "fr" ? "pmps" : "dhpp"}.hpfb-dgpsa.ca/dhpp/resource/${code}`;
}

const LEAFLET_SRC = /^https:\/\/(dhpp|pmps)\.hpfb-dgpsa\.ca\/dhpp\/resource\/(\d{1,10})$/;

/** The drug code and language of a leaflet source URL (normalized), or null. */
export function parseLeafletSource(url: string): { code: string; lang: KbLang } | null {
  const m = LEAFLET_SRC.exec(url);
  return m ? { code: m[2]!, lang: m[1] === "pmps" ? "fr" : "en" } : null;
}

const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();

export function summarize(d: RawDrug, lang: KbLang): DrugSummary {
  const name = (lang === "fr" ? d.brand_name_fr || d.brand_name : d.brand_name) ?? "";
  const ingredients = (d.ingredients ?? []).map((i) => {
    const n = (lang === "fr" ? i.name_fr || i.name : i.name) ?? "";
    const strength = i.strength && i.strength_unit ? ` ${i.strength} ${i.strength_unit.toLowerCase()}` : "";
    return `${lang === "fr" ? n : cap(n)}${strength}`.trim();
  });
  const pick = (list: RawDrug["forms"]) => list?.[0]?.[lang] ?? null;
  return {
    drug_code: d.drug_code,
    din: d.din ?? null,
    name,
    ingredients,
    form: pick(d.forms),
    route: pick(d.routes),
    company: d.company ?? null,
    otc: d.is_otc === true,
    prescription: d.is_prescription === true,
  };
}

export async function searchDrugs(
  deps: DirectoryDeps,
  q: { name: string; otcOnly: boolean; limit: number; lang: KbLang },
): Promise<DrugSummary[]> {
  const params = new URLSearchParams({ q: q.name, limit: String(q.limit) });
  if (q.otcOnly) params.set("dispensing", "otc");
  const body = await getJson<{ data?: RawDrug[] }>(deps, `/v1/drugs?${params}`);
  return (body.data ?? []).filter((d) => d?.drug_code).map((d) => summarize(d, q.lang));
}

/** The leaflet of one product in one language. The text is joined from the consumer sections. */
export async function readLeaflet(deps: DirectoryDeps, code: string, lang: KbLang): Promise<Leaflet | null> {
  if (!/^\d{1,10}$/.test(code)) return null;
  const body = await getJson<RawConsumerInfo>(deps, `/v1/drugs/${code}/consumer-info?language=${lang}`);
  if (!body.drug?.drug_code) return null;
  const parts = (body.data ?? []).map((d) => d.text?.trim() ?? "").filter(Boolean);
  const status = body.status ?? "unknown";
  const documents = (body.data ?? []).map((d) => d.document_id ?? "").filter((id) => /^[\w-]{1,40}$/.test(id));
  return {
    drug: summarize(body.drug, lang),
    status,
    text: status === "available" && parts.length ? parts.join("\n\n") : null,
    documents,
  };
}

/** The passages of a leaflet that best match a question, best first. */
export async function searchLeaflet(deps: DirectoryDeps, documentId: string, question: string, max = 3): Promise<string[]> {
  const body = await getJson<{ data?: { text?: string }[] }>(
    deps,
    `/v1/documents/${encodeURIComponent(documentId)}/query?${new URLSearchParams({ q: question })}`,
  );
  return (body.data ?? [])
    .map((d) => d.text?.trim() ?? "")
    .filter(Boolean)
    .slice(0, max);
}
