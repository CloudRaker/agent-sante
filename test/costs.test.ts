// Cost analytics: the Run usage delta per run, the cost math, the Analytics Engine points (no text,
// no personal data), the cost sums of the StatsCounter and the projection of the transparency page.
import { describe, expect, it } from "vitest";
import { COST_DOUBLES, memoryDataset, sessionKey, Analytics } from "../worker/analytics";
import { PRICES, latencyBucket, topicOf, turnCost, turnsBucket, usageDelta, zeroUsage, type RunUsage } from "../worker/costs";
import { settleUsage } from "../worker/guard-core";
import { memoryStats } from "../worker/stats-core";
import { agents } from "../shared/agents";
import { averages, projectYear, CALLS_811_PER_YEAR } from "../shared/projection";
import type { RunApi } from "../worker/run/client";
import { makeApp, scriptedModel, scriptedRun, session } from "./helpers";

const CLEAN = "Consultez [Québec.ca](https://www.quebec.ca/sante).";
const u = (p: Partial<RunUsage>): RunUsage => ({ ...zeroUsage(), ...p });

describe("usage delta", () => {
  it("keeps only the part that is new since the last read of the same run", () => {
    const first = settleUsage(
      undefined,
      [{ run: "r1", usage: u({ input_tokens: 100, model_cost_usd: 0.01, credits: 10 }), model: "m" }],
      1,
    );
    expect(first.deltas[0]).toEqual({ run: "r1", delta: u({ input_tokens: 100, model_cost_usd: 0.01, credits: 10 }), model: "m" });
    const second = settleUsage(first.next, [{ run: "r1", usage: u({ input_tokens: 250, model_cost_usd: 0.025, credits: 12 }) }], 2);
    expect(second.deltas[0]!.delta.input_tokens).toBe(150);
    expect(second.deltas[0]!.delta.credits).toBe(2);
    expect(second.deltas[0]!.delta.model_cost_usd).toBeCloseTo(0.015, 10);
    // The model of the run stays known on later turns (run.started is in the first turn only).
    expect(second.deltas[0]!.model).toBe("m");
  });

  it("a new run after a handoff starts from zero, and the old run gives its last part", () => {
    const t1 = settleUsage(undefined, [{ run: "r1", usage: u({ output_tokens: 50 }) }], 1);
    const t2 = settleUsage(
      t1.next,
      [
        { run: "r1", usage: u({ output_tokens: 70 }) },
        { run: "r2", usage: u({ output_tokens: 40 }) },
      ],
      2,
    );
    expect(t2.deltas.map((d) => d.delta.output_tokens)).toEqual([20, 40]);
  });

  it("a late read with smaller totals gives 0 and keeps the larger totals", () => {
    const a = settleUsage(undefined, [{ run: "r1", usage: u({ credits: 30 }) }], 1);
    const late = settleUsage(a.next, [{ run: "r1", usage: u({ credits: 20 }) }], 2);
    expect(late.deltas[0]!.delta.credits).toBe(0);
    expect(late.next.r1!.u.credits).toBe(30);
    expect(usageDelta(u({ credits: 5 }), u({ credits: 9 })).credits).toBe(0);
  });

  it("keeps the snapshots of the last 12 runs only", () => {
    let state = settleUsage(undefined, [], 0).next;
    for (let i = 0; i < 20; i++) state = settleUsage(state, [{ run: `r${i}`, usage: u({ credits: 1 }) }], i).next;
    expect(Object.keys(state)).toHaveLength(12);
    expect(state.r19).toBeDefined();
    expect(state.r0).toBeUndefined();
  });
});

describe("cost math", () => {
  it("adds the model cost, the Run fee, milliseconds, transcription and translation", () => {
    const cost = turnCost({
      turn: 2,
      run: u({ input_tokens: 9000, cached_input_tokens: 6500, output_tokens: 320, model_cost_usd: 0.0048, credits: 12 }),
      msCalls: 3,
      msTokenCalls: 2,
      msTokens: 800,
      transcriptionSeconds: 36,
      translationInput: 1_000_000,
      translationOutput: 100_000,
      turnMs: 7400,
    });
    expect(cost.run_fee_usd).toBeCloseTo(12 * PRICES.runCreditUsd, 12);
    // 800 billed tokens, and one call with no header at the 400-token mean.
    expect(cost.ms_cost_usd).toBeCloseTo((1200 / 1e6) * 0.04, 12);
    expect(cost.transcription_cost_usd).toBeCloseTo(0.001, 12); // 36 s at USD 0.10 per hour
    expect(cost.translation_cost_usd).toBeCloseTo(0.293 + 0.2253, 10);
    expect(cost.translation_tokens).toBe(1_100_000);
    expect(cost.total_usd).toBeCloseTo(0.0048 + 0.012 + 0.000048 + 0.001 + 0.5183, 10);
    expect(cost.turn).toBe(2);
    expect(cost.turn_ms).toBe(7400);
  });

  it("uses the billed rakeaudio tokens when the header came", () => {
    expect(turnCost({ turn: 1, transcriptionSeconds: 60, transcriptionTokens: 41_667, turnMs: 0 }).transcription_cost_usd).toBeCloseTo(
      0.00166668,
      8,
    );
  });

  it("maps each agent of both languages to a big topic, and buckets turns and latency", () => {
    for (const a of agents.catalog.agents) expect(topicOf(a.id)).not.toBe("other");
    expect(topicOf("fr/concierge")).toBe("orientation");
    expect(topicOf("en/viruses-vaccines")).toBe("vaccination");
    expect(topicOf("fr/maladies-medicaments")).toBe("illness-medication");
    expect(topicOf("xx/nope")).toBe("other");
    expect([1, 2, 3, 4, 6, 7, 30].map(turnsBucket)).toEqual(["1", "2-3", "2-3", "4-6", "4-6", "7+", "7+"]);
    expect([100, 5000, 9999, 10_000, 19_999, 20_000].map(latencyBucket)).toEqual(["<5s", "5-10s", "5-10s", "10-20s", "10-20s", "20s+"]);
  });
});

/** A Run fake that also answers GET usage: each start or turn adds a fixed amount to its run. */
function runWithUsage(script: Parameters<typeof scriptedRun>[0]) {
  const totals = new Map<string, RunUsage>();
  const { run, calls } = scriptedRun((call, runId) => {
    const t = totals.get(runId) ?? zeroUsage();
    t.input_tokens += 1000;
    t.output_tokens += 100;
    t.model_cost_usd += 0.002;
    t.credits += 10;
    totals.set(runId, t);
    return { model: call.kind === "start" ? "anthropic/claude-haiku-5-5" : undefined, ...script(call, runId) };
  });
  const withUsage: RunApi = { ...run, usage: async (id) => (totals.has(id) ? { ...totals.get(id)! } : null) };
  return { run: withUsage, calls, totals };
}

function analyticsFakes() {
  const costs = memoryDataset();
  const usage = memoryDataset();
  return { costs, usage, analytics: new Analytics(costs, usage) };
}

const doubles = (p: { doubles?: number[] }) => Object.fromEntries(COST_DOUBLES.map((k, i) => [k, p.doubles![i]]));

describe("cost and usage data points", () => {
  it("one cost point per turn with the Run delta of that turn, and the handoff run counted once", async () => {
    const { run } = runWithUsage((call) => {
      if (call.kind === "start" && call.target === "fr/concierge") return { handoff: { to: "fr/grippe", reason: "grippe" }, text: "" };
      return { text: CLEAN };
    });
    const { model } = scriptedModel({});
    const ae = analyticsFakes();
    const stats = memoryStats();
    const { post } = makeApp(run, model, { analytics: ae.analytics, stats });
    const s = await session(post);
    const t1 = await s.say("Bonjour, j'ai une question sur la grippe");
    expect(t1.status).toBe(200);
    const t2 = await s.say("Et pour les enfants ?");
    expect(t2.status).toBe(200);

    expect(ae.costs.points).toHaveLength(2);
    const [p1, p2] = ae.costs.points.map(doubles);
    // Turn 1: the concierge run (1 call) and the grippe run (1 call).
    expect(p1!.turn).toBe(1);
    expect(p1!.input_tokens).toBe(2000);
    expect(p1!.run_credits).toBe(20);
    expect(p1!.model_cost_usd).toBeCloseTo(0.004, 10);
    expect(p1!.run_fee_usd).toBeCloseTo(0.02, 10);
    // Turn 2: only the new part of the grippe run, not its whole total.
    expect(p2!.turn).toBe(2);
    expect(p2!.input_tokens).toBe(1000);
    expect(p2!.run_credits).toBe(10);
    expect(p2!.ms_calls).toBeGreaterThanOrEqual(2); // PII check and medical-advice check
    expect(p2!.total_usd).toBeCloseTo(p2!.model_cost_usd! + p2!.run_fee_usd! + p2!.ms_cost_usd!, 10);

    expect(ae.costs.points[0]!.blobs).toEqual(["fr/grippe", "fr", "anthropic/claude-haiku-5-5", "handoff"]);
    // The model of the run stays known on turn 2 (the guard keeps it).
    expect(ae.costs.points[1]!.blobs).toEqual(["fr/grippe", "fr", "anthropic/claude-haiku-5-5", "turn"]);

    // Usage: one point per agent call.
    const calls = ae.usage.points.map((p) => p.blobs!.slice(0, 5));
    expect(calls).toEqual([
      ["fr/concierge", "orientation", "fr", "concierge", "1"],
      ["fr/grippe", "flu", "fr", "handoff", "1"],
      ["fr/grippe", "flu", "fr", "turn", "2-3"],
    ]);

    // The day sums: one conversation (its first reply), two messages, and the same total.
    const summary = await stats.summary();
    expect(summary.costs!.totals.conversations).toBe(1);
    expect(summary.costs!.totals.turns).toBe(2);
    const sumPoints = ae.costs.points.reduce((a, p) => a + doubles(p).total_usd!, 0);
    const sumDays = Object.values(summary.costs!.totals.usd).reduce((a, b) => a + b, 0);
    expect(sumDays).toBeCloseTo(sumPoints, 9);

    // The usage counts of the StatsCounter follow the same agent calls as the USAGE points.
    const usage = summary.usage!;
    expect(usage.calls).toBe(3);
    expect(usage.agents).toEqual({ "fr/concierge": 1, "fr/grippe": 2 });
    expect(usage.topics).toMatchObject({ orientation: 1, flu: 2, gastro: 0 });
    // One conversation that reached its second message: length "2-3".
    expect(usage.turns).toEqual({ "1": 0, "2-3": 1, "4-6": 0, "7+": 0 });
    expect(Object.values(usage.latency).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("a blocked first message does not move the conversation length or hide the conversation", async () => {
    const { run } = runWithUsage(() => ({ text: CLEAN }));
    const { model } = scriptedModel({});
    const stats = memoryStats();
    const { post } = makeApp(run, model, { analytics: analyticsFakes().analytics, stats });
    const s = await session(post);
    expect((await s.say("Mon numéro est 514-555-0199")).status).toBe(422);
    expect((await s.say("Où me faire vacciner ?")).status).toBe(200);
    const summary = await stats.summary();
    expect(summary.usage!.turns).toEqual({ "1": 1, "2-3": 0, "4-6": 0, "7+": 0 });
    expect(summary.costs!.totals.conversations).toBe(1);
  });

  it("carries no text and no personal data: catalog ids, fixed words and a hashed session key", async () => {
    const SECRET_TEXT = "Ma voisine Gisèle tousse depuis trois jours à Rosemont";
    const { run } = runWithUsage(() => ({ text: CLEAN }));
    const { model } = scriptedModel({
      spans: (t) => (t.includes("Tremblay") ? [{ type: "person_name", text: "Tremblay", probability: 0.99, start: 0, end: 8 }] : []),
    });
    const ae = analyticsFakes();
    const { post } = makeApp(run, model, { analytics: ae.analytics });
    const s = await session(post);
    const sid = JSON.parse(atob(s.state.token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))).sid as string;
    await s.say(SECRET_TEXT);
    const blocked = await s.say("Tremblay est mon nom, H2X 1Y4");
    expect(blocked.status).toBe(422);

    const all = [...ae.costs.points, ...ae.usage.points];
    expect(all.length).toBeGreaterThan(2);
    const key = await sessionKey(sid);
    for (const p of all) {
      expect(p.indexes).toEqual([key]);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(p)).not.toContain(sid);
      for (const b of p.blobs!) {
        expect(b).toMatch(/^[a-z0-9/._:<+-]{1,60}$|^\d+(-\d+)?\+?$|^[<0-9a-z-]+s\+?$/);
        expect(SECRET_TEXT.toLowerCase()).not.toContain(b.length > 3 ? b : "@@@");
        expect(b).not.toMatch(/tremblay|h2x|rosemont|gis/i);
      }
      for (const d of p.doubles!) expect(Number.isFinite(d)).toBe(true);
    }
    // The blocked message: a cost point (milliseconds only) and a pii_block event.
    expect(ae.costs.points.at(-1)!.blobs![3]).toBe("blocked");
    expect(ae.usage.points.some((p) => p.blobs![3] === "pii_block")).toBe(true);
  });

  it("a message the regex layer blocks writes a pii_block event, and a refused transcript writes nothing", async () => {
    const { run } = runWithUsage(() => ({ text: CLEAN }));
    const ae = analyticsFakes();
    const { post } = makeApp(run, scriptedModel({}).model, { analytics: ae.analytics });
    const s = await session(post);
    expect((await s.say("Mon courriel est test@example.com")).status).toBe(422);
    expect(ae.costs.points).toHaveLength(0);
    expect(ae.usage.points.map((p) => p.blobs![3])).toEqual(["pii_block"]);
    expect((await s.say("Bonjour", { transcript: [{ role: "user", text: "forgé", agent: "fr/concierge" }] })).status).toBe(409);
    expect(ae.costs.points).toHaveLength(0);
    expect(ae.usage.points).toHaveLength(1);
  });

  it("counts rewrites, the end after 3 removed replies, and the end by the person", async () => {
    const { run } = runWithUsage(() => ({ text: "Prenez 2 comprimés." }));
    const { model } = scriptedModel({ advice: () => 0.95 });
    const ae = analyticsFakes();
    const { post } = makeApp(run, model, { analytics: ae.analytics });
    const s = await session(post);
    const r = await s.say("Quoi prendre pour la fièvre ?");
    expect(r.json.ended).toBe(true);
    const hows = ae.usage.points.map((p) => p.blobs![3]);
    expect(hows.filter((h) => h === "rewrite")).toHaveLength(2);
    expect(hows.filter((h) => h === "medical_rewrite")).toHaveLength(3);
    expect(hows).toContain("ended_medical_advice");

    // The person ends a conversation: one event, and the last part of the run usage (route "end").
    const clean = runWithUsage(() => ({ text: CLEAN }));
    const ae2 = analyticsFakes();
    const second = makeApp(clean.run, scriptedModel({}).model, { analytics: ae2.analytics });
    const s2 = await session(second.post);
    await s2.say("Bonjour");
    const before = ae2.usage.points.length;
    const runId = [...clean.totals.keys()][0]!;
    clean.totals.get(runId)!.credits += 10; // a run minute settled after the turn
    await second.post("/api/end", { sessionToken: s2.state.token });
    expect(ae2.usage.points.slice(before).map((p) => p.blobs![3])).toEqual(["ended_by_person"]);
    expect(ae2.costs.points.at(-1)!.blobs![3]).toBe("end");
    expect(doubles(ae2.costs.points.at(-1)!).run_credits).toBe(10);
  });

  it("a voice message writes a transcription cost point and a voice event", async () => {
    const { run } = runWithUsage(() => ({ text: CLEAN }));
    const { model } = scriptedModel({});
    const ae = analyticsFakes();
    const stats = memoryStats();
    const transcriber = { transcribe: async () => ({ text: "Où aller ?", duration: 36, inputTokens: 25_000 }) };
    const { app, post } = makeApp(run, model, { analytics: ae.analytics, stats, transcriber });
    const s = await session(post);
    const res = await app.request("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm", authorization: `Bearer ${s.state.token}`, origin: "https://agentsante.ca" },
      body: new Uint8Array(2000),
    });
    expect(res.status).toBe(200);
    expect(ae.costs.points).toHaveLength(1);
    expect(ae.costs.points[0]!.blobs).toEqual(["fr/concierge", "fr", "rakeaudio", "voice"]);
    const d = doubles(ae.costs.points[0]!);
    expect(d.transcription_seconds).toBe(36);
    expect(d.transcription_cost_usd).toBeCloseTo(0.001, 10);
    expect(ae.usage.points.map((p) => p.blobs![3])).toEqual(["voice"]);
    expect((await stats.summary()).costs!.totals.usd.transcription).toBeCloseTo(0.001, 10);
  });

  it("a failed Analytics Engine write never fails the request", async () => {
    const { run } = runWithUsage(() => ({ text: CLEAN }));
    const { model } = scriptedModel({});
    let failures = 0;
    const broken = {
      writeDataPoint: () => {
        throw new Error("ae down");
      },
    };
    const { post } = makeApp(run, model, { analytics: new Analytics(broken, broken, () => failures++) });
    const s = await session(post);
    expect((await s.say("Bonjour")).status).toBe(200);
    expect(failures).toBeGreaterThan(0);
  });
});

describe("StatsCounter cost sums", () => {
  it("adds the costs per day and drops bad values", async () => {
    const stats = memoryStats();
    await stats.record({
      day: "2026-10-24",
      costs: { usd: { model: 0.004, run: 0.01, milliseconds: 0.00003 }, conversations: 1, turns: 1 },
      nowMs: 0,
    });
    await stats.record({ day: "2026-10-24", costs: { usd: { model: 0.002, run: Number.NaN, translation: -1 }, turns: 1 }, nowMs: 0 });
    await stats.record({ day: "2026-10-25", costs: { usd: { transcription: 0.001 } }, nowMs: 0 });
    const s = await stats.summary();
    expect(s.costs!.days.map((d) => d.day)).toEqual(["2026-10-25", "2026-10-24"]);
    expect(s.costs!.totals.usd).toEqual({ model: 0.006, run: 0.01, milliseconds: 0.00003, transcription: 0.001, translation: 0 });
    expect(s.costs!.totals.conversations).toBe(1);
    expect(s.costs!.totals.turns).toBe(2);
    expect(s.costs!.since).toBe("2026-10-24");
  });

  it("has empty sums before any cost", async () => {
    const s = await memoryStats().summary();
    expect(s.costs).toMatchObject({ totals: { conversations: 0, turns: 0 }, days: [], since: null });
  });
});

describe("projection", () => {
  it("averages per conversation and per message", () => {
    const sums = {
      usd: { model: 0.3, run: 0.1, milliseconds: 0.05, transcription: 0.03, translation: 0.02 },
      conversations: 10,
      turns: 25,
    };
    expect(averages(sums).perConversation).toBeCloseTo(0.05, 12);
    expect(averages(sums).perMessage).toBeCloseTo(0.02, 12);
    expect(averages({ ...sums, conversations: 0, turns: 0 })).toEqual({ perConversation: null, perMessage: null });
  });

  it("projects the yearly fees for a share of the 811 calls, clamped to 1 to 50 %", () => {
    expect(projectYear(0.05, 10)).toEqual({ conversations: 200_000, cost: 10_000 });
    expect(projectYear(0.05, 1).conversations).toBe(CALLS_811_PER_YEAR / 100);
    expect(projectYear(0.05, 50).conversations).toBe(1_000_000);
    expect(projectYear(0.05, 90).conversations).toBe(1_000_000);
    expect(projectYear(0.05, 0).conversations).toBe(20_000);
    expect(projectYear(0.02, 25, 1000)).toEqual({ conversations: 250, cost: 5 });
  });
});
