// Official source links. The UI makes a link only to these domains, and the
// source chips under a reply list only these domains.
import type { Source } from "./api";

/** Domain suffixes of official Quebec health sources. */
export const OFFICIAL_DOMAINS = [
  "quebec.ca",
  "sante.quebec",
  "gouv.qc.ca",
  "inspq.qc.ca",
  "clicsante.ca",
  "santemonteregie.qc.ca",
  "centreantipoison.ca",
  // Health Canada product pages (Drug and Health Product Portal): the source of leaflet quotes.
  "hpfb-dgpsa.ca",
] as const;

/** The public directory santequebec.ca is not the Santé Québec agency. Never link it. */
const BLOCKED = ["santequebec.ca"];

export function officialDomain(url: string): string | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (BLOCKED.some((b) => host === b || host.endsWith(`.${b}`))) return null;
  const ok = OFFICIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  return ok ? host.replace(/^www\./, "") : null;
}

const MD_LINK = /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]+)\)/g;
const BARE = /(?<![(\w])https:\/\/[^\s)<>\]]+/g;

/** Lists the official links of a reply, in order of first use, at most `max`. */
export function extractSources(text: string, max = 6): Source[] {
  const found = new Map<string, Source>();
  const add = (rawUrl: string, title?: string) => {
    const url = rawUrl.replace(/[.,;:!?»]+$/, "");
    const domain = officialDomain(url);
    if (!domain || found.has(url) || found.size >= max) return;
    found.set(url, { url, domain, title: title?.trim() || titleFromUrl(url) });
  };
  for (const m of text.matchAll(MD_LINK)) add(m[2]!, m[1]);
  for (const m of text.matchAll(BARE)) add(m[0]);
  return [...found.values()];
}

function titleFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split("/").filter(Boolean).pop();
  if (!last) return u.hostname.replace(/^www\./, "");
  let segment = last;
  try {
    segment = decodeURIComponent(last);
  } catch {
    // A bad percent escape (for example %E0): keep the raw segment.
  }
  const words = segment
    .replace(/\.(html?|pdf)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : u.hostname;
}
