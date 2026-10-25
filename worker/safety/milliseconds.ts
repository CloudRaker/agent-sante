// milliseconds decision-machine-1 client (plain fetch, no SDK) and the two checks.
// Both checks fail closed.
import type { PiiKind } from "../../shared/api";
import { MED_HINT, MED_THRESHOLD, PII_THRESHOLD, PII_TYPES, keepPiiSpan, regexPii, type EntitySpan, type Hint } from "./checks";

/** The model side of the checks. The fake upstream and the tests replace it. */
export interface DecisionModel {
  entities(text: string, types: Record<string, string>): Promise<EntitySpan[]>;
  /** yes-no with one statement and a when_true/when_false pair. Returns the normalized probability. */
  yesNoHint(text: string, hint: Hint): Promise<number>;
  /**
   * classify over described labels. Used only to route the first message, never as a safety
   * check. Absent means no direct routing (the concierge answers first).
   */
  classify?(text: string, labels: Record<string, string>, question?: string): Promise<{ label: string; probability: number; second?: number }>;
}

export class SafetyUnavailable extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`milliseconds ${status} ${code}`);
  }
}

/** Metadata of one milliseconds call, for the logs. Never the text. */
export interface CallMeta {
  path: string;
  status: number;
  attempt: number;
  ms: number;
  inputTokens?: number;
  inferenceMs?: number;
}

const num = (value: string | null) => (value && Number.isFinite(Number(value)) ? Number(value) : undefined);

export class Milliseconds implements DecisionModel {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.milliseconds.ai/v1/decision-machine-1",
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly onCall: (meta: CallMeta) => void = () => {},
    /** Timeout of one attempt. */
    private readonly timeoutMs = 3000,
    /** classify (routing only) gets one short attempt: a slow answer must not delay the turn. */
    private readonly classifyTimeoutMs = 1200,
  ) {}

  private async call<T>(path: string, body: unknown, attempts = 2, timeoutMs = this.timeoutMs): Promise<T> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      let res: Response;
      const started = Date.now();
      try {
        res = await this.fetcher(`${this.baseUrl}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        this.onCall({ path, status: timeout ? -1 : 0, attempt, ms: Date.now() - started });
        if (attempt + 1 < attempts) continue;
        throw new SafetyUnavailable(0, timeout ? "timeout" : "network");
      }
      this.onCall({
        path,
        status: res.status,
        attempt,
        ms: Date.now() - started,
        inputTokens: num(res.headers.get("x-input-tokens")),
        inferenceMs: num(res.headers.get("x-inference-ms")),
      });
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          throw new SafetyUnavailable(res.status, "bad_json");
        }
      }
      const retryable = res.status === 429 || res.status === 529 || res.status >= 502;
      if (attempt + 1 < attempts && retryable) {
        const after = Number(res.headers.get("retry-after") ?? "");
        // Retry once after retry-after only when it is 2 s or less, else fail closed.
        if (res.status === 429 && after > 2) throw new SafetyUnavailable(429, "rate_limit_exceeded");
        await new Promise((r) => setTimeout(r, res.status === 429 && after > 0 ? after * 1000 : 300));
        continue;
      }
      const code = ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;
      throw new SafetyUnavailable(res.status, code ?? `http_${res.status}`);
    }
    throw new SafetyUnavailable(0, "retries_exhausted");
  }

  async entities(text: string, types: Record<string, string>): Promise<EntitySpan[]> {
    const out = await this.call<{ entities?: EntitySpan[] }>("entities", { text, types });
    return Array.isArray(out.entities) ? out.entities : [];
  }

  async yesNoHint(text: string, hint: Hint): Promise<number> {
    const out = await this.call<{ probability?: unknown }>("yes-no", { text, ...hint });
    if (typeof out.probability !== "number" || Number.isNaN(out.probability)) throw new SafetyUnavailable(200, "bad_shape");
    return out.probability;
  }

  async classify(
    text: string,
    labels: Record<string, string>,
    question?: string,
  ): Promise<{ label: string; probability: number; second?: number }> {
    const out = await this.call<{ label?: unknown; probability?: unknown; scores?: unknown }>(
      "classify",
      { text, labels, ...(question ? { question } : {}) },
      1,
      this.classifyTimeoutMs,
    );
    if (typeof out.label !== "string" || typeof out.probability !== "number" || Number.isNaN(out.probability)) {
      throw new SafetyUnavailable(200, "bad_shape");
    }
    // The best score of the other labels, for the margin rule of the router.
    const label = out.label;
    const others = out.scores && typeof out.scores === "object" ? Object.entries(out.scores as Record<string, unknown>) : [];
    const rest = others.filter(([k, v]) => k !== label && typeof v === "number" && !Number.isNaN(v)).map(([, v]) => v as number);
    return { label, probability: out.probability, ...(rest.length ? { second: Math.max(...rest) } : {}) };
  }
}

/** Result of check A. Scores and span types only, so it can be logged. */
export interface PiiResult {
  kinds: PiiKind[];
  /** "regex" when the Worker layer blocked the message before any network call. */
  layer: "regex" | "model";
  /** Highest probability of a span that passed the post-filter, 0 when none. */
  score: number;
  kept: string[];
  dropped: string[];
}

/** Check A. kinds [] means the message may go to the model. Throws when milliseconds fails (fail closed). */
export async function piiCheck(model: DecisionModel, text: string): Promise<PiiResult> {
  const found = regexPii(text);
  // The regex layer runs first: structured identifiers never reach a network hop.
  if (found.length) return { kinds: found, layer: "regex", score: 1, kept: found, dropped: [] };
  const kinds = new Set<PiiKind>();
  const kept: string[] = [];
  const dropped: string[] = [];
  let score = 0;
  for (const span of await model.entities(text, PII_TYPES)) {
    if (span.type in PII_TYPES && keepPiiSpan(span, text)) {
      if (span.probability >= PII_THRESHOLD) {
        kinds.add(span.type as PiiKind);
        kept.push(span.type);
      } else dropped.push(`${span.type}:low`);
      score = Math.max(score, span.probability);
    } else dropped.push(span.type);
  }
  return { kinds: [...kinds], layer: "model", score, kept, dropped };
}

/** Check A, kinds only. */
export async function piiKinds(model: DecisionModel, text: string): Promise<PiiKind[]> {
  return (await piiCheck(model, text)).kinds;
}

/** Check B. Flagged when the reply gives personal medical advice and must go back to the agent. */
export async function hasAdvice(model: DecisionModel, reply: string): Promise<{ flagged: boolean; score: number }> {
  const score = await model.yesNoHint(reply, MED_HINT);
  return { flagged: score >= MED_THRESHOLD, score };
}
