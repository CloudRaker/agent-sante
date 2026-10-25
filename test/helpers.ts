// Fakes for the pipeline tests: a scripted Run and a scripted milliseconds model.
import { agents } from "../shared/agents";
import type { ChatResponse, TranscriptEntry } from "../shared/api";
import { createApp, type AppDeps } from "../worker/app";
import { memoryGuard } from "../worker/guard-core";
import { memoryStats } from "../worker/stats-core";
import type { LogEvent } from "../worker/pipeline";
import type { CallOptions, Reply, RunApi } from "../worker/run/client";
import type { EntitySpan } from "../worker/safety/checks";
import type { DecisionModel } from "../worker/safety/milliseconds";

export const ORIGIN = "https://agentsante.ca";
export const SECRET = "test-secret-test-secret-test-secret-0123";

export interface Call {
  kind: "start" | "turn" | "cancel";
  target: string;
  input?: string;
  /** The answer to the open question, when the turn carries one. */
  answer?: { question_id: string; value: string };
  options?: CallOptions;
}

type Script = (call: Call, runId: string) => Partial<Reply>;

/** A Run fake: each start or turn asks `script` for the reply. Records every call. */
export function scriptedRun(script: Script) {
  const calls: Call[] = [];
  let n = 0;
  const run: RunApi = {
    async start(agentId, input, _key, options) {
      const call: Call = { kind: "start", target: agentId, input, options };
      calls.push(call);
      const runId = `run_${++n}`;
      return { runId, status: "waiting", lastSeq: 1, text: "", ...script(call, runId) };
    },
    async turn(runId, input, _key, options) {
      const call: Call =
        typeof input === "string"
          ? { kind: "turn", target: runId, input, options }
          : { kind: "turn", target: runId, input: input.input ?? "", answer: input.answer, options };
      calls.push(call);
      return { runId, status: "waiting", lastSeq: 1, text: "", ...script(call, runId) };
    },
    async cancel(runId) {
      calls.push({ kind: "cancel", target: runId });
    },
  };
  return { run, calls };
}

/** A model fake: `advice(text)` returns the advice score; `spans(text)` the entities. */
export function scriptedModel(options: {
  spans?: (text: string) => EntitySpan[];
  advice?: (text: string) => number;
  fail?: boolean;
  /** When set, the model has classify (direct routing). Throwing simulates an outage. */
  classify?: (text: string, labels: Record<string, string>) => { label: string; probability: number };
}) {
  const seen: string[] = [];
  const classified: string[] = [];
  const checked: string[] = [];
  const model: DecisionModel = {
    async entities(text) {
      seen.push(text);
      if (options.fail) throw new Error("down");
      return options.spans?.(text) ?? [];
    },
    async yesNoHint(text) {
      checked.push(text);
      if (options.fail) throw new Error("down");
      return options.advice?.(text) ?? 0.01;
    },
  };
  if (options.classify) {
    const classify = options.classify;
    model.classify = async (text, labels) => {
      classified.push(text);
      return classify(text, labels);
    };
  }
  return { model, seen, classified, checked };
}

export function makeApp(run: RunApi, model: DecisionModel, overrides: Partial<AppDeps> = {}) {
  const logs: LogEvent[] = [];
  const guard = memoryGuard();
  const deps: AppDeps = {
    agents,
    secret: SECRET,
    now: () => Date.now(),
    log: (e) => logs.push(e),
    run,
    model,
    guard,
    turnstileSiteKey: "site",
    verifyTurnstile: async (token) => token === "ok",
    limiters: {},
    allowedHosts: ["agentsante.ca"],
    fake: false,
    stats: memoryStats(),
    maintenance: false,
    dailyTurnCap: 0,
    ...overrides,
  };
  const app = createApp(() => deps);
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> & ChatResponse };
  };
  return { app, post, logs, guard, deps };
}

let counter = 0;
export const mid = () => `message${String(++counter).padStart(6, "0")}`;

/** Starts a session and returns a helper that sends messages with the right token and transcript. */
export async function session(post: ReturnType<typeof makeApp>["post"], lang: "fr" | "en" = "fr") {
  const s = await post("/api/session", { turnstileToken: "ok", lang });
  if (s.status !== 200) throw new Error(`session ${s.status}`);
  const state = { token: String(s.json.sessionToken), transcript: [] as TranscriptEntry[], lang };
  const say = async (
    message: string,
    opts: { lang?: "fr" | "en"; token?: string; transcript?: TranscriptEntry[]; choice?: boolean } = {},
  ) => {
    const res = await post("/api/chat", {
      sessionToken: opts.token ?? state.token,
      messageId: mid(),
      message,
      lang: opts.lang ?? state.lang,
      transcript: opts.transcript ?? state.transcript,
      ...(opts.choice ? { choice: true } : {}),
    });
    if (res.status === 200 && res.json && res.json.ended === false) {
      state.token = res.json.sessionToken;
      state.transcript = res.json.transcript;
      state.lang = res.json.lang;
    }
    return res;
  };
  return { state, say };
}
