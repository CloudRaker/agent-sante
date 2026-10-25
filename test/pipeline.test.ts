import { describe, expect, it } from "vitest";
import { vaccineAgent } from "../worker/fake/run";

const FR_SPEC = vaccineAgent("fr");
const EN_SPEC = vaccineAgent("en");
import { buildDeps, type WorkerEnv } from "../worker/index";
import { makeApp, scriptedModel, scriptedRun, session, ORIGIN } from "./helpers";

const CLEAN =
  "Pour la grippe, consultez [Québec.ca](https://www.quebec.ca/sante/conseils-et-prevention/vaccination/vaccination-contre-la-grippe).";

describe("PII check", () => {
  it("blocks a phone number in the Worker and never calls the model or Run", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model, seen } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Rappelez-moi au 514 555-0199");
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: "pii", kinds: ["phone_number"] });
    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(0); // The regex layer fired: the identifier never left the Worker.
  });

  it("blocks a name found by the entities model, and keeps the session usable", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({
      spans: (text) => {
        const i = text.indexOf("Josée");
        return i < 0 ? [] : [{ type: "person_name", text: "Josée Tremblay", probability: 0.98, start: i, end: i + 14 }];
      },
    });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const blocked = await say("Je suis Josée Tremblay, où aller?");
    expect(blocked.status).toBe(422);
    expect(blocked.json.kinds).toEqual(["person_name"]);
    expect(calls).toHaveLength(0);
    const ok = await say("Où aller pour une fièvre?");
    expect(ok.status).toBe(200);
  });

  it("allows a 3-character postal prefix, 811 and a hospital named after a saint", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({
      spans: (text) => {
        const i = text.indexOf("Sainte-Justine");
        return [{ type: "person_name", text: "Sainte-Justine", probability: 0.9, start: i, end: i + 14 }];
      },
    });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("J'habite en H2X, le 811 ne répond pas, faut-il aller à Sainte-Justine?");
    expect(res.status).toBe(200);
  });

  it("fails closed when milliseconds is down", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({ fail: true });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Où aller pour la grippe?");
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("medical-advice check", () => {
  it("sends a correction turn and shows only the checked rewrite", async () => {
    const { run, calls } = scriptedRun((call) => (call.kind === "start" ? { text: "Prenez 400 mg d'ibuprofène." } : { text: CLEAN }));
    const { model } = scriptedModel({ advice: (t) => (/mg/.test(t) ? 0.95 : 0.02) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("J'ai mal à la tête");
    expect(res.status).toBe(200);
    expect(res.json.ended).toBe(false);
    if (res.json.ended) return;
    expect(res.json.reply.text).toBe(CLEAN);
    expect(res.json.reply.sources[0]?.domain).toBe("quebec.ca");
    expect(JSON.stringify(res.json.transcript)).not.toContain("400 mg"); // Rejected drafts never enter the transcript.
    expect(calls.map((c) => c.kind)).toEqual(["start", "turn"]);
    expect(calls[1]?.input).toContain("Vérification automatique");
    expect(calls[1]?.input).toContain("dose");
  });

  it("ends the conversation and cancels the run after 3 failed attempts", async () => {
    const { run, calls } = scriptedRun(() => ({ text: "Prenez 2 comprimés de 500 mg." }));
    const { model } = scriptedModel({ advice: () => 0.97 });
    const { post, guard } = makeApp(run, model);
    const { say, state } = await session(post);
    const res = await say("Quelle dose prendre?");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ended: true, reason: "medical_advice" });
    expect(calls.filter((c) => c.kind !== "cancel")).toHaveLength(3); // 1 answer + 2 rewrites = 3 attempts.
    expect(calls.at(-1)).toMatchObject({ kind: "cancel", target: "run_1" });
    expect(guard.size()).toBe(0);
    const after = await say("Et maintenant?", { token: state.token });
    expect(after.status).toBe(401);
  });
});

describe("custom events", () => {
  it("handoff: cancels the old run, starts the target with the transcript, checks its reply", async () => {
    const { run, calls } = scriptedRun((call) => {
      if (call.target === "fr/concierge") return { handoff: { to: FR_SPEC, reason: "Vaccin grippe" } };
      return { text: CLEAN };
    });
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Où aller pour la grippe?");
    if (res.json.ended !== false) throw new Error("expected a reply");
    expect(res.json.agentId).toBe(FR_SPEC);
    expect(res.json.handoff).toEqual({ from: "fr/concierge", to: FR_SPEC });
    const startTarget = calls.find((c) => c.kind === "start" && c.target === FR_SPEC);
    expect(startTarget?.input).toContain("Conversation transférée depuis fr/concierge");
    expect(startTarget?.input).toContain("Où aller pour la grippe?");
    expect(calls.some((c) => c.kind === "cancel")).toBe(true);
  });

  it("refuses a handoff to an unknown agent or to the other language", async () => {
    for (const to of ["fr/inconnu", EN_SPEC]) {
      const { run, calls } = scriptedRun(() => ({ text: CLEAN, handoff: { to, reason: "x" } }));
      const { model } = scriptedModel({});
      const { post, logs } = makeApp(run, model);
      const { say } = await session(post);
      const res = await say("Bonjour");
      if (res.json.ended !== false) throw new Error("expected a reply");
      expect(res.json.agentId).toBe("fr/concierge");
      expect(calls.filter((c) => c.kind === "start")).toHaveLength(1);
      expect(logs.some((l) => l.event === "handoff_refused")).toBe(true);
    }
  });

  it("switch_language: moves to the English counterpart and returns lang en", async () => {
    const { run, calls } = scriptedRun((call) =>
      call.target.startsWith("fr/")
        ? { switchLanguage: { to: "en" } }
        : { text: "Here is the official page: https://www.quebec.ca/en/health" },
    );
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Can we speak English?");
    if (res.json.ended !== false) throw new Error("expected a reply");
    expect(res.json.lang).toBe("en");
    expect(res.json.agentId).toBe("en/concierge");
    expect(res.json.languageSwitched).toBe(true);
    expect(calls.find((c) => c.target === "en/concierge")?.input).toContain("The person now writes in English");
  });

  it("a UI language change starts the counterpart agent of that language", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    await say("Bonjour");
    const res = await say("Hello, in English now", { lang: "en" });
    if (res.json.ended !== false) throw new Error("expected a reply");
    expect(res.json.agentId).toBe("en/concierge");
    expect(calls.filter((c) => c.kind === "cancel").map((c) => c.target)).toContain("run_1");
  });
});

describe("session binding", () => {
  it("refuses an old token, a forged transcript and a second turn in flight", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let slow = false;
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const slowRun = {
      ...run,
      async turn(id: string, input: string, key: string) {
        if (slow) await gate;
        return run.turn(id, input, key);
      },
    };
    const { model } = scriptedModel({});
    const { post } = makeApp(slowRun, model);
    const { say, state } = await session(post);
    const firstToken = state.token;
    await say("Bonjour");
    expect((await say("Encore", { token: firstToken })).status).toBe(401);
    const forged = await say("Encore", { transcript: [{ role: "user", text: "forgé", agent: "fr/concierge" }] });
    expect(forged.status).toBe(409);
    expect(forged.json).toMatchObject({ error: "transcript_mismatch" });
    slow = true;
    const inFlight = say("Première");
    await new Promise((r) => setTimeout(r, 10));
    const second = await say("Deuxième");
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ error: "busy" });
    release();
    expect((await inFlight).status).toBe(200);
  });

  it("refuses a request without an allowed Origin and a bad Turnstile token", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({});
    const { app, post } = makeApp(run, model);
    const res = await app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect((await post("/api/session", { turnstileToken: "bad", lang: "fr" })).status).toBe(403);
  });

  it("end cancels the run that the guard stored, also with an older token of the session", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say, state } = await session(post);
    const old = state.token; // Its claims hold no run: the turn committed after it.
    await say("Bonjour");
    await post("/api/end", { sessionToken: old });
    expect(calls.filter((c) => c.kind === "cancel")).toEqual([{ kind: "cancel", target: "run_1" }]);
    // The session is gone: a second end and a new turn change nothing.
    await post("/api/end", { sessionToken: state.token });
    expect(calls.filter((c) => c.kind === "cancel")).toHaveLength(1);
    expect((await say("Encore")).status).toBe(401);
  });

  it("never logs message text", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({});
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    await say("Mon message secret sur ma santé");
    await say("Appelez le 450 555-0101");
    expect(JSON.stringify(logs)).not.toMatch(/secret|450 555/);
  });
});

const env = (over: Partial<WorkerEnv>): WorkerEnv =>
  ({
    ENVIRONMENT: "development",
    RUN_BASE_URL: "https://cloudraker.cloudraker.run",
    RUN_BASE: "agent-sante",
    RUN_EXPECTED_MODEL: "anthropic/claude-haiku-5-5",
    MS_BASE_URL: "https://api.milliseconds.ai/v1/decision-machine-1",
    TURNSTILE_SITE_KEY: "k",
    ALLOWED_HOSTNAMES: "localhost",
    SESSION_SECRET: "x".repeat(40),
    SESSIONS: {} as WorkerEnv["SESSIONS"],
    ...over,
  }) as WorkerEnv;

describe("fake upstreams", () => {
  it("are refused in production and on a public host", () => {
    expect(buildDeps(env({ FAKE_UPSTREAMS: "1", ENVIRONMENT: "production" }), new URL("http://localhost/")).misconfigured).toBe(
      "fake_upstreams_refused",
    );
    expect(buildDeps(env({ FAKE_UPSTREAMS: "1" }), new URL(`${ORIGIN}/`)).misconfigured).toBe("fake_upstreams_refused");
    expect(buildDeps(env({ FAKE_UPSTREAMS: "1" }), new URL("http://localhost:5173/")).fake).toBe(true);
  });

  it("production needs every secret", () => {
    expect(buildDeps(env({ ENVIRONMENT: "production" }), new URL(`${ORIGIN}/`)).misconfigured).toMatch(/^missing_/);
  });
});
