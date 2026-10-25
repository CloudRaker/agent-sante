// Streamed /api/chat: activity steps while the turn runs, then the checked reply as the last event.
import { describe, expect, it } from "vitest";
import { readSseFrames, type Activity, type ChatResult } from "../shared/activity";
import type { TranscriptEntry } from "../shared/api";
import { cleanParam, toolRow } from "../worker/activity";
import { vaccineAgent } from "../worker/fake/run";
import { RunClient, RunError, type CallOptions, type RunApi, type RunEvent } from "../worker/run/client";
import { makeApp, mid, ORIGIN, scriptedModel, scriptedRun, type Call } from "./helpers";

const FR_SPEC = vaccineAgent("fr");
const REPLY =
  "Pour la grippe, consultez [Québec.ca](https://www.quebec.ca/sante/conseils-et-prevention/vaccination/vaccination-contre-la-grippe).";

type App = ReturnType<typeof makeApp>;

/** Starts a session and returns a sender that reads the event stream of /api/chat. */
async function streamSession(app: App, lang: "fr" | "en" = "fr") {
  const s = await app.post("/api/session", { turnstileToken: "ok", lang });
  const state = { token: String(s.json.sessionToken), transcript: [] as TranscriptEntry[] };
  const send = async (message: string) => {
    const res = await app.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, accept: "text/event-stream" },
      body: JSON.stringify({ sessionToken: state.token, messageId: mid(), message, lang, transcript: state.transcript }),
    });
    const frames: { event: string; data: string }[] = [];
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for await (const f of readSseFrames(res.body!)) frames.push(f);
    }
    const activities = frames.filter((f) => f.event === "activity").map((f) => JSON.parse(f.data) as Activity);
    const resultFrame = frames.find((f) => f.event === "result");
    const result = resultFrame ? (JSON.parse(resultFrame.data) as ChatResult) : undefined;
    const body = result?.body as { ended?: boolean; sessionToken?: string; transcript?: TranscriptEntry[] } | undefined;
    if (result?.status === 200 && body?.ended === false) {
      state.token = body.sessionToken!;
      state.transcript = body.transcript!;
    }
    // Let the deferred stats and log work finish.
    await new Promise((r) => setTimeout(r, 0));
    return { res, frames, activities, result };
  };
  return { state, send };
}

const ids = (list: Activity[]) => list.map((a) => `${a.kind}:${a.state}`);

/** Plays Run events of one turn into the options of a scripted call. */
function play(call: Call, events: Partial<RunEvent>[]) {
  let seq = 0;
  for (const e of events) call.options?.onEvent?.({ seq: ++seq, type: "run.progress", data: {}, ...e } as RunEvent);
}

describe("streamed /api/chat", () => {
  it("sends the steps first and the checked reply as the last event", async () => {
    const { run } = scriptedRun(() => ({ text: REPLY }));
    const { model } = scriptedModel({});
    const app = makeApp(run, model);
    const { send } = await streamSession(app);
    const { res, frames, activities, result } = await send("Où aller pour la grippe ?");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(frames.at(-1)?.event).toBe("result");
    expect(frames.filter((f) => f.event === "result")).toHaveLength(1);
    expect(result?.status).toBe(200);
    expect(ids(activities)).toEqual([
      "privacy:running",
      "privacy:done",
      "routing:running",
      "routing:done",
      "agent:running",
      "agent:done",
      "safety:running",
      "safety:done",
    ]);
    expect(activities.find((a) => a.kind === "routing" && a.state === "done")?.params).toEqual({ agent: "fr/concierge", via: "concierge" });
    // Times go up and are relative to the request.
    const times = activities.map((a) => a.t);
    expect(times).toEqual(times.toSorted((a, b) => a - b));
    // The final status feeds the logs and the error rate when the stream ends.
    expect(app.logs.find((l) => l.event === "request" && l.route === "/api/chat")).toMatchObject({ status: 200, stream: true });
  });

  it("never sends the agent message text before the reply passed the check", async () => {
    const SECRET_TEXT = "Texte de brouillon que personne ne doit voir";
    const { run } = scriptedRun((call) => {
      play(call, [
        { type: "message", data: { text: SECRET_TEXT } },
        {
          type: "run.progress",
          data: { text: "Searched knowledge for vaccin grippe", tool: "knowledge_search", call_id: "c1", state: "done" },
        },
      ]);
      return { text: call.input?.includes("[Vérification automatique]") ? REPLY : SECRET_TEXT };
    });
    // The first text has advice; the rewrite is clean.
    const { model } = scriptedModel({ advice: (t) => (t === SECRET_TEXT ? 0.95 : 0.01) });
    const app = makeApp(run, model);
    const { send } = await streamSession(app);
    const { frames, result } = await send("Où aller pour la grippe ?");
    for (const f of frames.filter((x) => x.event === "activity")) expect(f.data).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(result)).toContain("Québec.ca");
    // No log line holds the query of the work row either.
    expect(JSON.stringify(app.logs)).not.toContain("vaccin grippe");
  });

  it("shows the rewrite steps, with the attempt number", async () => {
    let n = 0;
    const { run } = scriptedRun(() => ({ text: ++n === 1 ? "Prenez 2 comprimés." : REPLY }));
    const { model } = scriptedModel({ advice: (t) => (t.includes("comprimés") ? 0.9 : 0.01) });
    const { send } = await streamSession(makeApp(run, model));
    const { activities, result } = await send("J'ai mal à la tête, que faire ?");
    expect(result?.status).toBe(200);
    expect(ids(activities).slice(-6)).toEqual([
      "safety:running",
      "safety:failed",
      "rewrite:running",
      "rewrite:done",
      "safety:running",
      "safety:done",
    ]);
    expect(activities.find((a) => a.kind === "rewrite")?.params).toEqual({ attempt: 2, of: 3 });
  });

  it("ends the stream with the ended result after 3 flagged attempts", async () => {
    const { run } = scriptedRun(() => ({ text: "Prenez 2 comprimés." }));
    const { model } = scriptedModel({ advice: () => 0.9 });
    const { send } = await streamSession(makeApp(run, model));
    const { activities, result, frames } = await send("demo-trois");
    expect(frames.at(-1)?.event).toBe("result");
    expect(result).toEqual({ status: 200, body: { ended: true, reason: "medical_advice" } });
    expect(activities.filter((a) => a.kind === "rewrite" && a.state === "running").map((a) => a.params?.attempt)).toEqual([2, 3]);
    expect(activities.filter((a) => a.kind === "safety" && a.state === "failed")).toHaveLength(3);
  });

  it("shows a handoff with the target agent only, never the reason", async () => {
    const REASON = "Raison libre du modèle";
    const { run } = scriptedRun((call) =>
      call.target === "fr/concierge" ? { handoff: { to: FR_SPEC, reason: REASON } } : { text: REPLY },
    );
    const { model } = scriptedModel({});
    const { send } = await streamSession(makeApp(run, model));
    const { activities, frames, result } = await send("Où aller pour la grippe ?");
    expect(result?.status).toBe(200);
    const handoff = activities.find((a) => a.kind === "handoff");
    expect(handoff).toMatchObject({ state: "done", params: { agent: FR_SPEC } });
    expect(frames.map((f) => f.data).join("")).not.toContain(REASON);
    // Two agent steps: the concierge, then the specialist.
    expect(activities.filter((a) => a.kind === "agent" && a.state === "running").map((a) => a.params?.agent)).toEqual([
      "fr/concierge",
      FR_SPEC,
    ]);
  });

  it("turns Run heartbeats and work rows into steps", async () => {
    const { run } = scriptedRun((call) => {
      play(call, [
        { data: { text: "Still working", heartbeat: true } },
        { data: { text: "Still working", heartbeat: true } },
        {
          data: { text: "Searching knowledge for vaccin grippe pharmacie", tool: "knowledge_search", call_id: "call_a", state: "running" },
        },
        { data: { text: "Searched knowledge for vaccin grippe pharmacie", tool: "knowledge_search", call_id: "call_a", state: "done" } },
        { data: { text: "Reading Vaccination contre la grippe", tool: "knowledge_read", call_id: "call_b", state: "running" } },
        {
          data: {
            text: "Could not read Vaccination contre la grippe",
            tool: "knowledge_read",
            call_id: "call_b",
            state: "failed",
            error: { code: "x" },
          },
        },
        { data: { text: "Looked up https://evil.example", tool: "web_fetch", call_id: "call_c", state: "done" } },
        { data: { text: "Stopped" } },
      ]);
      return { text: REPLY };
    });
    const { model } = scriptedModel({});
    const { send } = await streamSession(makeApp(run, model));
    const { activities } = await send("Où aller pour la grippe ?");
    const work = activities.filter((a) => ["waiting", "search", "read", "tool"].includes(a.kind));
    expect(work.map((a) => `${a.kind}:${a.state}`)).toEqual([
      "waiting:running",
      "waiting:done",
      "search:running",
      "search:done",
      "read:running",
      "read:failed",
      "tool:done",
    ]);
    expect(work[2]?.params).toEqual({ query: "vaccin grippe pharmacie" });
    expect(work[4]?.params).toEqual({ title: "Vaccination contre la grippe" });
    expect(work[6]?.params).toEqual({ tool: "web_fetch" });
    // Run call ids stay on the server: the steps get ids of our own.
    expect(JSON.stringify(activities)).not.toContain("call_a");
    // Each step keeps one id across its updates.
    expect(work[2]?.id).toBe(work[3]?.id);
  });

  it("ends the stream with the PII error, and no Run step", async () => {
    const { run, calls } = scriptedRun(() => ({ text: REPLY }));
    const { model } = scriptedModel({});
    const app = makeApp(run, model);
    const { send } = await streamSession(app);
    const { activities, result, frames } = await send("Rappelez-moi au 514 555-0199");
    expect(ids(activities)).toEqual(["privacy:running", "privacy:failed"]);
    expect(frames.at(-1)?.event).toBe("result");
    expect(result).toEqual({ status: 422, body: { error: "pii", kinds: ["phone_number"] } });
    expect(calls).toHaveLength(0);
    expect(app.logs.find((l) => l.event === "request" && l.route === "/api/chat")).toMatchObject({ status: 422, stream: true });
  });

  it("answers plain JSON for an error before the turn starts", async () => {
    const { run } = scriptedRun(() => ({ text: REPLY }));
    const { model } = scriptedModel({});
    const app = makeApp(run, model);
    const res = await app.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, accept: "text/event-stream" },
      body: JSON.stringify({ sessionToken: "bad", messageId: mid(), message: "allo", lang: "fr", transcript: [] }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "session_expired" });
  });

  it("stops the turn, cancels the run and frees the session when the browser closes the stream", async () => {
    const calls: string[] = [];
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const run: RunApi = {
      start: (_agent, _input, _key, options?: CallOptions) =>
        new Promise((resolve, reject) => {
          calls.push("start");
          // After the cancel, a new message gets an answer at once.
          if (calls.includes("cancel:run_live")) {
            resolve({ runId: "run_2", status: "waiting", lastSeq: 1, text: REPLY });
            return;
          }
          started();
          options?.signal?.addEventListener("abort", () => {
            const error = new RunError(499, "client_closed", "closed");
            error.runId = "run_live";
            reject(error);
          });
        }),
      turn: async () => {
        throw new Error("not used");
      },
      cancel: async (runId) => {
        calls.push(`cancel:${runId}`);
      },
    };
    const { model } = scriptedModel({});
    const app = makeApp(run, model);
    const s = await app.post("/api/session", { turnstileToken: "ok", lang: "fr" });
    const body = { sessionToken: s.json.sessionToken, messageId: mid(), message: "Où aller pour une fièvre ?", lang: "fr", transcript: [] };
    const res = await app.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    const reader = res.body!.getReader();
    await reader.read();
    await startedP;
    await reader.cancel();
    await vi_waitFor(() => calls.includes("cancel:run_live"));
    expect(app.logs.some((l) => l.event === "client_closed")).toBe(true);
    // The lease is free: the same token can send again (not "busy").
    await vi_waitFor(async () => (await app.post("/api/chat", { ...body, messageId: mid() })).status === 200);
  });
});

async function vi_waitFor(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

describe("Run work rows", () => {
  it("keeps a clean query or title, and drops the rest", () => {
    expect(cleanParam("vaccin grippe")).toBe("vaccin grippe");
    expect(cleanParam("Fièvre chez l'enfant")).toBe("Fièvre chez l'enfant");
    expect(cleanParam("see https://x.example")).toBeUndefined();
    expect(cleanParam("<script>")).toBeUndefined();
    expect(cleanParam("a".repeat(81))).toBeUndefined();
    expect(cleanParam("")).toBeUndefined();
  });

  it("maps the tools and ignores what is not a tool row", () => {
    expect(toolRow({ text: "Searching knowledge", tool: "knowledge_search", call_id: "c", state: "running" })).toEqual({
      callId: "c",
      kind: "search",
      state: "running",
    });
    expect(toolRow({ text: "Read knowledge", tool: "knowledge_read", call_id: "c", state: "done" })).toEqual({
      callId: "c",
      kind: "read",
      state: "done",
    });
    expect(toolRow({ text: "x", tool: "emit_handoff", call_id: "c", state: "done" })).toBeNull();
    expect(toolRow({ text: "Still working", heartbeat: true })).toBeNull();
    expect(toolRow({ text: "Stopped" })).toBeNull();
    expect(toolRow({ text: "x", tool: "Bad Tool!", call_id: "c", state: "done" })).toEqual({
      callId: "c",
      kind: "tool",
      state: "done",
      params: {},
    });
  });
});

describe("RunClient", () => {
  it("passes each event to onEvent, and stops with client_closed and the run id when the caller aborts", async () => {
    const enc = new TextEncoder();
    const fetcher = (async (_url: string, init?: RequestInit) => {
      // Like a real fetch: an abort errors the body that is still open.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ seq: 1, type: "run.started", run_id: "run_x", data: { model: "m" } })}\n\n`),
          );
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ seq: 2, type: "run.progress", data: { text: "Still working", heartbeat: true } })}\n\n`),
          );
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream", "x-run-id": "run_x" } });
    }) as unknown as typeof fetch;
    const client = new RunClient({ token: "t", origin: "https://run.example", base: "b", fetcher });
    const seen: string[] = [];
    const ctrl = new AbortController();
    const pending = client.start("fr/concierge", "allo", "k", {
      signal: ctrl.signal,
      onEvent: (e) => {
        seen.push(e.type);
        if (seen.length === 2) ctrl.abort();
      },
    });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunError);
    expect(error).toMatchObject({ status: 499, code: "client_closed", runId: "run_x" });
    expect(seen).toEqual(["run.started", "run.progress"]);
  });
});
