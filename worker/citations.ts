// Verbatim citations in an agent reply.
// The agent can quote official text as <citation src="URL">exact text</citation>. A quote is
// verified when its source URL is a knowledge source and its text is in that source (see
// shared/kb.ts). A verified quote is official text: the medical-advice check sees a placeholder
// in its place, and the UI shows it as a citation card. A quote that does not verify becomes
// ordinary agent text, so the check sees it. Logs never hold the text.
import type { Lang } from "../shared/api";
import { officialDomain } from "../shared/sources";
import { parseLeafletSource } from "./drugs";
import {
  citationMarker,
  findCitations,
  fragmentsInOrder,
  hasDose,
  matchKey,
  MAX_CITATIONS,
  MAX_QUOTE_CHARS,
  MIN_FRAGMENT,
  normalizeSourceUrl,
  normalizeText,
  quoteFragments,
  stripStrayTags,
  type Citation,
  type KbIndex,
  type KbLang,
} from "../shared/kb";

/** Reads the knowledge assets that the build wrote (public/kb). */
export interface KbStore {
  index(): Promise<KbIndex>;
  /** The match key (normalized text without spaces) of one text asset. */
  key(file: string): Promise<string>;
  /**
   * The match key of the leaflet of a non-prescription drug, or null (prescription drug, no
   * leaflet). Absent: no leaflet quote verifies.
   */
  leaflet?(code: string, lang: KbLang): Promise<string | null>;
}

/** Adds the drug leaflets to a knowledge store. Keys stay in isolate memory. */
export function withLeaflets(
  kb: KbStore | undefined,
  read: (code: string, lang: KbLang) => Promise<{ otc: boolean; text: string | null } | null>,
): KbStore | undefined {
  if (!kb) return undefined;
  const keys = new Map<string, Promise<string | null>>();
  return {
    index: () => kb.index(),
    key: (file) => kb.key(file),
    leaflet(code, lang) {
      const id = `${code}:${lang}`;
      let p = keys.get(id);
      if (!p) {
        if (keys.size >= MAX_CACHED_FILES) keys.delete(keys.keys().next().value!);
        p = read(code, lang).then((l) => (l?.otc && l.text ? matchKey(normalizeText(l.text)) : null));
        p.catch(() => keys.delete(id));
        keys.set(id, p);
      }
      return p;
    },
  };
}

type Fetcher = { fetch(request: Request): Promise<Response> };

const MAX_CACHED_FILES = 300;

/** One store per isolate: the index and the texts read so far stay in memory. */
let shared: { assets: Fetcher; store: KbStore } | undefined;

export function assetsKb(assets: Fetcher | undefined): KbStore | undefined {
  if (!assets) return undefined;
  if (shared && shared.assets === assets) return shared.store;
  const store = createKbStore(async (path) => {
    const res = await assets.fetch(new Request(`https://assets.local/kb/${path}`));
    // A missing asset gets the single-page fallback (HTML): never read that as knowledge.
    if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) {
      throw new Error(`kb asset ${res.status}`);
    }
    return res.text();
  });
  shared = { assets, store };
  return store;
}

/** A store over any reader of `kb/<path>`. Failed reads are not cached. */
export function createKbStore(read: (path: string) => Promise<string>): KbStore {
  let index: Promise<KbIndex> | undefined;
  const keys = new Map<string, Promise<string>>();
  return {
    index() {
      index ??= read("index.json").then((t) => {
        const parsed = JSON.parse(t) as KbIndex;
        if (parsed.version !== 1 || typeof parsed.urls !== "object") throw new Error("kb index shape");
        return parsed;
      });
      index.catch(() => (index = undefined));
      return index;
    },
    key(file) {
      if (!/^[a-f0-9]{8,64}\.txt$/.test(file)) return Promise.reject(new Error("kb file name"));
      let p = keys.get(file);
      if (!p) {
        if (keys.size >= MAX_CACHED_FILES) keys.delete(keys.keys().next().value!);
        p = read(file).then(matchKey);
        p.catch(() => keys.delete(file));
        keys.set(file, p);
      }
      return p;
    },
  };
}

export type UnverifiedReason =
  | "too_many"
  | "bad_src"
  | "unknown_src"
  | "too_long"
  | "empty"
  | "short_fragment"
  | "dose"
  | "not_found"
  | "kb_unavailable";

/** The reply in its three forms. */
export interface PreparedReply {
  /** For the medical-advice check: verified quotes are a placeholder. */
  checkText: string;
  /** For the person: verified quotes are a marker line, see citationMarker(). */
  displayText: string;
  /** For the transcript (later agents read it): verified quotes keep their markup. */
  transcriptText: string;
  citations: Citation[];
  unverified: { host: string; reason: UnverifiedReason }[];
}

export const PLACEHOLDER: Record<Lang, string> = { fr: "[citation officielle]", en: "[official quote]" };

/** Checks one quote against the knowledge text. Returns the reason when it does not verify. */
export async function verifyQuote(
  kb: KbStore,
  src: string,
  text: string,
): Promise<{ reason: UnverifiedReason } | { retrieved?: string; lang?: KbLang; kind?: "leaflet" }> {
  const url = normalizeSourceUrl(src);
  if (!url || !officialDomain(url)) return { reason: "bad_src" };
  if (!text) return { reason: "empty" };
  if (text.length > MAX_QUOTE_CHARS) return { reason: "too_long" };
  const leaflet = parseLeafletSource(url);
  // A leaflet quote may hold a dose: the leaflet is the product's own text, shown with a notice.
  if (!leaflet && hasDose(text)) return { reason: "dose" };
  const fragments = quoteFragments(text);
  if (!fragments.length) return { reason: "empty" };
  if (fragments.some((f) => f.length < MIN_FRAGMENT)) return { reason: "short_fragment" };
  if (leaflet) {
    if (!kb.leaflet) return { reason: "unknown_src" };
    let key: string | null;
    try {
      key = await kb.leaflet(leaflet.code, leaflet.lang);
    } catch {
      return { reason: "kb_unavailable" };
    }
    if (!key) return { reason: "unknown_src" };
    return fragmentsInOrder(fragments, key) ? { lang: leaflet.lang, kind: "leaflet" } : { reason: "not_found" };
  }
  let entry: KbIndex["urls"][string] | undefined;
  let langs: KbIndex["langs"];
  try {
    const index = await kb.index();
    entry = index.urls[url];
    langs = index.langs;
  } catch {
    return { reason: "kb_unavailable" };
  }
  if (!entry?.files.length) return { reason: "unknown_src" };
  let read = 0;
  for (const file of entry.files) {
    let key: string;
    try {
      key = await kb.key(file);
      read++;
    } catch {
      continue;
    }
    if (fragmentsInOrder(fragments, key)) {
      const lang = langs?.[file];
      return { ...(entry.retrieved ? { retrieved: entry.retrieved } : {}), ...(lang ? { lang } : {}) };
    }
  }
  return { reason: read ? "not_found" : "kb_unavailable" };
}

const hostOf = (src: string) => {
  try {
    return new URL(src).hostname.toLowerCase();
  } catch {
    return "invalid";
  }
};

const tidy = (parts: string[]) =>
  parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Builds the three forms of a reply. Never throws: a quote that cannot be checked is unverified. */
export async function prepareReply(text: string, kb: KbStore | undefined, lang: Lang): Promise<PreparedReply> {
  // The agent cannot write a marker line itself: only verified quotes get one.
  const clean = text.replace(/\[\[citation:\d+\]\]/g, "");
  const found = findCitations(clean);
  const results = await Promise.all(
    found.map((c) => (kb ? verifyQuote(kb, c.src, c.text) : Promise.resolve({ reason: "kb_unavailable" as const }))),
  );
  const check: string[] = [];
  const display: string[] = [];
  const transcript: string[] = [];
  const citations: Citation[] = [];
  const unverified: PreparedReply["unverified"] = [];
  let at = 0;
  found.forEach((c, i) => {
    const before = stripStrayTags(clean.slice(at, c.start));
    check.push(before);
    display.push(before);
    transcript.push(before);
    at = c.end;
    const result = results[i]!;
    const reason: UnverifiedReason | undefined =
      "reason" in result ? result.reason : citations.length >= MAX_CITATIONS ? "too_many" : undefined;
    if (reason) {
      unverified.push({ host: hostOf(c.src), reason });
      // The text stays as ordinary agent text, so the medical-advice check sees it.
      const inline = stripStrayTags(c.text);
      check.push(inline);
      display.push(inline);
      transcript.push(inline);
      return;
    }
    const n = citations.length;
    citations.push({
      src: c.src,
      text: c.text,
      verified: true,
      ...("retrieved" in result && result.retrieved ? { retrieved: result.retrieved } : {}),
      ...("lang" in result && result.lang ? { lang: result.lang } : {}),
      ...("kind" in result && result.kind ? { kind: result.kind } : {}),
    });
    check.push(PLACEHOLDER[lang]);
    display.push(`\n\n${citationMarker(n)}\n\n`);
    transcript.push(`<citation src="${c.src.replace(/"/g, "")}">${c.text}</citation>`);
  });
  const rest = stripStrayTags(clean.slice(at));
  check.push(rest);
  display.push(rest);
  transcript.push(rest);
  return { checkText: tidy(check), displayText: tidy(display), transcriptText: tidy(transcript), citations, unverified };
}
