// Hono API under /api. Static assets are served by Workers assets; only /api/*
// reaches this code (run_worker_first in wrangler.jsonc).
import { Hono, type Context } from "hono";
import type { Activity, ChatResult } from "../shared/activity";
import type { Agents } from "../shared/agents";
import type {
  ApiError,
  ConfigResponse,
  Counter,
  Lang,
  SessionResponse,
  StatsResponse,
  TranscribeResponse,
} from "../shared/api";
import { AUDIO_TYPES, LIMITS, isLang } from "../shared/api";
import { quebecDate } from "./time";
import { sessionKey, type Analytics, type UsageEvent } from "./analytics";
import { addUsage, latencyBucket, topicOf, turnCost, turnsBucket, zeroUsage, TurnMeter, type RouteKind, type TurnCost } from "./costs";
import type { Guard } from "./guard-core";
import type { AlertAction, Stats, UsageInput } from "./stats-core";
import { parseChat, runChat, type LogEvent, type PipelineDeps } from "./pipeline";
import { placeRef } from "./places/postal";
import { randomId, signSession, transcriptHash, verifySession, type SessionClaims } from "./session";
import { TranscribeError, type Transcriber } from "./transcribe";

/** MapKit JS tokens by origin. Apple checks the page origin against the token. */
export interface MapkitTokens {
  /** Origin *.agentsante.ca (www and other subdomains). */
  wildcard?: string;
  /** Origin agentsante.ca (the apex). */
  apex?: string;
}

const APEX_HOST = "agentsante.ca";

/** The token whose origin matches the request host, or null: the UI then shows the list only. */
export function mapkitTokenFor(host: string, tokens: MapkitTokens | undefined): string | null {
  const h = host.toLowerCase();
  if (h === APEX_HOST) return tokens?.apex || null;
  if (h.endsWith(`.${APEX_HOST}`)) return tokens?.wildcard || null;
  return null;
}

export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Everything a request needs. index.ts builds it from the Worker env; tests build fakes. */
export interface AppDeps extends PipelineDeps {
  guard: Guard;
  agents: Agents;
  turnstileSiteKey: string;
  verifyTurnstile: (token: string, ip: string | undefined) => Promise<boolean>;
  /** transcribe: the small per-session limit of voice messages, on top of chatIp and chatSession. */
  limiters: { session?: Limiter; chatIp?: Limiter; chatSession?: Limiter; transcribe?: Limiter };
  /** Speech to text for voice messages (milliseconds rakeaudio). Absent: /api/transcribe answers 503. */
  transcriber?: Transcriber;
  /** Hostnames allowed in the Origin header of a POST. */
  allowedHosts: string[];
  fake: boolean;
  /** Set when the config is not safe to serve (for example fake upstreams in production). */
  misconfigured?: string;
  /** Aggregate counters, daily turn cap and error-rate window (Durable Object STATS). */
  stats: Stats;
  /** Kill switch (var KILL_SWITCH=1): the app shows a maintenance page, the API answers 503. */
  maintenance: boolean;
  /** Max Run calls (run starts and turns) per Québec day (var DAILY_TURN_CAP). 0 means no cap. */
  dailyTurnCap: number;
  /** Sends the error-rate alert (secret INCIDENT_WEBHOOK_URL). Absent when no webhook is set. */
  alert?: (action: Exclude<AlertAction, null>, info: { total: number; errors: number }) => Promise<void>;
  /** Runs work after the response (ctx.waitUntil). Tests await it. */
  defer?: (work: Promise<unknown>) => void;
  /** Apple MapKit JS tokens (wrangler vars, public, origin-restricted). No token for the host: the app shows no map. */
  mapkitTokens?: MapkitTokens;
  /** Worker var CLICSANTE_API is "on". */
  appointmentsApi?: boolean;
  /** Analytics Engine writers (COSTS, USAGE). Absent: no cost or usage data points. */
  analytics?: Analytics;
  /**
   * The meter of this request. index.ts makes one per request and feeds it the x-input-tokens of
   * each milliseconds answer. Absent: /api/chat makes one (calls are still counted).
   */
  meter?: TurnMeter;
}

type Env = {
  Variables: {
    rid: string;
    deps: AppDeps;
    log: (e: LogEvent) => void;
    counts: Partial<Record<Counter, number>>;
    /** A streamed answer: resolves with the final status when the stream ends. */
    streamDone?: Promise<number>;
  };
};

/** Routes whose status feeds the error-rate alert. */
const TRACKED = new Set(["/api/session", "/api/chat", "/api/transcribe"]);
/** Routes that still answer when the kill switch is on. /api/end stays open, so a stopped conversation still cancels its run. */
const OPEN_IN_MAINTENANCE = new Set(["/api/config", "/api/stats", "/api/end"]);

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
};

export function createApp(makeDeps: (c: Context<Env>) => AppDeps) {
  const app = new Hono<Env>().basePath("/api");

  app.use("*", async (c, next) => {
    const rid = c.req.header("cf-ray") ?? randomId(8);
    const started = Date.now();
    const deps = makeDeps(c);
    const route = new URL(c.req.url).pathname;
    // Structured logs: ids, routes, status and outcome codes only. Never message text.
    const log = (e: LogEvent) => deps.log({ rid, route, ...e });
    c.set("rid", rid);
    c.set("deps", deps);
    c.set("log", log);
    c.set("counts", {});
    if (deps.maintenance && !OPEN_IN_MAINTENANCE.has(route)) {
      log({ event: "maintenance" });
      return c.json<ApiError>({ error: "maintenance", requestId: rid }, 503, { "retry-after": "600", ...SECURITY_HEADERS });
    }
    if (deps.misconfigured) {
      log({ event: "misconfigured", reason: deps.misconfigured, alert: true });
      return c.json<ApiError>({ error: "misconfigured", requestId: rid }, 500);
    }
    if (c.req.method === "POST" && !originAllowed(c.req.header("origin"), deps.allowedHosts)) {
      log({ event: "forbidden_origin" });
      return c.json<ApiError>({ error: "forbidden_origin", requestId: rid }, 403);
    }
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    c.header("x-request-id", rid);
    const finish = (status: number, stream?: boolean): Promise<void> | undefined => {
      log({ event: "request", method: c.req.method, status, ms: Date.now() - started, ...(stream ? { stream } : {}) });
      const counts = c.get("counts");
      const tracked = TRACKED.has(route);
      if (!tracked && !Object.keys(counts).length) return undefined;
      return deps.stats
        .record({ day: quebecDate(deps.now()), counts, status: tracked ? status : undefined, nowMs: deps.now() })
        .then(async (action) => {
          if (!action) return;
          const info = await deps.stats.window();
          log({ event: "error_rate_alert", action, total: info.total, errors: info.errors, alert: action === "fire" });
          await deps.alert?.(action, info);
        })
        .catch(() => log({ event: "stats_failed" }));
    };
    const streamDone = c.get("streamDone");
    if (streamDone) {
      // A streamed answer is always HTTP 200: the logs and the error rate use the status of
      // its result event, when the stream ends. Never await it here: the body is not read yet.
      const work = streamDone.then((status) => finish(status, true));
      if (deps.defer) deps.defer(work);
      else void work.catch(() => {});
      return;
    }
    const work = finish(c.res.status);
    if (work) {
      if (deps.defer) deps.defer(work);
      else await work;
    }
  });

  app.get("/config", (c) => {
    const deps = c.get("deps");
    return c.json<ConfigResponse>({
      turnstileSiteKey: deps.turnstileSiteKey,
      fake: deps.fake,
      maintenance: deps.maintenance,
      mapkitToken: mapkitTokenFor(new URL(c.req.url).hostname, deps.mapkitTokens),
      appointmentsApi: deps.appointmentsApi === true,
    });
  });

  /** Aggregate counters for the transparency and the costs pages. Counts only, no content. */
  app.get("/stats", async (c) => {
    const deps = c.get("deps");
    try {
      return c.json<StatsResponse>(await deps.stats.summary(30, quebecDate(deps.now())));
    } catch {
      return c.json<ApiError>({ error: "unavailable" }, 503);
    }
  });

  app.post("/session", async (c) => {
    const deps = c.get("deps");
    const ip = c.req.header("cf-connecting-ip");
    if (!(await allow(deps.limiters.session, `ip:${ip ?? "unknown"}`))) {
      return c.json<ApiError>({ error: "rate_limited", retryAfter: 60 }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as { turnstileToken?: unknown; lang?: unknown } | null;
    if (
      !body ||
      typeof body.turnstileToken !== "string" ||
      !body.turnstileToken ||
      body.turnstileToken.length > 4096 ||
      !isLang(body.lang)
    ) {
      return c.json<ApiError>({ error: "invalid_request" }, 400);
    }
    let human = false;
    try {
      human = await deps.verifyTurnstile(body.turnstileToken, ip);
    } catch {
      human = false;
    }
    if (!human) {
      c.get("log")({ event: "turnstile_failed" });
      return c.json<ApiError>({ error: "turnstile_failed" }, 403);
    }
    if (await atCapacity(deps)) {
      c.get("log")({ event: "at_capacity" });
      return c.json<ApiError>({ error: "at_capacity" }, 503);
    }
    const lang = body.lang;
    const agent = deps.agents.entry(lang);
    const { token, claims } = await signSession(
      deps.secret,
      { sid: randomId(), run: "", agent, lang, th: await transcriptHash([]), n: 0 },
      deps.now(),
    );
    await deps.guard.init(claims.sid, claims.jti);
    bump(c, "conversations");
    c.get("log")({ event: "session_started", lang });
    return c.json<SessionResponse>({ sessionToken: token, expiresAt: claims.exp * 1000, agentId: agent, lang, transcript: [] });
  });

  app.post("/chat", async (c) => {
    const deps = c.get("deps");
    const log = c.get("log");
    const received = deps.now();
    const ip = c.req.header("cf-connecting-ip");
    if (!(await allow(deps.limiters.chatIp, `ip:${ip ?? "unknown"}`))) {
      return c.json<ApiError>({ error: "rate_limited", retryAfter: 60 }, 429);
    }
    const parsed = parseChat(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json<ApiError>(parsed.error, 400);
    const { req } = parsed;
    const claims = await verifySession(deps.secret, req.sessionToken, deps.now());
    if (!claims) return c.json<ApiError>({ error: "session_expired" }, 401);
    if (!(await allow(deps.limiters.chatSession, `sid:${claims.sid}`))) {
      return c.json<ApiError>({ error: "rate_limited", retryAfter: 60 }, 429);
    }
    const begun = await deps.guard.begin(claims.sid, claims.jti);
    if (begun.status === "stale") {
      log({ event: "stale_token" });
      return c.json<ApiError>({ error: "session_expired" }, 401);
    }
    if (begun.status === "busy") return c.json<ApiError>({ error: "busy", retryAfter: 5 }, 409);
    const flight = begun.flight;

    // Daily cap (launch guardrail). Run has no wallet cap, so the Worker counts each Run call.
    const day = quebecDate(deps.now());
    const take = async (): Promise<boolean> => {
      try {
        const turn = await deps.stats.take(day, deps.dailyTurnCap);
        if (!turn.ok) log({ event: "at_capacity", used: turn.used });
        return turn.ok;
      } catch {
        // The cap is a cost guardrail, not a safety check: it fails open, and says so.
        log({ event: "stats_take_failed", alert: true });
        return true;
      }
    };

    /** Runs the turn and settles the guard. Returns the status and body of the answer. */
    const session = claims;
    const meter = deps.meter ?? new TurnMeter();
    const execute = async (extra: { onActivity?: (a: Activity) => void; signal?: AbortSignal } = {}): Promise<ChatResult> => {
      let settled = false;
      log({ event: "timing_pre", ms: deps.now() - received });
      try {
        const result = await runChat({ ...deps, log, take, meter, count: (name, n = 1) => bump(c, name, n), ...extra }, session, req);
        // Cost and usage data points, after the answer (numbers and catalog ids only).
        await later(
          deps,
          recordTurn(deps, session, meter, {
            lang: result.kind === "reply" && !result.body.ended ? result.body.lang : req.lang,
            ended: result.kind === "ended" && result.body.ended ? result.body.reason : undefined,
            replied: result.kind !== "error",
            rewrites: c.get("counts").adviceBlocks ?? 0,
            turnMs: deps.now() - received,
            // The checked transcript holds the answered messages before this one (blocked ones are not in it).
            answered: req.transcript.filter((e) => e.role === "user").length + 1,
          }).catch(() => log({ event: "cost_record_failed" })),
        );
        if (result.kind === "reply") {
          const committed = await deps.guard.commit(session.sid, flight, result.jti, result.runId);
          if (committed !== "ok") {
            // "ended": the person ended the conversation while this turn ran. "lost": another flight
            // owns the session. Cancel the run this turn left alive, unless the token already held it.
            if (result.runId && (committed === "ended" || result.runId !== session.run)) {
              await deps.run.cancel(result.runId).catch(() => log({ event: "cancel_failed" }));
            }
            log({ event: committed === "ended" ? "ended_in_flight" : "flight_lost" });
            settled = true;
            return committed === "ended"
              ? { status: 401, body: { error: "session_expired" } }
              : { status: 409, body: { error: "busy", retryAfter: 5 } };
          }
        } else if (result.kind === "ended") {
          await deps.guard.end(session.sid);
          log({ event: "conversation_ended", reason: result.body.ended ? result.body.reason : "unknown" });
        } else {
          await deps.guard.abort(session.sid, flight);
        }
        settled = true;
        return { status: result.status, body: result.body };
      } finally {
        if (!settled) await deps.guard.abort(session.sid, flight).catch(() => {});
      }
    };

    if (!(c.req.header("accept") ?? "").includes("text/event-stream")) {
      // JSON answer (older clients): one body at the end.
      const out = await execute();
      return c.json(out.body, out.status as 200);
    }

    // Streamed answer (text/event-stream over fetch): activity steps as they happen, then one
    // `result` event with the same status and body as the JSON answer. The agent reply text is
    // only in that last event, after both checks passed.
    const ctrl = new AbortController();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let open = true;
    const gone = () => {
      if (!open) return;
      open = false;
      log({ event: "client_closed" });
      ctrl.abort();
    };
    const send = (event: "activity" | "result", data: unknown) => {
      if (!open) return;
      writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(gone);
    };
    // The browser closed the request (tab closed, network lost): stop the turn and cancel its run.
    c.req.raw.signal?.addEventListener("abort", gone);
    writer.closed.catch(gone);
    const done = (async () => {
      const out = await execute({ onActivity: (a) => send("activity", a), signal: ctrl.signal });
      send("result", out);
      if (open) {
        open = false;
        await writer.close().catch(() => {});
      }
      return out.status;
    })().catch(async () => {
      if (open) {
        open = false;
        await writer.abort().catch(() => {});
      }
      return 503;
    });
    c.set("streamDone", done);
    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  });

  /**
   * Voice message to text. The body is the recorded audio (raw bytes, an allowed audio content
   * type), the session token is in `authorization: Bearer`. The text goes back to the browser only:
   * the browser sends it through /api/chat like typed text, so the PII check and the routing apply.
   * The Worker never stores or logs the audio or the text (sizes, durations and statuses only).
   */
  app.post("/transcribe", async (c) => {
    const deps = c.get("deps");
    const log = c.get("log");
    const started = Date.now();
    const ip = c.req.header("cf-connecting-ip");
    if (!(await allow(deps.limiters.chatIp, `ip:${ip ?? "unknown"}`))) {
      return c.json<ApiError>({ error: "rate_limited", retryAfter: 60 }, 429);
    }
    const bearer = /^Bearer (\S{1,4096})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const claims = await verifySession(deps.secret, bearer, deps.now());
    if (!claims) return c.json<ApiError>({ error: "session_expired" }, 401);
    // A token of an ended conversation (or an older token of a live one) cannot transcribe.
    if (!(await deps.guard.live(claims.sid, claims.jti))) {
      log({ event: "transcribe", status: 401 });
      return c.json<ApiError>({ error: "session_expired" }, 401);
    }
    if (!(await allow(deps.limiters.chatSession, `sid:${claims.sid}`)) || !(await allow(deps.limiters.transcribe, `sid:${claims.sid}`))) {
      log({ event: "transcribe", status: 429 });
      return c.json<ApiError>({ error: "rate_limited", retryAfter: 60 }, 429);
    }
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!AUDIO_TYPES.includes(type)) {
      log({ event: "transcribe", status: 415 });
      return c.json<ApiError>({ error: "unsupported_audio" }, 415);
    }
    if (Number(c.req.header("content-length") ?? 0) > LIMITS.audioBytes) {
      log({ event: "transcribe", status: 413 });
      return c.json<ApiError>({ error: "audio_too_large" }, 413);
    }
    const audio = await readCapped(c.req.raw.body, LIMITS.audioBytes);
    if (audio === "too_large") {
      log({ event: "transcribe", status: 413 });
      return c.json<ApiError>({ error: "audio_too_large" }, 413);
    }
    if (!audio || audio.byteLength === 0) return c.json<ApiError>({ error: "invalid_request" }, 400);
    if (!deps.transcriber) return c.json<ApiError>({ error: "unavailable" }, 503);
    const bytes = audio.byteLength;
    try {
      const out = await deps.transcriber.transcribe(audio, type, claims.lang);
      const duration = Math.round(out.duration * 10) / 10;
      // A little margin over the browser limit: the recorder stops a few frames late.
      if (out.duration > LIMITS.audioSeconds + 3) {
        log({ event: "transcribe", status: 413, bytes, duration, type, ms: Date.now() - started });
        return c.json<ApiError>({ error: "audio_too_large" }, 413);
      }
      const text = out.text.replace(/\s+/g, " ").trim().slice(0, LIMITS.messageChars);
      if (text) bump(c, "transcriptions");
      await later(
        deps,
        recordVoice(deps, claims, out.duration, out.inputTokens, Date.now() - started).catch(() => log({ event: "cost_record_failed" })),
      );
      log({
        event: "transcribe",
        status: 200,
        bytes,
        duration,
        type,
        empty: !text || undefined,
        ms: Date.now() - started,
        inferenceMs: out.inferenceMs,
        inputTokens: out.inputTokens,
      });
      return c.json<TranscribeResponse>({ text, ms: Date.now() - started });
    } catch (error) {
      const code = error instanceof TranscribeError ? error.code : "unavailable";
      const status = code === "timeout" ? 504 : code === "unsupported_audio" ? 422 : 503;
      log({
        event: "transcribe",
        status,
        upstream: error instanceof TranscribeError ? error.status : undefined,
        bytes,
        type,
        ms: Date.now() - started,
        alert: error instanceof TranscribeError && [401, 403].includes(error.status) ? true : undefined,
      });
      return c.json<ApiError>({ error: code }, status);
    }
  });

  /** Ends the conversation: cancels the current run so its short retention clock starts. */
  app.post("/end", async (c) => {
    const deps = c.get("deps");
    // navigator.sendBeacon posts text/plain, so the body is read as text and parsed here.
    const body = parseJson(await c.req.text().catch(() => "")) as { sessionToken?: unknown } | null;
    const claims = await verifySession(deps.secret, body?.sessionToken, deps.now());
    if (!claims) return c.body(null, 204);
    // Any valid token of the session ends it, also an older one: a tab can close while a turn
    // commits. The run id comes from the guard, never from the token, so an old token
    // cancels the current run and never an old one.
    const ended = await deps.guard.end(claims.sid);
    // The place of the session (position, area, tool results) goes too.
    if (deps.places) {
      try {
        await deps.places.end(await placeRef(deps.secret, claims.sid));
      } catch {
        c.get("log")({ event: "place_end_failed" });
      }
    }
    if (ended?.run) {
      try {
        await deps.run.cancel(ended.run);
      } catch {
        c.get("log")({ event: "cancel_failed" });
      }
    }
    c.get("log")({ event: "session_ended", known: ended !== null });
    if (ended)
      await later(
        deps,
        recordEnd(deps, claims, ended.run).catch(() => c.get("log")({ event: "cost_record_failed" })),
      );
    return c.body(null, 204);
  });

  app.notFound((c) => c.json<ApiError>({ error: "invalid_request" }, 404));
  app.onError((error, c) => {
    c.get("log")?.({ event: "unhandled", name: error.name });
    return c.json<ApiError>({ error: "unavailable", requestId: c.get("rid") }, 503);
  });
  return app;
}

/** Runs work after the answer (ctx.waitUntil), or now when there is no execution context (tests). */
async function later(deps: AppDeps, work: Promise<unknown>): Promise<void> {
  if (deps.defer) deps.defer(work);
  else await work;
}

export interface TurnOutcome {
  lang: Lang;
  ended?: "medical_advice" | "too_long";
  /** The pipeline answered with a reply or an end (not an error). */
  replied: boolean;
  /** Replies removed by the medical-advice check in this request. */
  rewrites: number;
  turnMs: number;
  /** Rank of this message among the answered messages of the conversation (1 = first answered one). */
  answered: number;
}

/**
 * Reads the Run usage of each run this request touched, keeps only the part that is new since the
 * last read (the guard keeps the totals per run), and writes one cost point, the usage points and
 * the cost sums of the day. Never text: catalog ids, numbers, and a hash of the random session id.
 */
async function recordTurn(deps: AppDeps, claims: SessionClaims, meter: TurnMeter, out: TurnOutcome): Promise<void> {
  // The run in the token was live at the start: a language switch can cancel it with no call.
  if (claims.run) meter.run(claims.run);
  const runIds = [...meter.runs.keys()];
  const { usage, model } = await readUsage(deps, claims.sid, runIds, meter.runs, runIds.at(-1));
  const turn = claims.n + 1;
  const cost = turnCost({
    turn,
    run: usage,
    msCalls: meter.msCalls,
    msTokenCalls: meter.msTokenCalls,
    msTokens: meter.msTokens,
    translationInput: meter.translation.input,
    translationOutput: meter.translation.output,
    turnMs: out.turnMs,
  });
  const key = await sessionKey(claims.sid);
  const agent = meter.agent || claims.agent;
  // A request that used nothing (a refused transcript, a regex block) writes no cost point.
  const used = cost.total_usd > 0 || meter.calls.length > 0;
  if (used) deps.analytics?.cost({ key, agent, lang: out.lang, model, route: meter.route, cost });
  // Each call in the language of the agent that it went to.
  const langOf = (id: string): Lang => (id.startsWith("en/") ? "en" : id.startsWith("fr/") ? "fr" : out.lang);
  for (const call of meter.calls) deps.analytics?.use({ key, agent: call.agent, lang: langOf(call.agent), how: call.how, turn, ms: call.ms });
  const event = (how: UsageEvent) => deps.analytics?.use({ key, agent, lang: out.lang, how, turn });
  if (meter.route === "blocked") event("pii_block");
  for (let i = 0; i < out.rewrites; i++) event("medical_rewrite");
  if (meter.question) event("question");
  if (out.ended) event(out.ended === "medical_advice" ? "ended_medical_advice" : "ended_too_long");
  if (used || meter.route === "blocked") {
    const first = out.replied && meter.route !== "blocked" && out.answered === 1;
    await addCostSums(deps, cost, { conversations: first ? 1 : 0, turns: 1 }, usageCounts(meter, out));
  }
}

/** Turn numbers where a conversation enters a length bucket (1, 2-3, 4-6, 7+). */
const BUCKET_STARTS = new Set([1, 2, 4, 7]);

/**
 * The usage counts of one message for the StatsCounter: the same agent calls as the USAGE data
 * points (by agent and by topic), the length bucket that the conversation enters (by answered
 * messages, so a blocked message does not count), and the
 * response time of a reply. Counts only.
 */
export function usageCounts(meter: TurnMeter, out: TurnOutcome): UsageInput {
  const agents: Record<string, number> = {};
  const topics: Record<string, number> = {};
  for (const call of meter.calls) {
    agents[call.agent] = (agents[call.agent] ?? 0) + 1;
    const topic = topicOf(call.agent);
    topics[topic] = (topics[topic] ?? 0) + 1;
  }
  const answered = out.replied && meter.route !== "blocked" && meter.calls.length > 0;
  return {
    agents,
    topics,
    reached: answered && BUCKET_STARTS.has(out.answered) ? { [turnsBucket(out.answered)]: 1 } : {},
    latency: answered ? { [latencyBucket(out.turnMs)]: 1 } : {},
  } as UsageInput;
}

/** A voice message: one cost point with the transcription only (route "voice"), and one usage event. */
async function recordVoice(deps: AppDeps, claims: SessionClaims, seconds: number, tokens: number | undefined, ms: number): Promise<void> {
  const cost = turnCost({ turn: claims.n + 1, transcriptionSeconds: seconds, transcriptionTokens: tokens, turnMs: ms });
  const key = await sessionKey(claims.sid);
  deps.analytics?.cost({ key, agent: claims.agent, lang: claims.lang, model: "rakeaudio", route: "voice", cost });
  deps.analytics?.use({ key, agent: claims.agent, lang: claims.lang, how: "voice", turn: claims.n + 1 });
  await addCostSums(deps, cost, { conversations: 0, turns: 0 });
}

/** The person ended the conversation: the last read of the cancelled run (route "end"), and one usage event. */
async function recordEnd(deps: AppDeps, claims: SessionClaims, run: string): Promise<void> {
  const key = await sessionKey(claims.sid);
  deps.analytics?.use({ key, agent: claims.agent, lang: claims.lang, how: "ended_by_person", turn: claims.n });
  if (!run) return;
  const { usage, model } = await readUsage(deps, claims.sid, [run], new Map(), run);
  const cost = turnCost({ turn: claims.n, run: usage, turnMs: 0 });
  if (cost.total_usd <= 0) return;
  deps.analytics?.cost({ key, agent: claims.agent, lang: claims.lang, model, route: "end" satisfies RouteKind, cost });
  await addCostSums(deps, cost, { conversations: 0, turns: 0 });
}

/** The usage of the runs since the last read, summed, and the model of `main`. A failed read counts as 0. */
async function readUsage(
  deps: AppDeps,
  sid: string,
  runIds: string[],
  models: Map<string, string | undefined>,
  main: string | undefined,
): Promise<{ usage: ReturnType<typeof zeroUsage>; model?: string }> {
  if (!deps.run.usage || !runIds.length) return { usage: zeroUsage() };
  const reads = (
    await Promise.all(
      runIds.map(async (run) => {
        const usage = await deps.run.usage!(run).catch(() => null);
        const model = models.get(run);
        return usage ? { run, usage, ...(model ? { model } : {}) } : null;
      }),
    )
  ).filter((r) => r !== null);
  if (!reads.length) return { usage: zeroUsage() };
  const deltas = await deps.guard.settle(sid, reads);
  const usage = deltas.reduce((sum, d) => addUsage(sum, d.delta), zeroUsage());
  const model = deltas.find((d) => d.run === main)?.model ?? deltas.find((d) => d.model)?.model;
  return { usage, ...(model ? { model } : {}) };
}

async function addCostSums(
  deps: AppDeps,
  cost: TurnCost,
  counts: { conversations: number; turns: number },
  usage?: UsageInput,
): Promise<void> {
  await deps.stats.record({
    day: quebecDate(deps.now()),
    costs: {
      usd: {
        model: cost.model_cost_usd,
        run: cost.run_fee_usd,
        milliseconds: cost.ms_cost_usd,
        transcription: cost.transcription_cost_usd,
        translation: cost.translation_cost_usd,
      },
      ...counts,
    },
    ...(usage ? { usage } : {}),
    nowMs: deps.now(),
  });
}

function bump(c: Context<Env>, name: Counter, n = 1): void {
  const counts = c.get("counts");
  counts[name] = (counts[name] ?? 0) + n;
}

async function atCapacity(deps: AppDeps): Promise<boolean> {
  try {
    return await deps.stats.atCapacity(quebecDate(deps.now()), deps.dailyTurnCap);
  } catch {
    return false; // The cap is a cost guardrail, not a safety check: it fails open.
  }
}

/** Reads a request body up to `max` bytes. Stops reading as soon as the body is larger. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<ArrayBuffer | null | "too_large"> {
  if (!body) return null;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return "too_large";
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out.buffer;
}

function parseJson(text: string): unknown {
  if (!text || text.length > 8192) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function allow(limiter: Limiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true; // The native limiter fails open; the gateway and the guard still apply.
  }
}

export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return allowed.includes(host);
  } catch {
    return false;
  }
}
