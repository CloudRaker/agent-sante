// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { RouterProvider } from "../src/app/router";
import { Chat } from "../src/chat/Chat";
import { Gate } from "../src/gate/Gate";
import { I18nProvider } from "../src/i18n";
import type { SessionResponse } from "../shared/api";

/** Runs axe on the document. Color contrast needs a real layout engine, so it is measured apart. */
async function violations() {
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const SESSION: SessionResponse = {
  sessionToken: "token",
  expiresAt: Date.now() + 600_000,
  agentId: "fr/concierge",
  lang: "fr",
  transcript: [],
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  document.documentElement.lang = "fr-CA";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("accessibility", () => {
  it("the gate asks for each consent in turn, as messages, with no axe violations", async () => {
    const onStarted = vi.fn<(session: SessionResponse) => void>();
    render(
      <I18nProvider lang="fr">
        <main>
          <Gate siteKey="" theme="light" onStarted={onStarted} />
        </main>
      </I18nProvider>,
    );
    // The opening plays first: the hello, then the first consent.
    await screen.findByText(/je ne suis pas un service du gouvernement du Québec/, undefined, { timeout: 3000 });
    expect(screen.queryByText(/pas un service d'urgence/)).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "J'accepte" }).hasAttribute("disabled")).toBe(false));
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "J'accepte" }));
    await screen.findByText(/pas un service d'urgence/);
    await waitFor(() => expect(screen.getByRole("button", { name: "J'accepte" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "J'accepte" }));
    await screen.findByText(/N'écrivez ni votre nom/);
    const last = await screen.findByRole("button", { name: "Compris, commençons" });
    await waitFor(() => expect(last.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("link", { name: /conditions d'utilisation/ })).toBeTruthy();
    expect(await violations()).toEqual([]);
    // No session before the last consent.
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("the chat, an answer with sources and the PII alert have no axe violations", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(url).endsWith("/api/chat") && /Josée/.test(body.message)) return json({ error: "pii", kinds: ["person_name"] }, 422);
      if (String(url).endsWith("/api/chat")) {
        return json({
          ended: false,
          reply: {
            text: "Voyez la page officielle.\n\nSource : [Info-Santé 811](https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811)",
            sources: [
              { url: "https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811", title: "Info-Santé 811", domain: "quebec.ca" },
            ],
          },
          agentId: "fr/concierge",
          lang: "fr",
          sessionToken: "token2",
          expiresAt: Date.now() + 600_000,
          transcript: [],
        });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <I18nProvider lang="fr">
        <main>
          <Chat session={SESSION} onLanguage={() => {}} onRestart={() => {}} />
        </main>
      </I18nProvider>,
    );
    const box = screen.getByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(box)); // Focus goes to the message box after the gate.
    expect(screen.getByRole("list", { name: /Questions suggérées/ })).toBeTruthy();
    expect(await violations()).toEqual([]);

    fireEvent.change(box, { target: { value: "Comment joindre le 811 ?" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    const link = await screen.findByRole("link", { name: /Info-Santé 811.*nouvel onglet/ });
    expect(link.getAttribute("href")).toBe("https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811");
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("polite"); // New replies are announced.
    expect(await violations()).toEqual([]);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Je suis Josée Tremblay" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/un nom/);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Je suis Josée Tremblay"));
    expect(await violations()).toEqual([]);
  });

  it("the app shell has landmarks, a skip link, and the lang attribute follows the toggle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() => json({ turnstileSiteKey: "", fake: true })),
    );
    render(
      <RouterProvider>
        <App />
      </RouterProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: "Agent Santé" });
    expect(screen.getByRole("link", { name: "Aller au contenu principal" }).getAttribute("href")).toBe("#main");
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: /./ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "J'accepte" })).toBeTruthy();
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("en-CA"));
    expect(window.location.pathname).toBe("/en");
    await screen.findByText(/Hello! I am Agent Santé/);
    expect(await violations()).toEqual([]);
  });

  it("the static pages have no axe violations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() => json({ turnstileSiteKey: "", fake: true })),
    );
    window.history.replaceState(null, "", "/confidentialite");
    render(
      <RouterProvider>
        <App />
      </RouterProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: /confidentialité/ });
    expect(await violations()).toEqual([]);
  });
});
