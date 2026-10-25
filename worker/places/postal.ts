// Postal codes: the only personal information that Agent Santé accepts, and only as a location.
// The Worker takes a full postal code out of the message before the PII check and before Run,
// finds its position in the postal database (D1 POSTAL, ISQ "CP Territoires", CC-BY 4.0), and
// puts a marker in its place. The model and the PII check never see the code. The Worker keeps
// only the position, the FSA (first 3 characters) and public area names, never the code.
//
// Privacy of the lookup: D1 has no Canadian location, so the Worker asks D1 for the whole FSA
// block (about 300 to 900 codes) and finds the code in memory. D1 gets only the FSA, which the
// PII rules allow.
import type { Lang } from "../../shared/api";

/** A full Canadian postal code: A1A 1A1, A1A-1A1 or A1A1A1 (letters D, F, I, O, Q, U never; W, Z never first). */
const POSTAL_G = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])[ -]?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/gi;

export interface PostalMatch {
  /** "H2X1Y4" */
  code: string;
  /** "H2X" */
  fsa: string;
  index: number;
  length: number;
}

/** Every full postal code in the text, in order. */
export function findPostalCodes(text: string): PostalMatch[] {
  return [...text.matchAll(POSTAL_G)].map((m) => {
    const fsa = m[1]!.toUpperCase();
    return { code: `${fsa}${m[2]!.toUpperCase()}`, fsa, index: m.index!, length: m[0].length };
  });
}

/** Where a postal code is. The position of the code, or of its FSA when the code is unknown. */
export interface GeoPoint {
  lat: number;
  lng: number;
  /** "H2X" */
  fsa: string;
  /** Centroid of the FSA (for links that leave our site). */
  fsaLat: number;
  fsaLng: number;
  /** Municipality name, when known. */
  municipality: string | null;
  /** Region (RSS) name, when known. */
  region: string | null;
  /** Name of the CLSC territory, when the full code is known. */
  clsc: string | null;
  /** "code": position of the full code. "fsa": the code is not in the file, centroid of its FSA. */
  precision: "code" | "fsa";
}

export interface PostalLookup {
  lookup(code: string): Promise<GeoPoint | null>;
}

interface PostalRow {
  cp: string;
  lat: number;
  lng: number;
  mun: string | null;
  ra: string | null;
  clsc: string | null;
}

interface FsaRow {
  fsa: string;
  lat: number;
  lng: number;
  mun: string | null;
  ra: string | null;
}

/** Minimal D1 surface, so tests can give a fake. */
export interface D1Like {
  prepare(query: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }>; first<T>(): Promise<T | null> } };
}

const FSA = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]$/;

/**
 * Lookup in D1 by FSA block. Blocks stay in isolate memory for 6 hours (public data, at most a
 * few hundred rows each, max 40 blocks).
 */
export function d1Postal(db: D1Like, now: () => number = Date.now): PostalLookup {
  const blocks = new Map<string, { at: number; fsa: FsaRow | null; codes: Map<string, PostalRow> }>();
  const TTL = 6 * 3600_000;
  const block = async (fsa: string) => {
    const hit = blocks.get(fsa);
    if (hit && now() - hit.at < TTL) return hit;
    const [codes, centroid] = await Promise.all([
      db.prepare("SELECT cp, lat, lng, mun, ra, clsc FROM postal WHERE cp >= ?1 AND cp < ?2").bind(fsa, `${fsa}~`).all<PostalRow>(),
      db.prepare("SELECT fsa, lat, lng, mun, ra FROM fsa WHERE fsa = ?1").bind(fsa).first<FsaRow>(),
    ]);
    const value = { at: now(), fsa: centroid, codes: new Map(codes.results.map((r) => [r.cp, r])) };
    if (blocks.size >= 40) blocks.delete(blocks.keys().next().value!);
    blocks.set(fsa, value);
    return value;
  };
  return {
    async lookup(code) {
      const clean = code.replace(/[\s-]/g, "").toUpperCase();
      const fsa = clean.slice(0, 3);
      if (!FSA.test(fsa)) return null;
      const b = await block(fsa);
      if (!b.fsa) return null; // Not a Québec FSA (or no data): no position.
      const row = b.codes.get(clean);
      return {
        lat: row?.lat ?? b.fsa.lat,
        lng: row?.lng ?? b.fsa.lng,
        fsa,
        fsaLat: b.fsa.lat,
        fsaLng: b.fsa.lng,
        municipality: row?.mun ?? b.fsa.mun,
        region: row?.ra ?? b.fsa.ra,
        clsc: row?.clsc ?? null,
        precision: row ? "code" : "fsa",
      };
    },
  };
}

/** Label shown to the person only: "H3J 1T6 (Montréal)", or the area when the code is unknown. */
export const shownLabel = (p: Pick<GeoPoint, "fsa" | "municipality"> & { code?: string }): string =>
  p.code ? (p.municipality ? `${p.code} (${p.municipality})` : p.code) : areaLabel(p);

/** Public name of the area: "H2X (Montréal)". */
export const areaLabel = (p: Pick<GeoPoint, "fsa" | "municipality">): string => (p.municipality ? `${p.fsa} (${p.municipality})` : p.fsa);

/** The marker that the PII check sees: no reference, no name. */
export function neutralMarker(lang: Lang, fsa: string): string {
  return lang === "fr" ? `[code postal fourni, secteur ${fsa}]` : `[postal code given, area ${fsa}]`;
}

/**
 * The marker that the agent sees. `ref` is the opaque place reference of the session: the agent
 * passes it as `near` to the place tools, and the Worker finds the position. Without a position
 * there is no reference.
 */
export function agentMarker(lang: Lang, fsa: string, point: GeoPoint | null, ref: string | null): string {
  if (!point || !ref) {
    return lang === "fr"
      ? `[code postal fourni, secteur ${fsa}, position introuvable]`
      : `[postal code given, area ${fsa}, position not found]`;
  }
  const area = areaLabel(point);
  if (lang === "fr") {
    return `[code postal fourni, secteur ${area}${point.clsc ? `, territoire de CLSC : ${point.clsc}` : ""}, lieu : ${ref}]`;
  }
  return `[postal code given, area ${area}${point.clsc ? `, CLSC territory: ${point.clsc}` : ""}, place: ${ref}]`;
}

/** Replaces each full postal code in the text. `marker(match)` gives the replacement. */
export function replacePostalCodes(text: string, matches: PostalMatch[], marker: (m: PostalMatch, i: number) => string): string {
  let out = "";
  let at = 0;
  matches.forEach((m, i) => {
    out += text.slice(at, m.index) + marker(m, i);
    at = m.index + m.length;
  });
  return out + text.slice(at);
}

/** A place reference: "ref-" and 12 letters, derived from the session id with HMAC (no digits, so no PII rule sees an identifier). */
export const PLACE_REF = /^ref-[a-z]{12}$/;

export async function placeRef(secret: string, sid: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`place:${sid}`)));
  let ref = "";
  for (let i = 0; i < 12; i++) ref += String.fromCharCode(97 + (mac[i]! % 26));
  return `ref-${ref}`;
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
