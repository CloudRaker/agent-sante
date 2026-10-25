// Flight ownership, turn budget, cap per Run call, run loss,
// maintenance end, safe source titles, 404 status and the Turnstile placeholder.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSources } from "../shared/sources";
import { LEASE_MS, TURN_BUDGET_MS, memoryGuard } from "../worker/guard-core";
import { buildDeps, PAGE_HEADERS, serveAsset, type WorkerEnv } from "../worker/index";
import { RunClient, RunError } from "../worker/run/client";
import { memoryStats } from "../worker/stats-core";
import { makeApp, scriptedModel, scriptedRun, session, ORIGIN } from "./helpers";

const CLEAN = "Consultez [Québec.ca](https://www.quebec.ca/sante).";
const ADVICE = "Prenez 500 mg.";

describe("session guard flights", () => {
  it("only the flight that owns the lease can commit or abort", async () => {
    let now = 1_000;
    const guard = memoryGuard(() => now);
    await guard.init("s", "j1");
    const a = await guard.begin("s", "j1");
    expect(a.status).toBe("ok");
    expect((await guard.begin("s", "j1")).status).toBe("busy");
    now += LEASE_MS + 1; // The lease of flight a ran out.
    const b = await guard.begin("s", "j1");
    expect(b.status).toBe("ok");
    if (a.status !== "ok" || b.status !== "ok") throw new Error("flights");
    // Flight a cannot release or commit the lease of flight b.
    await guard.abort("s", a.flight);
    expect((await guard.begin("s", "j1")).status).toBe("busy");
    expect(await guard.commit("s", a.flight, "j2", "run_a")).toBe("lost");
    expect(await guard.commit("s", b.flight, "j2", "run_b")).toBe("ok");
    expect(await guard.end("s")).toEqual({ run: "run_b" });
    expect(await guard.end("s")).toBeNull();
  });

  it("the turn budget is shorter than the lease", () => {
    expect(TURN_BUDGET_MS).toBeLessThan(LEASE_MS);
  });

  it("a slow turn stops at the turn budget, and each Run call gets only the time left", async () => {
    let now = Date.now();
    const timeouts: (number | undefined)[] = [];
    const { run, calls } = scriptedRun(() => ({ text: ADVICE }));
    const slow = {
      ...run,
      start: async (a: string, i: string, k: string, o?: { timeoutMs?: number }) => {
        timeouts.push(o?.timeoutMs);
        now += 100_000;
        return run.start(a, i, k);
      },
      turn: async (r: string, i: string, k: string, o?: { timeoutMs?: number }) => {
        timeouts.push(o?.timeoutMs);
        now += 100_000;
        return run.turn(r, i, k);
      },
    };
    const { post } = makeApp(slow, scriptedModel({ advice: () => 0.97 }).model, { now: () => now });
    const { say } = await session(post);
    const res = await say("Quelle dose?");
    expect(res.status).toBe(504);
    expect(res.json).toMatchObject({ error: "timeout" });
    // Start (150 s left), one rewrite (50 s left), then no time for a third call.
    expect(timeouts).toEqual([TURN_BUDGET_MS, TURN_BUDGET_MS - 100_000]);
    expect(calls.filter((c) => c.kind !== "cancel")).toHaveLength(2);
  });
});

describe("daily cap counts Run calls", () => {
  it("takes one unit per start or turn, and none for a blocked message", async () => {
    let flagged = true;
    const { run, calls } = scriptedRun(() => ({ text: ADVICE }));
    const { model } = scriptedModel({
      advice: () => (flagged ? ((flagged = false), 0.97) : 0.01),
    });
    const stats = memoryStats();
    const { post } = makeApp(run, model, { dailyTurnCap: 2, stats });
    const { say } = await session(post);
    expect((await say("Appelez le 450 555-0101")).status).toBe(422); // No Run call, no unit.
    expect((await say("Question")).status).toBe(200); // Start + one rewrite = 2 units.
    const capped = await say("Encore");
    expect(capped.status).toBe(503);
    expect(capped.json).toMatchObject({ error: "at_capacity" });
    expect(calls.filter((c) => c.kind !== "cancel")).toHaveLength(2);
    // The run of the token stays alive: a refused turn does not cancel it.
    expect(calls.some((c) => c.kind === "cancel")).toBe(false);
  });

  it("logs an alert when the cap cannot be read, and fails open", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const real = memoryStats();
    const broken = Object.assign(Object.create(real) as typeof real, { take: async () => Promise.reject(new Error("down")) });
    const { post, logs } = makeApp(run, scriptedModel({}).model, { dailyTurnCap: 5, stats: broken });
    const { say } = await session(post);
    expect((await say("Bonjour")).status).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({ event: "stats_take_failed", alert: true }));
  });
});

describe("run loss and Run limits", () => {
  it("a rewrite on a run that ended continues in a new run", async () => {
    const { run, calls } = scriptedRun((call) => {
      if (call.kind === "turn") throw new RunError(409, "run_terminal", "ended");
      return { text: call.input?.includes("Vérification automatique") ? CLEAN : ADVICE };
    });
    let n = 0;
    const { model } = scriptedModel({ advice: () => (n++ === 0 ? 0.97 : 0.01) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Question");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ended: false, reply: { text: CLEAN } });
    expect(calls.map((c) => c.kind)).toEqual(["start", "turn", "start"]);
  });

  it("concurrency_limited answers busy with retryAfter 60", async () => {
    const { run } = scriptedRun(() => ({ status: "failed", failure: { code: "concurrency_limited", message: "x" } }));
    const { post } = makeApp(run, scriptedModel({}).model);
    const { say } = await session(post);
    const res = await say("Bonjour");
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({ error: "busy", retryAfter: 60 });
  });

  it("a rate limit or a busy run keeps the run of the token", async () => {
    let fail: RunError | null = null;
    const { run, calls } = scriptedRun((call) => {
      if (call.kind === "turn" && fail) throw fail;
      return { text: CLEAN };
    });
    const { post } = makeApp(run, scriptedModel({}).model);
    const { say } = await session(post);
    await say("Bonjour");
    fail = new RunError(429, "rate_limited", "slow down", 30);
    expect((await say("Deux")).json).toMatchObject({ error: "busy", retryAfter: 30 });
    fail = new RunError(409, "run_busy", "busy");
    expect((await say("Trois")).status).toBe(409);
    expect(calls.some((c) => c.kind === "cancel")).toBe(false);
  });

  it("a milliseconds outage after the reply keeps the run of the token", async () => {
    let down = false;
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const model = {
      entities: async () => [],
      yesNoHint: async () => {
        if (down) throw new Error("down");
        return 0.01;
      },
    };
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    await say("Bonjour");
    down = true;
    expect((await say("Deux")).status).toBe(503);
    expect(calls.some((c) => c.kind === "cancel")).toBe(false);
  });

  it("logs an unknown handoff target as unknown, never as free text", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN, handoff: { to: "Mon nom est Jean Tremblay", reason: "x" } }));
    const { post, logs } = makeApp(run, scriptedModel({}).model);
    const { say } = await session(post);
    await say("Bonjour");
    expect(logs).toContainEqual(expect.objectContaining({ event: "handoff_refused", to: "unknown" }));
    expect(JSON.stringify(logs)).not.toContain("Tremblay");
  });
});

describe("Run client", () => {
  it("a stream that closes with no event on turn 2 reads the current turn first", async () => {
    const urls: string[] = [];
    const client = new RunClient({
      token: "t",
      origin: "https://run.test",
      base: "b",
      fetcher: async (url, init) => {
        const u = String(url);
        urls.push(`${init?.method ?? "GET"} ${u}`);
        if (init?.method === "POST") return new Response("", { headers: { "content-type": "text/event-stream" } });
        if (u.endsWith("/_run/run_1")) return Response.json({ id: "run_1", turn: 2, last_seq: 6 });
        return Response.json({
          events: [
            { seq: 1, type: "turn.started", turn: 1, data: {} },
            { seq: 2, type: "message", turn: 1, data: { text: "Ancienne réponse." } },
            { seq: 3, type: "turn.completed", turn: 1, data: {} },
            { seq: 4, type: "turn.started", turn: 2, data: {} },
            { seq: 5, type: "message", turn: 2, data: { text: "Nouvelle réponse." } },
            { seq: 6, type: "turn.completed", turn: 2, data: {} },
          ],
        });
      },
    });
    const reply = await client.turn("run_1", "x", "k");
    expect(reply).toMatchObject({ status: "waiting", text: "Nouvelle réponse." });
    expect(urls[1]).toBe("GET https://run.test/_run/run_1");
  });
});

describe("maintenance and sources", () => {
  it("with the kill switch on, /api/end still cancels the current run", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { post, deps } = makeApp(run, scriptedModel({}).model);
    const { say, state } = await session(post);
    await say("Bonjour");
    deps.maintenance = true;
    expect((await say("Encore")).json).toMatchObject({ error: "maintenance" });
    const end = await post("/api/end", { sessionToken: state.token });
    expect(end.status).toBe(204);
    expect(calls.at(-1)).toMatchObject({ kind: "cancel", target: "run_1" });
  });

  it("a link with a bad percent escape does not throw, and keeps the raw segment", () => {
    expect(extractSources("Voir https://www.quebec.ca/sante/%E0")).toEqual([
      { url: "https://www.quebec.ca/sante/%E0", domain: "quebec.ca", title: "%E0" },
    ]);
  });
});

describe("static pages", () => {
  const assets = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) };

  it("an unknown path answers 404 with the app shell; a known path answers 200", async () => {
    const missing = await serveAsset(new Request(`${ORIGIN}/en/call-811`), assets);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("<!doctype html>");
    expect((await serveAsset(new Request(`${ORIGIN}/en/calling-811/`), assets)).status).toBe(200);
    expect((await serveAsset(new Request(`${ORIGIN}/`), assets)).status).toBe(200);
  });

  it("sets the same security headers as public/_headers", async () => {
    const res = await serveAsset(new Request(`${ORIGIN}/presse`), assets);
    for (const [k, v] of Object.entries(PAGE_HEADERS)) expect(res.headers.get(k)).toBe(v);
    const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    const block = file.split("\n/assets/*")[0]!.split("\n/*\n")[1]!;
    const fromFile = Object.fromEntries(
      block
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
    );
    expect(fromFile).toEqual(PAGE_HEADERS);
  });
});

const prodEnv = (over: Partial<WorkerEnv>): WorkerEnv =>
  ({
    ENVIRONMENT: "production",
    RUN_BASE_URL: "https://cloudraker.cloudraker.run",
    RUN_BASE: "agent-sante",
    RUN_EXPECTED_MODEL: "anthropic/claude-haiku-5-5",
    MS_BASE_URL: "https://api.milliseconds.ai/v1/decision-machine-1",
    TURNSTILE_SITE_KEY: "REPLACE_WITH_TURNSTILE_SITE_KEY",
    ALLOWED_HOSTNAMES: "agentsante.ca",
    SESSION_SECRET: "x".repeat(40),
    RUN_TOKEN: "t",
    MS_API_KEY: "m",
    TURNSTILE_SECRET: "s",
    SESSIONS: {} as WorkerEnv["SESSIONS"],
    ...over,
  }) as WorkerEnv;

describe("Turnstile site key", () => {
  it("the placeholder key makes the Worker misconfigured", () => {
    expect(buildDeps(prodEnv({}), new URL(`${ORIGIN}/`)).misconfigured).toBe("turnstile_site_key_placeholder");
    expect(buildDeps(prodEnv({ TURNSTILE_SITE_KEY: "" }), new URL(`${ORIGIN}/`)).misconfigured).toBe("turnstile_site_key_placeholder");
    expect(buildDeps(prodEnv({ TURNSTILE_SITE_KEY: "0x4AAAAAAA" }), new URL(`${ORIGIN}/`)).misconfigured).toBeUndefined();
  });
});
