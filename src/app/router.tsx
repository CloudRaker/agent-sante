// A small history router: the app has six static paths and one app screen.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Lang } from "@shared/api";
import { PAGE_PATHS, type RoutePageId } from "@shared/paths";

export type Route = { lang: Lang; page: RoutePageId | "home" | "notFound" };

export function parsePath(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  for (const lang of ["fr", "en"] as const) {
    for (const [page, p] of Object.entries(PAGE_PATHS[lang])) {
      if (p === path) return { lang, page: page as Route["page"] };
    }
  }
  return { lang: path.startsWith("/en/") ? "en" : "fr", page: "notFound" };
}

export function pathFor(route: Route): string {
  return route.page === "notFound" ? PAGE_PATHS[route.lang].home : PAGE_PATHS[route.lang][route.page];
}

interface RouterValue {
  path: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue>({ path: "/", navigate: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (to === window.location.pathname) return;
    if (options?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    // Same-origin links to app paths navigate in place, so the in-memory conversation survives.
    // Links stay real <a href> elements (Arc footer links included).
    const onClick = (event: globalThis.MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const a = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.hash) return;
      if (parsePath(url.pathname).page === "notFound") return;
      event.preventDefault();
      navigate(url.pathname);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, [navigate]);
  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export const useRouter = () => useContext(RouterContext);
