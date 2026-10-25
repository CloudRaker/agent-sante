// @vitest-environment jsdom
// The question card: renders the question and its suggested answers, takes the focus, announces
// itself, sends a click at once as a choice, sends a typed answer as free text, then locks.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/chat/Chat";
import { I18nProvider } from "../src/i18n";
import type { SessionResponse } from "../shared/api";

const SESSION: SessionResponse = {
  sessionToken: "token",
  expiresAt: Date.now() + 600_000,
  agentId: "fr/concierge",
  lang: "fr",
  transcript: [],
};

const QUESTION = {
  text: "Pour qui cherchez-vous de l'information ?",
  choices: ["Pour moi (adulte)", "Pour un enfant", "Pour un bébé de moins de 1 an"],
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const reply = (text: string, question?: typeof QUESTION) =>
  json({
    ended: false,
    reply: { text, sources: [], ...(question ? { question } : {}) },
    agentId: "fr/concierge",
    lang: "fr",
    sessionToken: "token2",
    expiresAt: Date.now() + 600_000,
    transcript: [],
  });

let bodies: Array<Record<string, unknown>> = [];

function mockApi() {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url, init) => {
      if (!String(url).endsWith("/api/chat")) return json({});
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      if (/Josée/.test(String(body.message))) return json({ error: "pii", kinds: ["person_name"] }, 422);
      if (/fièvre/.test(String(body.message))) return reply("", QUESTION);
      return reply(`Voici l'information pour : ${String(body.message)}.`);
    }),
  );
}

async function violations() {
  const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

async function ask() {
  render(
    <I18nProvider lang="fr">
      <main>
        <Chat session={SESSION} onLanguage={() => {}} onRestart={() => {}} />
      </main>
    </I18nProvider>,
  );
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: "J'ai de la fièvre, où aller ?" } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
  return screen.findByRole("group", { name: QUESTION.text });
}

beforeEach(() => {
  document.documentElement.lang = "fr-CA";
  mockApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("question card", () => {
  it("renders the question, takes the focus, announces it and has no axe violations", async () => {
    const card = await ask();
    const buttons = within(card)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("type") !== "submit");
    expect(buttons.map((b) => b.textContent)).toEqual(QUESTION.choices);
    expect(within(card).getByRole("list", { name: "Réponses proposées" })).toBeTruthy();
    expect(within(card).getByLabelText("Autre réponse…")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(document.querySelector('[aria-live="polite"].sr-only')?.textContent).toContain("L'agent vous pose une question");
    // The main box also answers: its placeholder says so.
    expect(screen.getAllByRole("textbox").some((t) => t.getAttribute("placeholder") === "Ou écrivez votre réponse")).toBe(true);
    expect(await violations()).toEqual([]);
  });

  it("a click sends the choice at once, then the card locks and shows it", async () => {
    const card = await ask();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Pour un enfant" }));
    });
    expect(bodies.at(-1)).toMatchObject({ message: "Pour un enfant", choice: true });
    await screen.findByText(/Voici l'information pour : Pour un enfant/);
    const chosen = within(card).getByRole("button", { name: /Pour un enfant/ });
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(within(card).getByRole("button", { name: "Pour moi (adulte)" }).getAttribute("aria-pressed")).toBe("false");
    // Locked: another click sends nothing.
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Pour moi (adulte)" }));
    });
    expect(bodies).toHaveLength(2);
    expect(await violations()).toEqual([]);
  });

  it("the other-answer field sends free text (no choice flag) and shows it after", async () => {
    const card = await ask();
    const field = within(card).getByLabelText("Autre réponse…");
    fireEvent.change(field, { target: { value: "Pour ma mère" } });
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Envoyer cette réponse" }));
    });
    expect(bodies.at(-1)?.message).toBe("Pour ma mère");
    expect(bodies.at(-1)?.choice).toBeUndefined();
    await screen.findByText(/Voici l'information pour : Pour ma mère/);
    expect((within(card).getByLabelText("Votre réponse") as HTMLInputElement).value).toBe("Pour ma mère");
  });

  it("a blocked free answer opens the card again", async () => {
    const card = await ask();
    const field = within(card).getByLabelText("Autre réponse…");
    fireEvent.change(field, { target: { value: "Pour Josée" } });
    await act(async () => {
      fireEvent.submit(field.closest("form")!);
    });
    await screen.findByRole("alert");
    const again = within(card).getByRole("button", { name: "Pour un enfant" });
    expect(again.hasAttribute("disabled")).toBe(false);
    expect(again.getAttribute("aria-pressed")).toBeNull();
  });
});
