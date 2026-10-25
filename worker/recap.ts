// The recap PDF. The agent writes the recap (fixed sections) as a normal checked reply: the
// medical-advice check sees it, and its quotes verify like any quote. This file builds the final
// Markdown (title, the agent's sections with the verified quotes and their source, the places shown
// in the conversation, a notice) and renders it with markdowntopdf.dev, a CloudRaker service that
// keeps nothing. The PDF goes to the browser only. The Worker never logs the text.
import type { Lang } from "../shared/api";
import { citationMarker, type Citation } from "../shared/kb";
import type { AppointmentLink, Attachments, PlaceItem } from "../shared/places";
import { stripFollowUps } from "../shared/followups";
import { officialDomain } from "../shared/sources";
import logoSvg from "../public/favicon.svg?raw";

export const PDF_URL = "https://markdowntopdf.dev/pdf";
const MAX_PLACES = 10;
const MAX_LINKS = 4;

/** Renders Markdown to PDF bytes. */
export type PdfRenderer = (markdown: string, options: Record<string, unknown>) => Promise<Uint8Array>;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "");
const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

/**
 * The places and links of `shown`, cleaned. The browser sends what the conversation showed; only
 * names, addresses, distances and official links go on, and only to the person's own PDF.
 */
export function cleanShown(shown: unknown): Attachments | undefined {
  if (!shown || typeof shown !== "object") return undefined;
  const s = shown as Attachments;
  const items: PlaceItem[] = [];
  for (const p of Array.isArray(s.places?.items) ? s.places.items.slice(0, MAX_PLACES) : []) {
    const name = text(p?.name, 120);
    const sourceUrl = httpsUrl(p?.sourceUrl);
    if (!name) continue;
    items.push({
      id: text(p.id, 40),
      name,
      address: text(p.address, 160),
      city: text(p.city, 80) || null,
      lat: 0,
      lng: 0,
      distanceKm: typeof p.distanceKm === "number" && Number.isFinite(p.distanceKm) ? Math.round(p.distanceKm * 10) / 10 : null,
      services: [],
      next: null,
      sourceUrl: sourceUrl && officialDomain(sourceUrl) ? sourceUrl : "",
    });
  }
  const links: AppointmentLink[] = [];
  for (const a of Array.isArray(s.appointments) ? s.appointments.slice(0, MAX_LINKS) : []) {
    const url = httpsUrl(a?.url);
    if (!url || !officialDomain(url)) continue;
    links.push({ serviceId: null, slug: "", name: { fr: text(a.name?.fr, 120), en: text(a.name?.en, 120) }, area: text(a.area, 80) || null, url });
  }
  if (!items.length && !links.length) return undefined;
  return {
    ...(items.length ? { places: { area: text(s.places?.area, 80), items } } : {}),
    ...(links.length ? { appointments: links } : {}),
  };
}

const WORDS = {
  fr: {
    title: "Récapitulatif de votre conversation",
    places: "Lieux trouvés pendant la conversation",
    appointments: "Rendez-vous sur Clic Santé",
    officialPage: "Fiche officielle",
    source: "Source",
    leafletSource: "Santé Canada, feuillet d'information du médicament",
    dose: "Demandez toujours conseil à votre pharmacien avant de prendre ou de donner un médicament.",
    leaflet: "Ces renseignements sont tirés du feuillet d'information du médicament. Demandez toujours conseil à votre pharmacien.",
    notice:
      "Ce document résume votre conversation avec Agent Santé, un service gratuit offert par CloudRaker. Il ne remplace pas un avis médical. Agent Santé n'est pas un service du gouvernement du Québec. En cas d'urgence, appelez le 911. Pour parler à une infirmière, appelez Info-Santé au 811.",
    // markdowntopdf.dev takes 60 characters at most.
    footer: "Ne remplace pas un avis médical · Page {page} de {total}",
    header: "Agent Santé",
    filename: "agent-sante-recapitulatif",
    date: (d: string) => `Créé le ${d}`,
  },
  en: {
    title: "Recap of your conversation",
    places: "Places found during the conversation",
    appointments: "Appointments on Clic Santé",
    officialPage: "Official page",
    source: "Source",
    leafletSource: "Health Canada, product leaflet",
    dose: "Always ask your pharmacist before you take or give a medication.",
    leaflet: "This information comes from the leaflet of the pharmaceutical product. Always ask your pharmacist for advice.",
    notice:
      "This document sums up a conversation with Agent Santé, a free service by CloudRaker. It is not medical advice and not a Government of Québec service. In an emergency, call 911. To talk to a nurse, call Info-Santé at 811.",
    footer: "Does not replace medical advice · Page {page} of {total}",
    header: "Agent Santé",
    filename: "agent-sante-recap",
    date: (d: string) => `Created on ${d}`,
  },
} as const;

/** A verified quote as a Markdown block quote with its source (and the pharmacist notice for a leaflet). */
function quoteBlock(c: Citation, lang: Lang): string {
  const body = (c.translation?.text ?? c.text)
    .split(/\n+/)
    .map((l) => `> ${l.trim()}`)
    .join("\n");
  const label = c.kind === "leaflet" ? WORDS[lang].leafletSource : (officialDomain(c.src) ?? "");
  const lines = [body, ">", `> ${WORDS[lang].source} : [${label}](${c.src})`];
  if (c.kind === "leaflet") lines.push(">", `> *${WORDS[lang].leaflet}*`);
  else if (c.dose) lines.push(">", `> *${WORDS[lang].dose}*`);
  return lines.join("\n");
}

function placesSection(shown: Attachments | undefined, lang: Lang): string {
  if (!shown) return "";
  const w = WORDS[lang];
  const out: string[] = [];
  if (shown.places?.items.length) {
    out.push(`## ${w.places}`, "");
    for (const p of shown.places.items) {
      const where = [p.address, p.distanceKm !== null ? `${String(p.distanceKm).replace(".", lang === "fr" ? "," : ".")} km` : ""].filter(Boolean).join(" · ");
      out.push(`- **${p.name}**${where ? ` · ${where}` : ""}${p.sourceUrl ? ` · [${w.officialPage}](${p.sourceUrl})` : ""}`);
    }
    out.push("");
  }
  if (shown.appointments?.length) {
    out.push(`### ${w.appointments}`, "");
    for (const a of shown.appointments) out.push(`- [${a.name[lang] || a.name.fr || "Clic Santé"}](${a.url})${a.area ? ` · ${a.area}` : ""}`);
    out.push("");
  }
  return out.join("\n");
}

/** The date in Québec, written out ("25 octobre 2026"). */
export function quebecDay(now: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", { timeZone: "America/Toronto", dateStyle: "long" }).format(now);
}

/**
 * The final Markdown. `displayText` is the checked reply, with a `[[citation:N]]` line for each
 * verified quote; the agent wrote its own title-less sections (## headings).
 */
export function recapMarkdown(displayText: string, citations: Citation[], shown: Attachments | undefined, lang: Lang, now: number): string {
  const w = WORDS[lang];
  // Follow-up links send a message in the chat; in the PDF they are plain text.
  let body = stripFollowUps(displayText);
  citations.forEach((c, n) => {
    body = body.replace(citationMarker(n), quoteBlock(c, lang));
  });
  // A top-level title of the agent would repeat ours.
  body = body.replace(/^#\s+.*$/m, "").trim();
  return [
    `# ${w.title}`,
    "",
    `*${w.date(quebecDay(now, lang))}*`,
    "",
    body,
    "",
    placesSection(shown, lang),
    "---",
    "",
    `*${w.notice}*`,
    "",
  ].join("\n");
}

/** Options for markdowntopdf.dev: the logo, the brand colors, the header and the footer. */
export function pdfOptions(lang: Lang): Record<string, unknown> {
  const w = WORDS[lang];
  return {
    title: w.title,
    author: "Agent Santé",
    pageSize: "us-letter",
    fontSize: "10.5pt",
    logo: { svg: logoSvg, height: "0.9cm", allPages: false, position: "left" },
    header: { text: w.header, firstPage: "", position: "right" },
    pageNumbers: { firstPage: true, lastPage: true, format: w.footer, position: "center" },
    colors: { text: "#14213d", link: "#1f4fcc", tableBorder: "#c8d3e6" },
    fonts: { body: "Inter" },
  };
}

export const recapFilename = (lang: Lang, now: number) => `${WORDS[lang].filename}-${new Date(now).toISOString().slice(0, 10)}.pdf`;

/** markdowntopdf.dev client. Throws on any error; the caller says the recap failed. */
export function md2pdf(fetcher: typeof fetch = fetch, url = PDF_URL, timeoutMs = 15_000): PdfRenderer {
  return async (markdown, options) => {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "AgentSante/1.0 (+https://agentsante.ca)" },
      body: JSON.stringify({ markdown, options }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/pdf")) throw new Error(`pdf ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** Base64 of bytes, in chunks (a PDF can be larger than the argument limit of fromCharCode). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
