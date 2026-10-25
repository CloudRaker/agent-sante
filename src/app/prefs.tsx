// Display preferences: simple-language mode (FALC) and large text.
// They are per-viewer conveniences, so they live in localStorage (wrapped in try/catch).
// Large text sets data-text="large" on <html>; public/boot.js sets it before the first paint.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export const SIMPLE_KEY = "agent-sante.simple";
export const LARGE_KEY = "agent-sante.large-text";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
}

export function applyLargeText(on: boolean): void {
  if (on) document.documentElement.dataset.text = "large";
  else delete document.documentElement.dataset.text;
}

interface Prefs {
  simple: boolean;
  largeText: boolean;
  setSimple: (on: boolean) => void;
  setLargeText: (on: boolean) => void;
}

const noop = () => {};
const PrefsContext = createContext<Prefs>({
  simple: false,
  largeText: false,
  setSimple: noop,
  setLargeText: noop,
});

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [simple, setSimpleState] = useState(() => read(SIMPLE_KEY));
  const [largeText, setLargeState] = useState(() => read(LARGE_KEY) || document.documentElement.dataset.text === "large");
  const setSimple = useCallback((on: boolean) => {
    write(SIMPLE_KEY, on);
    setSimpleState(on);
  }, []);
  const setLargeText = useCallback((on: boolean) => {
    write(LARGE_KEY, on);
    applyLargeText(on);
    setLargeState(on);
  }, []);
  const value = useMemo(
    () => ({ simple, largeText, setSimple, setLargeText }),
    [simple, largeText, setSimple, setLargeText],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export const usePrefs = () => useContext(PrefsContext);
