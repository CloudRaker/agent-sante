// CloudRaker Run client. Server side only: the crr_ token is a Worker secret.
import { parseUsage, type RunUsage } from "../costs";

export interface RunEvent {
  id?: string;
  seq: number;
  type: string;
  run_id?: string;
  agent?: string;
  turn?: number;
  data: Record<string, unknown>;
}

export type RunStatus = "waiting" | "completed" | "failed" | "cancelled" | "expired";

export interface Reply {
  runId: string;
  text: string;
  status: RunStatus;
  lastSeq: number;
  /** Model id from run.started, when the stream had it. */
  model?: string;
  handoff?: { to: string; reason: string };
  switchLanguage?: { to: string };
  failure?: { code: string; message: string };
  /**
   * The agent asked a question (Run `ask`): the turn ended with reason "question". Raw model
   * text: the pipeline cleans and checks it. `text` above does not hold it.
   */
  question?: RunQuestion;
  /**
   * True when the read stopped at an event that `stopWhen` picked (an early handoff), before
   * the turn ended. The run is still running: the caller must cancel it.
   */
  stoppedEarly?: boolean;
}

/** The data of a Run `question` event. */
export interface RunQuestion {
  question_id: string;
  text: string;
  choices?: unknown;
}

/**
 * The body of a turn: a text input, or the answer to the open question
 * (`{answer: {question_id, value}}`), with an optional input line next to it.
 */
export type TurnBody = string | { input?: string; answer: { question_id: string; value: string } };

export class RunError extends Error {
  /** The run that the failed call started or used, when known (so the caller can cancel it). */
  runId?: string;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
  /** The run cannot take more turns. Start a new run with the transcript. */
  get runGone(): boolean {
    return ["run_terminal", "run_expired", "run_not_found"].includes(this.code) || this.status === 410;
  }
}

/** Per-call options. timeoutMs makes the reply deadline shorter than the client default. */
export interface CallOptions {
  timeoutMs?: number;
  /**
   * Stops the read at the first event that returns true, without waiting for the rest of the
   * turn. The reply then has `stoppedEarly` and the run is still running.
   */
  stopWhen?: (event: RunEvent) => boolean;
  /**
   * Called on each `message` event with the reply text so far, joined as in the final reply.
   * The caller can start the medical-advice check before the turn end arrives.
   */
  onText?: (text: string) => void;
  /** Called on each event of the turn, in order (activity steps for the browser). */
  onEvent?: (event: RunEvent) => void;
  /** The caller gave up (the browser closed the stream). The read stops with `client_closed`. */
  signal?: AbortSignal;
}

/** The calls the chat pipeline needs. The fake upstream and the tests replace it. */
export interface RunApi {
  /** Starts a run and waits for the end of its first turn. */
  start(agentId: string, input: string, idempotencyKey: string, options?: CallOptions): Promise<Reply>;
  /** Sends a turn (a text, or an answer to the open question) to a waiting run and waits for the end of that turn. */
  turn(runId: string, input: TurnBody, idempotencyKey: string, options?: CallOptions): Promise<Reply>;
  /** Cancels a run, so the short retention clock starts. Never throws for a run that already ended. */
  cancel(runId: string): Promise<void>;
  /**
   * The cumulative usage of a run (GET /_run/{id}, field `usage`), for the cost analytics.
   * Null when the run is gone (purged). Absent: no cost data from Run.
   */
  usage?(runId: string): Promise<RunUsage | null>;
}

const TERMINAL: Record<string, RunStatus> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.expired": "expired",
};

export interface RunConfig {
  token: string;
  /** For example https://agent-sante.cloudraker.run */
  origin: string;
  /** Repo base path, for example agent-sante. */
  base: string;
  replyTimeoutMs?: number;
  fetcher?: typeof fetch;
}

export class RunClient implements RunApi {
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: RunConfig) {
    this.fetcher = config.fetcher ?? ((...args) => fetch(...args));
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetcher(`${this.config.origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const retry = Number(res.headers.get("retry-after") ?? "") || undefined;
    throw new RunError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? res.statusText, retry);
  }

  /** Agent ids hold "/": encode each segment, keep the slashes. */
  private agentPath(agentId: string): string {
    return `/${this.config.base}/${agentId.split("/").map(encodeURIComponent).join("/")}`;
  }

  start(agentId: string, input: string, idempotencyKey: string, options?: CallOptions): Promise<Reply> {
    return this.streamTurn(this.agentPath(agentId), input, idempotencyKey, undefined, options);
  }

  turn(runId: string, input: TurnBody, idempotencyKey: string, options?: CallOptions): Promise<Reply> {
    return this.streamTurn(`/_run/${encodeURIComponent(runId)}`, input, idempotencyKey, runId, options);
  }

  async cancel(runId: string): Promise<void> {
    try {
      await this.call(`/_run/${encodeURIComponent(runId)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof RunError && (error.runGone || error.code === "run_not_found")) return;
      throw error;
    }
  }

  async usage(runId: string): Promise<RunUsage | null> {
    const ctrl = AbortSignal.timeout(5_000);
    try {
      const res = await this.call(`/_run/${encodeURIComponent(runId)}`, { signal: ctrl });
      return parseUsage(((await res.json()) as { usage?: unknown }).usage);
    } catch (error) {
      if (error instanceof RunError && (error.runGone || error.status === 404)) return null;
      throw error;
    }
  }

  /**
   * POST with Accept: text/event-stream. The answer streams this turn only and
   * closes after turn.completed or a terminal event. No keepalive frames come,
   * so the read has its own deadline.
   */
  private async streamTurn(
    path: string,
    input: TurnBody,
    idempotencyKey: string,
    knownRunId?: string,
    options?: CallOptions,
  ): Promise<Reply> {
    const timeoutMs = Math.min(this.config.replyTimeoutMs ?? 60_000, options?.timeoutMs ?? Infinity);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const caller = options?.signal;
    const onAbort = () => ctrl.abort();
    if (caller?.aborted) throw new RunError(499, "client_closed", "The caller closed the request.");
    caller?.addEventListener("abort", onAbort);
    const events: RunEvent[] = [];
    let runId = knownRunId ?? "";
    const body = JSON.stringify(typeof input === "string" ? { input } : input);
    try {
      const res = await this.call(path, {
        method: "POST",
        // The key carries a fingerprint of the request. A retry of the same request reuses the
        // run; a retry that differs (routing went another way, simple mode changed) gets its own
        // key instead of an idempotency_mismatch on every attempt.
        headers: { accept: "text/event-stream", "idempotency-key": `${idempotencyKey}.${fingerprint(`${path}\n${body}`)}` },
        body,
        signal: ctrl.signal,
      });
      runId = res.headers.get("x-run-id") ?? runId;
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("text/event-stream")) {
        // A JSON run object came back (202). Read the turn from the events page.
        const run = (await res.json()) as { id: string; turn: number; last_seq?: number };
        return await this.pollTurn(run.id, run.turn, 0, events, ctrl.signal, options?.stopWhen, options?.onEvent);
      }
      for await (const event of readSse(res.body!)) {
        events.push(event);
        options?.onEvent?.(event);
        runId ||= event.run_id ?? "";
        const end = endOf(event, events);
        if (end) {
          ctrl.abort();
          return toReply(runId, events, end);
        }
        if (options?.stopWhen?.(event)) {
          // Early handoff: the rest of this turn is not used, so do not wait for it.
          ctrl.abort();
          return stoppedAt(runId, events, event);
        }
        if (event.type === "message") options?.onText?.(joinText(events));
      }
      // The stream closed without an end event: page through /events.
      let turn = events.find((e) => e.type === "turn.started")?.turn ?? events.at(-1)?.turn;
      if (!runId) throw new RunError(502, "stream_closed", "The stream closed before the run id was known.");
      if (turn === undefined && knownRunId) {
        // No event of this turn came. Read the current turn number first, so the poll does
        // not return the reply of an older turn of this run.
        const current = await this.call(`/_run/${encodeURIComponent(runId)}`, { signal: ctrl.signal });
        turn = ((await current.json()) as { turn?: number }).turn;
      }
      return await this.pollTurn(runId, turn, events.at(-1)?.seq ?? 0, events, ctrl.signal, options?.stopWhen, options?.onEvent);
    } catch (error) {
      const failure = caller?.aborted
        ? new RunError(499, "client_closed", "The caller closed the request.")
        : ctrl.signal.aborted && !(error instanceof RunError)
          ? new RunError(504, "reply_timeout", "No turn end in time.")
          : error;
      if (failure instanceof RunError && runId) failure.runId ??= runId;
      throw failure;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    }
  }

  private async pollTurn(
    runId: string,
    turn: number | undefined,
    afterSeq: number,
    seen: RunEvent[],
    signal: AbortSignal,
    stopWhen?: (event: RunEvent) => boolean,
    onEvent?: (event: RunEvent) => void,
  ): Promise<Reply> {
    const events = [...seen];
    let after = afterSeq;
    let currentTurn = turn;
    while (!signal.aborted) {
      const res = await this.call(`/_run/${encodeURIComponent(runId)}/events?after_seq=${after}&limit=200`, { signal });
      const page = ((await res.json()) as { events: RunEvent[] }).events ?? [];
      for (const event of page) {
        after = event.seq;
        if (event.type === "turn.started" && currentTurn === undefined) currentTurn = event.turn;
        if (currentTurn !== undefined && event.turn !== undefined && event.turn < currentTurn) continue;
        events.push(event);
        onEvent?.(event);
        const end = endOf(event, events, currentTurn);
        if (end) return toReply(runId, events, end);
        if (stopWhen?.(event)) return stoppedAt(runId, events, event);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new RunError(504, "reply_timeout", "No turn end in time.");
  }
}

function endOf(event: RunEvent, events: RunEvent[], turn?: number): RunStatus | undefined {
  const terminal = TERMINAL[event.type];
  if (terminal) return terminal;
  if (event.type !== "turn.completed") return undefined;
  const expected = turn ?? events.find((e) => e.type === "turn.started")?.turn;
  return expected === undefined || event.turn === expected ? "waiting" : undefined;
}

function toReply(runId: string, events: RunEvent[], status: RunStatus): Reply {
  const reply: Reply = { runId, text: "", status, lastSeq: events.at(-1)?.seq ?? 0 };
  for (const e of events) {
    if (e.type === "run.started" && typeof e.data.model === "string") reply.model = e.data.model;
    if (e.type === "event.handoff") reply.handoff ??= e.data as { to: string; reason: string };
    if (e.type === "event.switch_language") reply.switchLanguage ??= e.data as { to: string };
    if (e.type === "run.failed") reply.failure = e.data as { code: string; message: string };
    if (e.type === "question" && typeof e.data.question_id === "string") reply.question = e.data as unknown as RunQuestion;
  }
  reply.text = joinText(events);
  return reply;
}

/** A reply cut at the event that stopWhen picked. That event is the handoff the caller follows. */
function stoppedAt(runId: string, events: RunEvent[], event: RunEvent): Reply {
  const reply = toReply(runId, events, "waiting");
  if (event.type === "event.handoff") reply.handoff = event.data as { to: string; reason: string };
  if (event.type === "event.switch_language") reply.switchLanguage = event.data as { to: string };
  return { ...reply, stoppedEarly: true };
}

/**
 * The reply text of a list of events: message texts, then a string result. A question goes in
 * `reply.question`, except a question with no id, which is plain reply text.
 */
function joinText(events: RunEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.type === "message") parts.push(String(e.data.text ?? ""));
    if (e.type === "question" && typeof e.data.question_id !== "string") parts.push(String(e.data.text ?? ""));
    if (e.type === "run.completed" && typeof e.data.result === "string") parts.push(e.data.result);
  }
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Parses an SSE body into Run events. Frames without a data line are skipped. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replaceAll("\r\n", "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as RunEvent;
        } catch {
          // A bad frame is skipped; the turn end or the timeout still applies.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** FNV-1a 32-bit of a string, in base 36: a short, stable fingerprint (not a security hash). */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
