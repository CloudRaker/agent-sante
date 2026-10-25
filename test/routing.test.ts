// Direct routing of the first message, early handoff, and the early medical-advice check.
import { describe, expect, it } from "vitest";
import { agents } from "../shared/agents";
import { vaccineAgent } from "../worker/fake/run";
import { RunClient, type RunEvent } from "../worker/run/client";
import { keywordRoute, pickRoute, routeLabels, ROUTE_LOW, ROUTE_RATIO, ROUTE_THRESHOLD, UNCLEAR } from "../worker/safety/routing";
import { makeApp, scriptedModel, scriptedRun, session } from "./helpers";

const FR_SPEC = vaccineAgent("fr");
const ev = (type: string, data: Record<string, unknown>): RunEvent => ({ seq: 3, type, data });
const CLEAN = "La vaccination est gratuite pour plusieurs groupes. Source : [Québec.ca](https://www.quebec.ca/sante)";

describe("routing labels", () => {
  it("lists every specialist of the language, plus unclear, never the concierge", () => {
    for (const lang of ["fr", "en"] as const) {
      const labels = routeLabels(agents, lang);
      const specialists = agents.catalog.agents.filter((a) => a.lang === lang && a.id !== agents.entry(lang)).map((a) => a.id);
      expect(Object.keys(labels).toSorted()).toEqual([...specialists, UNCLEAR].toSorted());
      for (const d of Object.values(labels)) expect(d.length).toBeGreaterThan(10);
    }
  });

  it("picks only a same-language specialist at or above the threshold", () => {
    expect(pickRoute(agents, "fr", { label: FR_SPEC, probability: ROUTE_THRESHOLD })).toBe(FR_SPEC);
    expect(pickRoute(agents, "fr", { label: FR_SPEC, probability: ROUTE_THRESHOLD - 0.01 })).toBeUndefined();
    expect(pickRoute(agents, "fr", { label: UNCLEAR, probability: 0.99 })).toBeUndefined();
    expect(pickRoute(agents, "fr", { label: vaccineAgent("en"), probability: 0.99 })).toBeUndefined();
    expect(pickRoute(agents, "fr", { label: "fr/concierge", probability: 0.99 })).toBeUndefined();
    expect(pickRoute(agents, "fr", { label: "fr/unknown", probability: 0.99 })).toBeUndefined();
    expect(pickRoute(agents, "fr", null)).toBeUndefined();
  });

  it("also picks a winner below the threshold when its margin over the second score is wide", () => {
    expect(pickRoute(agents, "fr", { label: FR_SPEC, probability: 0.38, second: 0.1 })).toBe(FR_SPEC);
    expect(pickRoute(agents, "fr", { label: FR_SPEC, probability: 0.38, second: 0.2 })).toBeUndefined();
    expect(pickRoute(agents, "fr", { label: FR_SPEC, probability: ROUTE_LOW - 0.01, second: 0.01 })).toBeUndefined();
    expect(pickRoute(agents, "fr", { label: UNCLEAR, probability: 0.4, second: 0.01 })).toBeUndefined();
    expect(ROUTE_RATIO).toBe(2.5);
  });

  it("sends a first message that names a vaccine to the vaccines agent of its language", () => {
    expect(keywordRoute(agents, "fr", "Où me faire vacciner contre la grippe ?")).toBe(vaccineAgent("fr"));
    expect(keywordRoute(agents, "en", "Where can I get a flu shot?")).toBe(vaccineAgent("en"));
    expect(keywordRoute(agents, "en", "Is the COVID vaccine free?")).toBe(vaccineAgent("en"));
    expect(keywordRoute(agents, "fr", "J'ai la grippe depuis hier")).toBeUndefined();
  });

  it("starts the vaccines agent at once for a vaccine question, with no classify call", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model, classified } = scriptedModel({ classify: () => ({ label: UNCLEAR, probability: 0.9 }) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Où me faire vacciner contre la grippe ?");
    expect(res.status).toBe(200);
    expect(classified).toEqual([]);
    expect(calls[0]).toMatchObject({ kind: "start", target: vaccineAgent("fr") });
  });
});

describe("direct routing of the first message", () => {
  it("starts the specialist directly when the classify winner is clear", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model, classified } = scriptedModel({ classify: () => ({ label: FR_SPEC, probability: 0.81 }) });
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Est-ce que la grippe est contagieuse?");
    expect(res.status).toBe(200);
    expect(classified).toHaveLength(1);
    expect(calls.map((c) => [c.kind, c.target])).toEqual([["start", FR_SPEC]]);
    expect(calls[0]!.input).toBe("Est-ce que la grippe est contagieuse?");
    if (res.json.ended) throw new Error("ended");
    expect(res.json.agentId).toBe(FR_SPEC);
    expect(res.json.handoff).toEqual({ from: "fr/concierge", to: FR_SPEC });
    expect(res.json.transcript.map((e) => e.agent)).toEqual([FR_SPEC, FR_SPEC]);
    // Label and score only: no text, no description.
    const route = logs.find((e) => e.event === "route_score")!;
    expect(Object.keys(route).toSorted()).toEqual(["event", "label", "rid", "route", "score"]);
    expect(route).toMatchObject({ label: FR_SPEC, score: 0.81 });

    // The second message continues the specialist run, with no classify call.
    const next = await say("Et pour les enfants?");
    expect(next.status).toBe(200);
    expect(classified).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({ kind: "turn", target: "run_1" });
  });

  it.each([
    ["unclear", { label: UNCLEAR, probability: 0.9 }],
    ["a low score", { label: FR_SPEC, probability: 0.3 }],
    ["a label of the other language", { label: vaccineAgent("en"), probability: 0.95 }],
  ])("starts the concierge on %s", async (_name, result) => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({ classify: () => result });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Bonjour");
    expect(res.status).toBe(200);
    expect(calls.map((c) => [c.kind, c.target])).toEqual([["start", "fr/concierge"]]);
    if (res.json.ended) throw new Error("ended");
    expect(res.json.handoff).toBeUndefined();
  });

  it("starts the concierge when classify fails (routing is not a safety check)", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({
      classify: () => {
        throw new Error("down");
      },
    });
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Où aller pour la grippe?");
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ kind: "start", target: "fr/concierge" });
    expect(logs.some((e) => e.event === "route_unavailable")).toBe(true);
  });

  it("ignores the classify result when the entities check finds PII: nothing reaches Run", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model, classified } = scriptedModel({
      classify: () => ({ label: FR_SPEC, probability: 0.99 }),
      spans: (text) => {
        const i = text.indexOf("Josée");
        return [{ type: "person_name", text: "Josée Tremblay", probability: 0.98, start: i, end: i + 14 }];
      },
    });
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Je suis Josée Tremblay, la grippe est-elle contagieuse?");
    expect(res.status).toBe(422);
    expect(res.json.kinds).toEqual(["person_name"]);
    expect(classified).toHaveLength(1); // It ran in parallel with the PII check...
    expect(calls).toHaveLength(0); // ...and its result was dropped.
    expect(logs.some((e) => e.event === "agent_change")).toBe(false);
  });

  it("makes no classify call when the regex layer finds PII", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model, classified, seen } = scriptedModel({ classify: () => ({ label: FR_SPEC, probability: 0.99 }) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Rappelez-moi au 514 555-0199 pour la grippe");
    expect(res.status).toBe(422);
    expect(classified).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the PII check is down, even with a clear route", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const { model } = scriptedModel({ fail: true, classify: () => ({ label: FR_SPEC, probability: 0.99 }) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("La grippe est-elle contagieuse?");
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("does not route when the person changed the language on the first message", async () => {
    const { run, calls } = scriptedRun(() => ({ text: "Flu shots are free for many groups." }));
    const { model, classified } = scriptedModel({ classify: () => ({ label: vaccineAgent("en"), probability: 0.99 }) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Is the flu shot free?", { lang: "en" });
    expect(res.status).toBe(200);
    expect(classified).toHaveLength(0);
    expect(calls[0]).toMatchObject({ kind: "start", target: "en/concierge" });
  });
});

describe("early handoff", () => {
  it("passes a stop rule that matches only a valid handoff, cancels the concierge and starts the target", async () => {
    const { run, calls } = scriptedRun((call) =>
      call.target === "fr/concierge" ? { handoff: { to: FR_SPEC, reason: "vaccin" }, stoppedEarly: true, text: "" } : { text: CLEAN },
    );
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("La grippe est-elle contagieuse?");
    expect(res.status).toBe(200);
    if (res.json.ended) throw new Error("ended");
    expect(res.json.reply.text).toBe(CLEAN);
    expect(calls.map((c) => [c.kind, c.target])).toEqual([
      ["start", "fr/concierge"],
      ["cancel", "run_1"],
      ["start", FR_SPEC],
    ]);
    const stop = calls[0]!.options!.stopWhen!;
    expect(stop(ev("event.handoff", { to: FR_SPEC, reason: "x" }))).toBe(true);
    expect(stop(ev("event.handoff", { to: "fr/concierge", reason: "x" }))).toBe(false); // to itself
    expect(stop(ev("event.handoff", { to: vaccineAgent("en"), reason: "x" }))).toBe(false); // other language
    expect(stop(ev("event.switch_language", { to: "en" }))).toBe(true);
    expect(stop(ev("event.switch_language", { to: "fr" }))).toBe(false);
    expect(stop(ev("message", { text: "Je vous dirige." }))).toBe(false);
    // The first hop can still be cut, because one more hop is allowed after it.
    expect(calls[2]!.options!.stopWhen).toBeTypeOf("function");
  });

  it("does not cut the read of the last allowed hop", async () => {
    const other = agents.catalog.agents.find((a) => a.lang === "fr" && a.id !== FR_SPEC && a.id !== "fr/concierge")!.id;
    const { run, calls } = scriptedRun((call) =>
      call.target === "fr/concierge"
        ? { handoff: { to: FR_SPEC, reason: "a" }, stoppedEarly: true }
        : call.target === FR_SPEC
          ? { handoff: { to: other, reason: "b" }, stoppedEarly: true }
          : { text: CLEAN },
    );
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("La grippe est-elle contagieuse?");
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.kind === "start").map((c) => c.target)).toEqual(["fr/concierge", FR_SPEC, other]);
    expect(calls.find((c) => c.target === other)!.options?.stopWhen).toBeUndefined();
  });

  it("never shows a reply that was cut at a handoff no hop followed", async () => {
    const { run, calls } = scriptedRun(() => ({ handoff: { to: FR_SPEC, reason: "x" }, stoppedEarly: true, text: "Je vous dirige." }));
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("La grippe est-elle contagieuse?");
    // concierge -> FR_SPEC -> (FR_SPEC cannot hand off to itself): the cut reply is refused.
    expect(res.status).toBe(503);
    expect(calls.filter((c) => c.kind === "cancel").length).toBeGreaterThan(0);
  });

  it("RunClient returns at the handoff event, without waiting for the rest of the turn", async () => {
    let aborted = false;
    const client = new RunClient({
      token: "crr_test",
      origin: "https://run.test",
      base: "agent-sante",
      fetcher: async (_url, init) => {
        init?.signal?.addEventListener("abort", () => (aborted = true));
        const frames: RunEvent[] = [
          { seq: 1, type: "run.started", run_id: "run_7", turn: 1, data: { model: "openai/gpt-6-luna" } },
          { seq: 2, type: "turn.started", run_id: "run_7", turn: 1, data: {} },
          { seq: 3, type: "event.handoff", run_id: "run_7", turn: 1, data: { to: FR_SPEC, reason: "vaccin" } },
        ];
        // The stream stays open after the handoff, as when the model still writes its line.
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(new TextEncoder().encode(`id: ${f.seq}\nevent: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream", "x-run-id": "run_7" } });
      },
    });
    const reply = await client.start("fr/concierge", "hi", "k1", {
      timeoutMs: 2_000,
      stopWhen: (e) => e.type === "event.handoff",
    });
    expect(reply).toMatchObject({ runId: "run_7", stoppedEarly: true, handoff: { to: FR_SPEC } });
    expect(aborted).toBe(true);
  });

  it("RunClient reports the text so far on each message event", async () => {
    const seen: string[] = [];
    const client = new RunClient({
      token: "crr_test",
      origin: "https://run.test",
      base: "agent-sante",
      fetcher: async () => {
        const frames: RunEvent[] = [
          { seq: 1, type: "turn.started", run_id: "run_8", turn: 1, data: {} },
          { seq: 2, type: "message", run_id: "run_8", turn: 1, data: { text: " Un. " } },
          { seq: 3, type: "message", run_id: "run_8", turn: 1, data: { text: "Deux." } },
          { seq: 4, type: "turn.completed", run_id: "run_8", turn: 1, data: { turn: 1, reason: "yield" } },
        ];
        const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
        return new Response(text, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const reply = await client.start("fr/concierge", "hi", "k1", { onText: (t) => seen.push(t) });
    expect(seen).toEqual(["Un.", "Un.\n\nDeux."]);
    expect(reply.text).toBe(seen.at(-1));
  });
});

describe("early medical-advice check", () => {
  it("reuses the check started on the final text: one check, no extra round trip", async () => {
    const { run } = scriptedRun((call) => {
      call.options?.onText?.(CLEAN);
      return { text: CLEAN };
    });
    const { model, checked } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("La grippe est-elle contagieuse?");
    expect(res.status).toBe(200);
    expect(checked).toEqual([CLEAN]);
  });

  it("checks the final text again when it differs from the early text", async () => {
    const { run } = scriptedRun((call) => {
      call.options?.onText?.("Premier bout.");
      return { text: CLEAN };
    });
    const { model, checked } = scriptedModel({ advice: (t) => (t === CLEAN ? 0.95 : 0.01) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("La grippe est-elle contagieuse?");
    // The partial text passed, but the final text is flagged on each attempt: the 3-strike rule ends it.
    expect(checked.filter((t) => t === CLEAN)).toHaveLength(3);
    expect(res.json).toMatchObject({ ended: true, reason: "medical_advice" });
  });
});

describe("milliseconds classify client", () => {
  it("sends one attempt with the question and reads label and probability", async () => {
    const { Milliseconds } = await import("../worker/safety/milliseconds");
    const bodies: unknown[] = [];
    const ms = new Milliseconds("prod_sk-test", "https://ms.test/v1/decision-machine-1", async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ label: FR_SPEC, probability: 0.7, confidence: 0.4, scores: {} }), { status: 200 });
    });
    expect(await ms.classify("x", { a: "b" }, "q")).toEqual({ label: FR_SPEC, probability: 0.7 });
    expect(bodies).toEqual([{ text: "x", labels: { a: "b" }, question: "q" }]);
  });

  it("does not retry a failed classify call", async () => {
    const { Milliseconds } = await import("../worker/safety/milliseconds");
    let n = 0;
    const ms = new Milliseconds("prod_sk-test", "https://ms.test/v1/decision-machine-1", async () => {
      n++;
      return new Response("", { status: 529 });
    });
    await expect(ms.classify("x", { a: "b" })).rejects.toThrow("milliseconds 529");
    expect(n).toBe(1);
  });
});
