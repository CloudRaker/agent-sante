// @vitest-environment jsdom
// A message that fails twice: the notice says the session may be stuck and offers to reload the page.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/chat/Chat";
import { I18nProvider } from "../src/i18n";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat() {
  render(
    <I18nProvider lang="fr">
      <main>
        <Chat
          session={{ sessionToken: "t", expiresAt: Date.now() + 600_000, agentId: "fr/concierge", lang: "fr", transcript: [] }}
          onLanguage={() => {}}
          onRestart={() => {}}
        />
      </main>
    </I18nProvider>,
  );
}

describe("a message that keeps failing", () => {
  it("offers to reload the page after the second failure", async () => {
    vi.stubGlobal("fetch", vi.fn<() => Promise<Response>>(async () => json({ error: "unavailable" }, 503)));
    const reload = vi.fn<() => void>();
    vi.stubGlobal("location", { ...window.location, reload });
    renderChat();
    const box = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(box, { target: { value: "J'ai un bouton suspect" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await screen.findByText(/Le service ne répond pas/);
    expect(screen.queryByRole("button", { name: "Recharger la page" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Réessayer/ }));
    });
    await screen.findByText(/Nos mécanismes de sécurité l'ont peut-être bloqué/);
    fireEvent.click(screen.getByRole("button", { name: "Recharger la page" }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
