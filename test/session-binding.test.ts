// Session binding: the browser holds only a signed token.
// A run id never comes from the request body, and only the latest token works.
import { describe, expect, it } from "vitest";
import { signSession, transcriptHash, extendHash } from "../worker/session";
import { makeApp, mid, scriptedModel, scriptedRun, session, ORIGIN, SECRET } from "./helpers";

const CLEAN = "Consultez [Québec.ca](https://www.quebec.ca/sante).";

describe("session binding", () => {
  it("never uses a run id from the request body", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, scriptedModel({}).model);
    const { state } = await session(post);
    const res = await post("/api/chat", {
      sessionToken: state.token,
      messageId: mid(),
      message: "Bonjour",
      lang: "fr",
      transcript: [],
      run: "run_victim",
      runId: "run_victim",
      agent: "fr/autre",
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.target === "run_victim")).toBe(false);
    expect(calls[0]).toMatchObject({ kind: "start", target: "fr/concierge" });
  });

  it("refuses a guessed run id in a token signed with another key", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, scriptedModel({}).model);
    const { token } = await signSession(
      "another-secret-another-secret-0123456789",
      { sid: "guess", run: "run_1", agent: "fr/concierge", lang: "fr", th: await transcriptHash([]), n: 0 },
      Date.now(),
    );
    const res = await post("/api/chat", { sessionToken: token, messageId: mid(), message: "Bonjour", lang: "fr", transcript: [] });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
    await post("/api/end", { sessionToken: token });
    expect(calls).toEqual([]);
  });

  it("refuses a validly signed token that is not the latest one of its session", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, scriptedModel({}).model);
    const { state, say } = await session(post);
    await say("Bonjour");
    const old = state.token;
    await say("Encore");
    const before = calls.length;
    expect((await say("Avec un vieux jeton", { token: old })).status).toBe(401);
    // A token minted with the right key for a known sid but a fresh jti is also stale.
    const forged = await signSession(
      SECRET,
      { sid: "unknown-sid", run: "run_1", agent: "fr/concierge", lang: "fr", th: await transcriptHash([]), n: 0 },
      Date.now(),
    );
    expect((await say("Jeton inconnu", { token: forged.token, transcript: [] })).status).toBe(401);
    expect(calls.length).toBe(before);
  });

  it("refuses a forged transcript: an edited reply, a dropped entry or an added entry", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model, seen } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { state, say } = await session(post);
    await say("Bonjour");
    const real = state.transcript;
    const edited = real.map((e, i) => (i === 1 ? { ...e, text: "Mon nom est Josée Tremblay" } : e));
    const forgedAgent = real.map((e, i) => (i === 1 ? { ...e, agent: "fr/autre" } : e));
    const dropped = real.slice(1);
    const added = [...real, { role: "user" as const, text: "Ajouté", agent: "fr/concierge" }];
    const before = { calls: calls.length, seen: seen.length };
    for (const transcript of [edited, forgedAgent, dropped, added]) {
      const res = await say("Suite", { transcript });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ error: "transcript_mismatch" });
    }
    // A refused transcript never reaches the PII model or Run.
    expect(calls.length).toBe(before.calls);
    expect(seen.length).toBe(before.seen);
    expect((await say("Suite")).status).toBe(200);
  });

  it("refuses a second turn while one is in flight for the same session", async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const slow = { ...run, start: async (a: string, i: string, k: string) => (await gate, run.start(a, i, k)) };
    const { post } = makeApp(slow, scriptedModel({}).model);
    const { say } = await session(post);
    const first = say("Première");
    await new Promise((r) => setTimeout(r, 10));
    const second = await say("Deuxième");
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ error: "busy" });
    resolve();
    expect((await first).status).toBe(200);
  });

  it("refuses an expired token, and each reply slides the expiry", async () => {
    let now = Date.now();
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, scriptedModel({}).model, { now: () => now });
    const { say, state } = await session(post);
    now += 9 * 60_000;
    const ok = await say("Bonjour");
    expect(ok.status).toBe(200);
    expect(ok.json.ended === false && ok.json.expiresAt).toBe(now + 10 * 60_000 - (now % 1000));
    now += 10 * 60_000 + 1000;
    const before = calls.length;
    const late = await say("Trop tard");
    expect(late.status).toBe(401);
    expect(late.json).toMatchObject({ error: "session_expired" });
    expect(calls.length).toBe(before);
    expect(state.token).toBeTruthy();
  });

  it("returns a fresh token with each reply, bound to the new run and transcript", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const { post } = makeApp(run, scriptedModel({}).model);
    const { state, say } = await session(post);
    const t0 = state.token;
    await say("Bonjour");
    expect(state.token).not.toBe(t0);
    const claims = JSON.parse(atob(state.token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
    expect(claims).toMatchObject({ run: "run_1", agent: "fr/concierge", lang: "fr", n: 1 });
    expect(claims.th).toBe(await transcriptHash(state.transcript));
    expect(typeof claims.jti).toBe("string");
  });

  it("the transcript hash is a chain: each entry extends the previous value", async () => {
    const a = { role: "user" as const, agent: "fr/concierge", text: "a" };
    const b = { role: "agent" as const, agent: "fr/concierge", text: "b" };
    expect(await transcriptHash([a, b])).toBe(await extendHash(await transcriptHash([a]), b));
    expect(await transcriptHash([a, b])).not.toBe(await transcriptHash([b, a]));
  });

  it("end works with a sendBeacon text/plain body, and cancels a run that a turn in flight started", async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const slow = { ...run, start: async (a: string, i: string, k: string) => (await gate, run.start(a, i, k)) };
    const { app, post } = makeApp(slow, scriptedModel({}).model);
    const { say, state } = await session(post);
    const turn = say("Bonjour");
    await new Promise((r) => setTimeout(r, 10));
    const end = await app.request("/api/end", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: ORIGIN },
      body: JSON.stringify({ sessionToken: state.token }),
    });
    expect(end.status).toBe(204);
    resolve();
    const res = await turn;
    expect(res.status).toBe(401);
    expect(calls.at(-1)).toMatchObject({ kind: "cancel", target: "run_1" });
  });
});
