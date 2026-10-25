// @vitest-environment jsdom
// Costs and usage page: zero data, real sums in CAD, the 811 projection slider and the usage lists.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { PrefsProvider } from "../src/app/prefs";
import { RouterProvider } from "../src/app/router";
import { TOPICS, type StatsResponse } from "../shared/api";

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));

const COUNTS = { conversations: 12, messages: 30, piiBlocks: 1, adviceBlocks: 0, adviceEnded: 0, transcriptions: 2 };
const base: StatsResponse = { totals: COUNTS, days: [{ day: "2026-10-24", counts: COUNTS }], since: "2026-10-24" };
// 10 conversations, 25 messages, USD 0.50 in all: USD 0.05 per conversation, USD 0.02 per message.
const sums = { usd: { model: 0.3, run: 0.1, milliseconds: 0.05, transcription: 0.03, translation: 0.02 }, conversations: 10, turns: 25 };
const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const usage: NonNullable<StatsResponse["usage"]> = {
  calls: 40,
  topics: { ...zero(TOPICS), orientation: 30, flu: 7, vaccination: 3 },
  topicsWeek: { ...zero(TOPICS), flu: 7 },
  agents: { "fr/concierge": 30, "fr/grippe": 7, "en/viruses-vaccines": 3 },
  turns: { "1": 4, "2-3": 3, "4-6": 2, "7+": 1 },
  latency: { "<5s": 2, "5-10s": 5, "10-20s": 2, "20s+": 1 },
  perDay: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(11 + i).padStart(2, "0")}`, conversations: i % 3 })),
};
const withCosts: StatsResponse = { ...base, costs: { totals: sums, days: [{ day: "2026-10-24", ...sums }], since: "2026-10-24" }, usage };
/** Words that frame the numbers as a history or show the conversion. None may show on the page. */
const FORBIDDEN = /USD|US\$|\$ US|américain|US dollar|1[.,]46|[Mm]esuré|[Mm]easured|[Dd]epuis le|[Ss]ince|lancement|launch|based on|calculées sur/;

function show(stats: StatsResponse, path: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => (url.endsWith("/api/stats") ? json(stats) : json({ turnstileSiteKey: "", fake: true, maintenance: false }))),
  );
  window.history.replaceState(null, "", path);
  render(
    <RouterProvider>
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </RouterProvider>,
  );
}

async function violations() {
  const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

beforeEach(() => {
  document.documentElement.lang = "fr-CA";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("costs and usage page", () => {
  it("renders with zero data, from an older Worker and from empty sums", async () => {
    show(base, "/couts");
    await screen.findByRole("heading", { level: 1, name: "Coûts et utilisation" });
    await screen.findByRole("heading", { level: 2, name: "Ce que coûte son fonctionnement" });
    expect(screen.getByText(/Aucun coût pour l.instant/)).toBeTruthy();
    expect(screen.getByText(/La projection s.affichera/)).toBeTruthy();
    expect(screen.getByText(/Aucune donnée d.utilisation pour l.instant/)).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByText(/ne remplace pas le 811/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(await violations()).toEqual([]);
    cleanup();

    show(
      {
        ...base,
        costs: {
          totals: { ...sums, usd: { model: 0, run: 0, milliseconds: 0, transcription: 0, translation: 0 }, conversations: 0, turns: 0 },
          days: [],
          since: null,
        },
        usage: { ...usage, calls: 0, topics: zero(TOPICS), agents: {}, perDay: usage.perDay.map((d) => ({ ...d, conversations: 0 })) },
      },
      "/en/costs",
    );
    await screen.findByRole("heading", { level: 2, name: "What it costs to run" });
    expect(screen.getByText(/No costs yet/)).toBeTruthy();
    expect(screen.getByText(/No usage data yet/)).toBeTruthy();
  });

  it("shows the totals and averages in CAD, the categories and the projection, with no history lines", async () => {
    show(withCosts, "/en/costs");
    await screen.findByRole("heading", { level: 2, name: "What it costs to run" });
    // USD 0.50 in all = CAD 0.73. USD 0.05 per conversation = CAD 0.073. USD 0.02 per message = CAD 0.0292.
    expect(screen.getByText("$0.73")).toBeTruthy();
    expect(screen.getAllByText("$0.07").length).toBeGreaterThanOrEqual(2); // per conversation, milliseconds row
    expect(screen.getAllByText("$0.03").length).toBeGreaterThanOrEqual(2); // per message, translation row
    const table = screen.getByRole("table", { name: "Costs by category" });
    expect(table.textContent).toContain("Language model");
    expect(table.textContent).toContain("$0.44");
    expect(table.textContent).toContain("60%");
    // 10 % of 2,000,000 calls at CAD 0.073.
    const slider = screen.getByRole("slider", { name: "Share of 811 calls" });
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    expect(screen.getByText("200,000")).toBeTruthy();
    expect(screen.getByText("$14,600")).toBeTruthy();
    fireEvent.keyDown(slider, { key: "End" });
    expect(await screen.findByText("1,000,000")).toBeTruthy();
    expect(screen.getByText("$73,000")).toBeTruthy();
    expect(screen.getByText(/Agent Santé does not replace 811/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /CTV News/ }).getAttribute("href")).toContain("ctvnews.ca");
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(await violations()).toEqual([]);
  });

  it("shows the usage: a chart with a text table, and bar lists with counts and shares", async () => {
    show(withCosts, "/en/costs");
    await screen.findByRole("heading", { level: 2, name: "Usage" });
    // The chart has a text equivalent: a table of every day.
    const chart = screen.getByRole("table", { name: /Conversations started/ });
    expect(chart.querySelectorAll("tbody tr")).toHaveLength(14);
    expect(screen.getByRole("img", { name: /Conversations started/ })).toBeTruthy();
    const topics = screen.getByRole("list", { name: "Agent calls by main topic" });
    const rows = [...topics.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toBe("Welcome and orientation30 (75% of the total)");
    expect(rows).toHaveLength(3);
    const agentRows = [...screen.getByRole("list", { name: "Calls by agent" }).querySelectorAll("li")];
    expect(agentRows[0]!.textContent).toContain("Accueil · French");
    expect(agentRows[0]!.querySelector("[lang]")?.getAttribute("lang")).toBe("fr-CA");
    const turns = [...screen.getByRole("list", { name: "Conversation length" }).querySelectorAll("li")].map((li) => li.textContent);
    expect(turns[0]).toBe("1 message4 (40% of the total)");
    expect(turns[3]).toBe("7 messages or more1 (10% of the total)");
    const latency = [...screen.getByRole("list", { name: "Response time" }).querySelectorAll("li")].map((li) => li.textContent);
    expect(latency[1]).toBe("5 to 10 seconds5 (50% of the total)");
    expect(screen.getByRole("link", { name: /See the safety counters/ }).getAttribute("href")).toBe("/en/transparency");
    expect(await violations()).toEqual([]);
  });

  it("French amounts put the dollar sign after the number, and the chart reads French", async () => {
    show(withCosts, "/couts");
    await screen.findByRole("heading", { level: 2, name: "Ce que coûte son fonctionnement" });
    expect(screen.getAllByText(/^0,07\s\$$/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^14\s600\s\$$/)).toBeTruthy();
    expect(screen.getByRole("slider", { name: /Conversations commencées, explorer par jour/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it("the transparency page keeps the safety counters, links to the costs page and has no costs", async () => {
    show(withCosts, "/transparence");
    await screen.findByRole("heading", { level: 2, name: "Compteurs" });
    expect(screen.queryByRole("heading", { name: "Ce que coûte son fonctionnement" })).toBeNull();
    expect(screen.getByRole("link", { name: "Voir les coûts et l'utilisation" }).getAttribute("href")).toBe("/couts");
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });
});
