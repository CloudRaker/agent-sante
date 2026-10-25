// Worker guardrails: counters, daily cap, kill switch, error-rate alert, FALC prefix.
import { describe, expect, it } from "vitest";
import { alertBody } from "../worker/alert";
import { withMode } from "../worker/pipeline";
import { ALERT, memoryStats } from "../worker/stats-core";
import { quebecDate } from "../worker/time";
import { makeApp, scriptedModel, scriptedRun, session } from "./helpers";

const CLEAN = "Consultez [Québec.ca](https://www.quebec.ca/sante).";
describe("Québec day", () => {
  it("uses the Québec calendar date", () => {
    expect(quebecDate(Date.UTC(2026, 9, 24, 3, 30))).toBe("2026-10-23");
  });
});

describe("counters and guardrails", () => {
  it("counts conversations, messages, PII blocks and advice blocks, with no content", async () => {
    const stats = memoryStats();
    const { run } = scriptedRun((call) => ({ text: call.input?.includes("conseil") ? "Prenez 500 mg." : CLEAN }));
    const { model } = scriptedModel({ advice: (t) => (t.includes("500 mg") ? 0.9 : 0.01) });
    const { post, app } = makeApp(run, model, { stats });
    const { say } = await session(post);
    await say("Bonjour");
    await say("Appelez le 450 555-0101");
    await say("demo conseil");
    const res = await app.request("/api/stats");
    const body = (await res.json()) as { totals: Record<string, number>; days: unknown[] };
    expect(body.totals).toEqual({ conversations: 1, messages: 1, piiBlocks: 1, adviceBlocks: 3, adviceEnded: 1, transcriptions: 0 });
    expect(JSON.stringify(body)).not.toMatch(/Bonjour|450|500 mg|sid|run_/);
  });

  it("stops turns at the daily cap with at_capacity, and refuses new sessions", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, scriptedModel({}).model, { dailyTurnCap: 2 });
    const { say } = await session(post);
    expect((await say("Un")).status).toBe(200);
    expect((await say("Deux")).status).toBe(200);
    const third = await say("Trois");
    expect(third.status).toBe(503);
    expect(third.json).toMatchObject({ error: "at_capacity" });
    expect(calls.filter((c) => c.kind !== "cancel").length).toBe(2);
    const next = await post("/api/session", { turnstileToken: "ok", lang: "fr" });
    expect(next.json).toMatchObject({ error: "at_capacity" });
    // The token stays usable after a refused turn: the guard released the flight.
    expect((await say("Quatre")).json).toMatchObject({ error: "at_capacity" });
  });

  it("gives each host the MapKit token of its origin, and none to another host", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const { app } = makeApp(run, scriptedModel({}).model, { mapkitTokens: { wildcard: "tok-www", apex: "tok-apex" } });
    const token = async (host: string) => ((await (await app.request(`https://${host}/api/config`)).json()) as { mapkitToken: string | null }).mapkitToken;
    expect(await token("agentsante.ca")).toBe("tok-apex");
    expect(await token("www.agentsante.ca")).toBe("tok-www");
    expect(await token("preview.agentsante.ca")).toBe("tok-www");
    expect(await token("localhost")).toBeNull();
    expect(await token("agentsante.ca.example.com")).toBeNull();
    const { app: noApex } = makeApp(run, scriptedModel({}).model, { mapkitTokens: { wildcard: "tok-www" } });
    expect(((await (await noApex.request("https://agentsante.ca/api/config")).json()) as { mapkitToken: string | null }).mapkitToken).toBeNull();
  });

  it("kill switch: config says maintenance and every other route answers 503", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { app, post } = makeApp(run, scriptedModel({}).model, { maintenance: true });
    expect(await (await app.request("/api/config")).json()).toMatchObject({ maintenance: true });
    const s = await post("/api/session", { turnstileToken: "ok", lang: "fr" });
    expect(s.status).toBe(503);
    expect(s.json).toMatchObject({ error: "maintenance" });
    expect((await post("/api/chat", {})).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("fires the error-rate alert once on sustained 5xx, then resolves", async () => {
    const stats = memoryStats();
    const actions: string[] = [];
    let now = Date.UTC(2026, 9, 23, 12, 0);
    const model = { entities: async () => Promise.reject(new Error("down")), yesNoHint: async () => 0 };
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, model, { stats, now: () => now, alert: async (a) => void actions.push(a) });
    const { say } = await session(post);
    for (let i = 0; i < ALERT.minErrors + 2; i++) expect((await say("Bonjour")).status).toBe(503);
    expect(actions).toEqual(["fire"]);
    now += ALERT.windowMinutes * 60_000 + 1;
    for (let i = 0; i < 12; i++) await post("/api/session", { turnstileToken: "ok", lang: "fr" });
    expect(actions).toEqual(["fire", "resolve"]);
  });

  it("the alert body has counts only, in the incident.io HTTP format", () => {
    const body = alertBody({ action: "fire", info: { total: 40, errors: 12 }, host: "agentsante.ca" });
    expect(body).toMatchObject({ status: "firing", deduplication_key: "agent-sante-5xx-agentsante.ca", metadata: { errors: 12, total: 40 } });
  });
});

describe("simple-language mode (FALC)", () => {
  it("prefixes a new run, and a live run only when the mode changes", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, scriptedModel({}).model);
    const { state } = await session(post);
    const send = async (message: string, simple: boolean) => {
      const res = await post("/api/chat", {
        sessionToken: state.token,
        messageId: `m${Math.random().toString(36).slice(2, 12)}`,
        message,
        lang: "fr",
        transcript: state.transcript,
        simple,
      });
      if (res.json.ended === false) {
        state.token = res.json.sessionToken;
        state.transcript = res.json.transcript;
      }
      return res;
    };
    await send("Un", true);
    expect(calls[0]!.input).toBe(withMode("fr", "Un", "on"));
    expect(calls[0]!.input).toMatch(/^\[Mode langage simple activé/);
    await send("Deux", true);
    expect(calls[1]).toMatchObject({ kind: "turn", input: "Deux" });
    await send("Trois", false);
    expect(calls[2]!.input).toMatch(/^\[Mode langage simple désactivé/);
    // The prefix is ours: the PII check and the transcript see only the message.
    expect(state.transcript.map((e) => e.text)).not.toContain(expect.stringContaining("[Mode"));
  });
});
