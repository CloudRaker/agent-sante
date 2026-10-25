// Cloudflare Turnstile widget (no Arc item exists for it; see ARC.md).
// The only third-party script of the site. Explicit render, so the widget follows our theme and language.
import { useEffect, useRef } from "react";
import type { Lang } from "@shared/api";
import type { Theme } from "@/shell/theme";

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SRC;
    script.async = true;
    script.addEventListener("load", () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"))));
    script.addEventListener("error", () => {
      loading = undefined;
      reject(new Error("turnstile"));
    });
    document.head.appendChild(script);
  });
  return loading;
}

export interface TurnstileHandle {
  reset: () => void;
}

export function Turnstile({
  siteKey,
  lang,
  theme,
  label,
  onToken,
  onError,
  handle,
}: {
  siteKey: string;
  lang: Lang;
  theme: Theme;
  label: string;
  onToken: (token: string | null) => void;
  onError: () => void;
  handle?: { current: TurnstileHandle | null };
}) {
  const el = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onError });
  useEffect(() => {
    callbacks.current = { onToken, onError };
  }, [onToken, onError]);

  useEffect(() => {
    if (!siteKey || !el.current) return;
    let id: string | undefined;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !el.current) return;
        id = api.render(el.current, {
          sitekey: siteKey,
          action: "start-session",
          theme,
          language: lang === "fr" ? "fr" : "en",
          callback: (token: string) => callbacks.current.onToken(token),
          "expired-callback": () => callbacks.current.onToken(null),
          "timeout-callback": () => callbacks.current.onToken(null),
          "error-callback": () => {
            callbacks.current.onToken(null);
            callbacks.current.onError();
          },
        });
        if (handle) handle.current = { reset: () => api.reset(id) };
      })
      .catch(() => callbacks.current.onError());
    return () => {
      cancelled = true;
      callbacks.current.onToken(null);
      if (id && window.turnstile) window.turnstile.remove(id);
      if (handle) handle.current = null;
    };
    // The widget is rendered again when the language or the theme changes.
  }, [siteKey, lang, theme, handle]);

  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {/* Invisible widget: nothing shows, the check runs in the background. */}
      <div ref={el} />
    </fieldset>
  );
}
