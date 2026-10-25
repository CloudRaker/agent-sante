// What a crawler or an AI assistant sees without JavaScript. The Worker rewrites the HTML of each
// app page: language, title, description, canonical and hreflang links, structured data (JSON-LD),
// and the text of the content pages inside #root. React replaces #root when it starts, so people
// see the same page. The text comes from the same i18n data as the app, so the two never differ.
import type { Lang } from "../shared/api";
import { PAGE_PATHS, type RoutePageId } from "../shared/paths";
import { en } from "../src/i18n/en";
import { fr } from "../src/i18n/fr";
import { LINKS, pages, type PageContent } from "../src/i18n/pages";
import { toolPages, SOURCES_811 } from "../src/i18n/tool-pages";

export const SITE = "https://agentsante.ca";

/** Text of the social card (public/og.png, public/og.mp4: a question and a verified Québec.ca quote). */
const OG_ALT = {
  fr: "Agent Santé : vos questions sur la santé, des réponses officielles. L'image montre une question sur la vaccination contre la grippe et un extrait officiel de Québec.ca.",
  en: "Agent Santé: your health questions, official answers. A question about the flu vaccine and an official excerpt from Québec.ca.",
};

type PageKey = RoutePageId | "home";

export interface PageMeta {
  lang: Lang;
  page: PageKey;
  title: string;
  description: string;
  canonical: string;
  alternates: Record<Lang, string>;
  /** HTML for #root, or "" when the page has no static text (home, live data pages). */
  body: string;
  jsonLd: object[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page and language of an app path, or null. A trailing slash is allowed. */
export function findPage(pathname: string): { lang: Lang; page: PageKey } | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  for (const lang of ["fr", "en"] as const) {
    for (const [page, p] of Object.entries(PAGE_PATHS[lang])) if (p === path) return { lang, page: page as PageKey };
  }
  return null;
}

const dicts = { fr, en };

const ORGANIZATION = {
  "@type": "Organization",
  "@id": `${SITE}/#cloudraker`,
  name: "CloudRaker",
  url: LINKS.cloudraker,
};

function website(lang: Lang) {
  return {
    "@type": "WebSite",
    "@id": `${SITE}/#website`,
    name: "Agent Santé",
    url: `${SITE}/`,
    inLanguage: ["fr-CA", "en-CA"],
    publisher: { "@id": ORGANIZATION["@id"] },
    description: dicts[lang].meta.description,
  };
}

function application(lang: Lang) {
  return {
    "@type": "WebApplication",
    "@id": `${SITE}/#app`,
    name: "Agent Santé",
    url: `${SITE}${PAGE_PATHS[lang].home === "/" ? "/" : PAGE_PATHS[lang].home}`,
    applicationCategory: "HealthApplication",
    operatingSystem: "Web",
    inLanguage: ["fr-CA", "en-CA"],
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "CAD" },
    publisher: { "@id": ORGANIZATION["@id"] },
    description: dicts[lang].meta.description,
  };
}

function staticPage(c: PageContent, updatedLabel: string): string {
  const out = [`<h1>${esc(c.title)}</h1>`, `<p>${esc(c.lead)}</p>`];
  for (const s of c.sections) {
    out.push(`<h2>${esc(s.heading)}</h2>`);
    for (const p of s.paragraphs) out.push(`<p>${esc(p)}</p>`);
    if (s.list?.length) out.push(`<ul>${s.list.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`);
    if (s.links?.length) out.push(`<ul>${s.links.map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`).join("")}</ul>`);
  }
  out.push(`<p>${esc(updatedLabel)} : ${esc(c.updated)}</p>`);
  return out.join("");
}

function call811Page(lang: Lang): string {
  const c = toolPages[lang].call811;
  const list = (items: readonly string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  return [
    `<h1>${esc(c.title)}</h1>`,
    `<p>${esc(c.lead)}</p>`,
    `<h2>${esc(c.urgentTitle)}</h2><p>${esc(c.urgent)}</p>`,
    `<h2>${esc(c.whatTitle)}</h2>${c.what.map((p) => `<p>${esc(p)}</p>`).join("")}`,
    `<h2>${esc(c.optionsTitle)}</h2><ul>${c.options.map((o) => `<li><strong>${esc(o.title)}</strong> : ${esc(o.text)}</li>`).join("")}</ul>`,
    `<h2>${esc(c.askTitle)}</h2><p>${esc(c.askLead)}</p>${list(c.ask)}<p>${esc(c.askNote)}</p><p>${esc(c.askThen)}</p>`,
    `<h2>${esc(c.readyTitle)}</h2><p>${esc(c.readyLead)}</p>${list(c.ready)}`,
    `<h2>${esc(c.waitTitle)}</h2>${list(c.wait)}`,
    `<h2>${esc(c.accessTitle)}</h2>${list(c.access)}`,
    `<h2>${esc(c.sourcesTitle)}</h2><ul>${c.sources.map((s) => `<li><a href="${esc(SOURCES_811[s.key as keyof typeof SOURCES_811][lang])}">${esc(s.label)}</a></li>`).join("")}</ul>`,
  ].join("");
}

function pressPage(lang: Lang): string {
  const c = toolPages[lang].press;
  return [
    `<h1>${esc(c.title)}</h1>`,
    `<p>${esc(c.lead)}</p>`,
    `<h2>${esc(c.factsTitle)}</h2><ul>${c.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`,
    `<h2>${esc(c.diagramTitle)}</h2><p>${esc(c.diagramDesc)}</p>`,
  ].join("");
}

/** Title, description and static text of one page. */
function content(lang: Lang, page: PageKey): { title: string; description: string; body: string } {
  const t = dicts[lang];
  const tp = toolPages[lang];
  switch (page) {
    case "home":
      return { title: t.meta.title, description: t.meta.description, body: "" };
    case "about":
    case "privacy":
    case "terms": {
      const c = pages[lang][page];
      return { title: `${c.title} · Agent Santé`, description: c.lead, body: staticPage(c, pages[lang].updatedLabel) };
    }
    case "call811":
      return { title: `${tp.call811.title} · Agent Santé`, description: tp.call811.lead, body: call811Page(lang) };
    case "press":
      return { title: `${tp.press.title} · Agent Santé`, description: tp.press.lead, body: pressPage(lang) };
    case "transparency":
      return { title: `${tp.transparency.title} · Agent Santé`, description: tp.transparency.lead, body: "" };
    case "costs":
      return { title: `${tp.costsPage.title} · Agent Santé`, description: tp.costsPage.lead, body: "" };
  }
}

export function pageMeta(lang: Lang, page: PageKey): PageMeta {
  const { title, description, body } = content(lang, page);
  const url = (l: Lang) => `${SITE}${PAGE_PATHS[l][page] === "/" ? "/" : PAGE_PATHS[l][page]}`;
  const canonical = url(lang);
  const webPage = {
    "@type": page === "about" ? "AboutPage" : "WebPage",
    "@id": `${canonical}#page`,
    url: canonical,
    name: title,
    description,
    inLanguage: lang === "fr" ? "fr-CA" : "en-CA",
    isPartOf: { "@id": `${SITE}/#website` },
    publisher: { "@id": ORGANIZATION["@id"] },
  };
  const graph = page === "home" ? [ORGANIZATION, website(lang), application(lang), webPage] : [ORGANIZATION, website(lang), webPage];
  return {
    lang,
    page,
    title,
    description,
    canonical,
    alternates: { fr: url("fr"), en: url("en") },
    body,
    jsonLd: [{ "@context": "https://schema.org", "@graph": graph }],
  };
}

/** JSON for a <script type="application/ld+json"> block: "<" is escaped so the text cannot close the tag. */
export const jsonLdText = (data: object) => JSON.stringify(data).replace(/</g, "\\u003c");

/** The parts of the Workers HTMLRewriter that this file uses (the app tsconfig has no Workers types). */
interface El {
  setAttribute(name: string, value: string): unknown;
  setInnerContent(content: string, options?: { html: boolean }): unknown;
  append(content: string, options?: { html: boolean }): unknown;
}
interface Rewriter {
  on(selector: string, handlers: { element(e: El): void }): Rewriter;
  transform(res: Response): Response;
}
const rewriterClass = () => (globalThis as unknown as { HTMLRewriter?: new () => Rewriter }).HTMLRewriter;

/** Rewrites the HTML of an app page with its metadata and its static text. Without HTMLRewriter (tests), unchanged. */
export function rewritePage(res: Response, meta: PageMeta): Response {
  const HTMLRewriter = rewriterClass();
  if (!HTMLRewriter) return res;
  const head = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Agent Santé" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(meta.canonical)}" />`,
    `<meta property="og:locale" content="${meta.lang === "fr" ? "fr_CA" : "en_CA"}" />`,
    `<meta property="og:image" content="${SITE}/og.png" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(OG_ALT[meta.lang])}" />`,
    `<meta property="og:video" content="${SITE}/og.mp4" />`,
    `<meta property="og:video:secure_url" content="${SITE}/og.mp4" />`,
    `<meta property="og:video:type" content="video/mp4" />`,
    `<meta property="og:video:width" content="1200" />`,
    `<meta property="og:video:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${SITE}/og.png" />`,
    `<link rel="alternate" hreflang="fr-CA" href="${esc(meta.alternates.fr)}" />`,
    `<link rel="alternate" hreflang="en-CA" href="${esc(meta.alternates.en)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${esc(meta.alternates.fr)}" />`,
    ...meta.jsonLd.map((d) => `<script type="application/ld+json">${jsonLdText(d)}</script>`),
  ].join("");
  let rewriter = new HTMLRewriter()
    .on("html", { element: (e) => void e.setAttribute("lang", meta.lang === "fr" ? "fr-CA" : "en-CA") })
    .on("title", { element: (e) => void e.setInnerContent(meta.title) })
    .on('meta[name="description"]', { element: (e) => void e.setAttribute("content", meta.description) })
    .on('link[rel="canonical"]', { element: (e) => void e.setAttribute("href", meta.canonical) })
    .on("head", { element: (e) => void e.append(head, { html: true }) });
  if (meta.body) rewriter = rewriter.on("#root", { element: (e) => void e.setInnerContent(`<main>${meta.body}</main>`, { html: true }) });
  return rewriter.transform(res);
}
