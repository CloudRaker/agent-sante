// @vitest-environment jsdom
// Site pages and options: home numbers strip, 811 page, transparency, press kit, maintenance, display options.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { PrefsProvider } from "../src/app/prefs";
import { RouterProvider } from "../src/app/router";

async function violations() {
  const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const STATS = {
  totals: { conversations: 1204, messages: 3310, piiBlocks: 87, adviceBlocks: 21, adviceEnded: 2 },
  days: [{ day: "2026-10-23", counts: { conversations: 1204, messages: 3310, piiBlocks: 87, adviceBlocks: 21, adviceEnded: 2 } }],
  since: "2026-10-23",
};


function stubApi(config: Record<string, unknown> = {}, stats: unknown = STATS) {
  vi.stubGlobal(
    "fetch",
    vi.fn<(url: string) => Promise<Response>>((url) => {
      if (url.endsWith("/api/stats")) return json(stats);
      return json({ turnstileSiteKey: "", fake: true, maintenance: false, ...config });
    }),
  );
}

function renderApp(path: string) {
  window.history.replaceState(null, "", path);
  render(
    <RouterProvider>
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </RouterProvider>,
  );
}

beforeEach(() => {
  document.documentElement.lang = "fr-CA";
  delete document.documentElement.dataset.text;
  try {
    localStorage.clear();
  } catch {
    // jsdom without storage
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tool pages UI", () => {
  it("the 811 page, the transparency page and the press kit have no axe violations", async () => {
    stubApi();
    renderApp("/appeler-le-811");
    await screen.findByRole("heading", { level: 1, name: /Devrais-je appeler le 811/ });
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    await screen.findByText(/1 sur 5 prêts/);
    expect(screen.getAllByRole("link", { name: /Appeler le 811/ }).map((a) => a.getAttribute("href"))).toContain("tel:811");
    expect(await violations()).toEqual([]);
    cleanup();

    renderApp("/transparence");
    await screen.findByRole("heading", { level: 1, name: "Transparence" });
    await screen.findByRole("table");
    expect(screen.getAllByText("Messages bloqués").length).toBeGreaterThan(0);
    expect(await violations()).toEqual([]);
    cleanup();

    renderApp("/en/press");
    await screen.findByRole("heading", { level: 1, name: "Press kit" });
    expect(screen.getByRole("img", { name: /^Architecture/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/open letter|lettre ouverte/i);
    expect(await violations()).toEqual([]);
  });

  it("kill switch: the home shows the maintenance page with the help numbers", async () => {
    stubApi({ maintenance: true });
    renderApp("/");
    await screen.findByText(/Agent Santé est temporairement indisponible/);
    expect(screen.getAllByRole("link", { name: /Info-Santé.*811/ }).map((a) => a.getAttribute("href"))).toContain("tel:811");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("display options: large text sets data-text on <html>", async () => {
    stubApi();
    renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: "Options d'affichage" }));
    const large = await screen.findByRole("switch", { name: "Grand texte" });
    fireEvent.click(large);
    await waitFor(() => expect(document.documentElement.dataset.text).toBe("large"));
    expect(screen.getByRole("switch", { name: "Langage simple" })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
});

