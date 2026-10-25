// Date and number formats for fr-CA and en-CA. Source times are Québec local times with no offset.
import type { Lang } from "@shared/api";

const LOCALE: Record<Lang, string> = { fr: "fr-CA", en: "en-CA" };

/** "2026-10-23T18:45" (Québec time) to "23 octobre à 18 h 45" / "October 23 at 6:45 p.m.". */
export function formatLocalDateTime(value: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
  const day = new Intl.DateTimeFormat(LOCALE[lang], { timeZone: "UTC", day: "numeric", month: "long" }).format(d);
  if (lang === "fr") return `${day} à ${+m[4]!} h ${m[5]}`;
  const time = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}

/** "2026-10-22" to "22 octobre 2026" / "October 22, 2026". */
export function formatDay(value: string, lang: Lang, withYear = true): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: "UTC", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}) }).format(d);
}

export const localeOf = (lang: Lang) => LOCALE[lang];
