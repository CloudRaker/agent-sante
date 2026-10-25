// Theme: data-theme on <html>. The first value comes from public/boot.js (saved choice, else the OS).
export type Theme = "light" | "dark";

export const THEME_KEY = "agent-sante.theme";

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function applyTheme(next: Theme): void {
  const set = () => {
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#08121F" : "#F4F7FC");
  };
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reduced) doc.startViewTransition(set);
  else set();
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
}
