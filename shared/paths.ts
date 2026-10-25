// The paths of the app pages. The browser router and the Worker (404 status) both read them.
import type { Lang } from "./api";

export type PageId = "about" | "privacy" | "terms";
/** Pages with their own component. */
export type ToolPageId = "call811" | "transparency" | "costs" | "press";
export type RoutePageId = PageId | ToolPageId;

export const PAGE_PATHS: Record<Lang, Record<RoutePageId | "home", string>> = {
  fr: {
    home: "/",
    about: "/a-propos",
    privacy: "/confidentialite",
    terms: "/conditions",
    call811: "/appeler-le-811",
    transparency: "/transparence",
    costs: "/couts",
    press: "/presse",
  },
  en: {
    home: "/en",
    about: "/en/about",
    privacy: "/en/privacy",
    terms: "/en/terms",
    call811: "/en/calling-811",
    transparency: "/en/transparency",
    costs: "/en/costs",
    press: "/en/press",
  },
};

/** True when the path is an app page, in either language. A trailing slash is allowed. */
export function isAppPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return Object.values(PAGE_PATHS).some((paths) => Object.values(paths).includes(path));
}
