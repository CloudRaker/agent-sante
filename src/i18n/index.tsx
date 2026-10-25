import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { Lang, PiiKind } from "@shared/api";
import { en } from "./en";
import { fr, type Dict } from "./fr";
import { frenchSpaces, mapStrings } from "@/lib/typography";

export const dicts: Record<Lang, Dict> = { fr: mapStrings(fr as Dict, frenchSpaces), en };

export const LANG_KEY = "agent-sante.lang";

/** Saves the language choice. Storage can be blocked: the app works without it. */
export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Private mode or blocked storage.
  }
}

/** Joins items as "a, b et c" / "a, b and c". */
export function joinList(items: string[], lang: Lang): string {
  return new Intl.ListFormat(dicts[lang].meta.locale, { style: "long", type: "conjunction" }).format(items);
}

export function piiMessage(kinds: PiiKind[], lang: Lang): string {
  const d = dicts[lang].pii;
  return d.body(
    joinList(
      kinds.map((k) => d.kinds[k]),
      lang,
    ),
  );
}

interface I18n {
  lang: Lang;
  t: Dict;
}

const I18nContext = createContext<I18n>({ lang: "fr", t: fr });

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => ({ lang, t: dicts[lang] }), [lang]);
  useEffect(() => {
    // WCAG 3.1.1: the page language follows the UI language.
    document.documentElement.lang = dicts[lang].meta.htmlLang;
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
