// Cost of each chat turn: prices, the Run usage delta per run, and the cost math.
// Numbers only: this file never sees message text, and the data it builds has no personal data.
// Sources of each price: README "Analytics and costs".

/** Prices in USD. */
export const PRICES = {
  /** One CloudRaker Run platform credit. */
  runCreditUsd: 0.001,
  /** milliseconds decision-machine-1 and rakeaudio: USD per million billed input tokens. Output is free. */
  msPerMillionTokens: 0.04,
  /** rakeaudio without speakers: USD 0.10 per audio hour (2,500,000 tokens at USD 0.04 per million). */
  transcriptionPerHour: 0.1,
  /** Workers AI @cf/meta/llama-3.3-70b-instruct-fp8-fast, USD per million tokens. */
  translationInputPerMillion: 0.293,
  translationOutputPerMillion: 2.253,
} as const;

/**
 * Mean billed tokens of one milliseconds call (entities: about 430, yes-no hint pair: about 380).
 * Used only when a call gave no x-input-tokens header.
 */
export const MS_AVERAGE_TOKENS = 400;

/** The usage fields of a Run run object (GET /_run/{id}). All totals are cumulative over the run. */
export interface RunUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  /** Raw provider cost (AI Gateway), not credits. */
  model_cost_usd: number;
  /** Run platform credits (run minutes, knowledge searches). USD 0.001 each. */
  credits: number;
}

export const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "model_cost_usd",
  "credits",
] as const satisfies readonly (keyof RunUsage)[];

export const zeroUsage = (): RunUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  model_cost_usd: 0,
  credits: 0,
});

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Reads the usage object of a Run run object. Missing or bad fields count as 0. */
export function parseUsage(value: unknown): RunUsage {
  const u = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const out = zeroUsage();
  for (const k of USAGE_FIELDS) out[k] = finite(u[k]);
  return out;
}

/**
 * The part of `now` that is new since `seen`, per field, never below 0. A late read with
 * smaller totals gives 0, and the next read gives the rest.
 */
export function usageDelta(now: RunUsage, seen: RunUsage | undefined): RunUsage {
  const out = zeroUsage();
  for (const k of USAGE_FIELDS) out[k] = Math.max(0, now[k] - (seen?.[k] ?? 0));
  return out;
}

/** The larger value of each field. The guard keeps this, so the totals only grow. */
export function usageMax(a: RunUsage | undefined, b: RunUsage): RunUsage {
  const out = zeroUsage();
  for (const k of USAGE_FIELDS) out[k] = Math.max(a?.[k] ?? 0, b[k]);
  return out;
}

export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  const out = zeroUsage();
  for (const k of USAGE_FIELDS) out[k] = a[k] + b[k];
  return out;
}

/** How the turn reached its agent. "voice": a voice message (transcription only). "end": the last read at /api/end. */
export type RouteKind = "direct" | "concierge" | "handoff" | "answer" | "turn" | "blocked" | "voice" | "end";

/** How one agent call came (usage dataset). */
export type CallHow = "direct" | "concierge" | "handoff" | "answer" | "turn" | "language" | "rewrite";

/**
 * Collects what one request uses: the runs it touched, the agent calls, the milliseconds calls
 * and the translations. Counts and ids only.
 */
export class TurnMeter {
  /** Run ids touched by this request, with the model from run.started when the stream had it. */
  readonly runs = new Map<string, string | undefined>();
  readonly calls: { agent: string; how: CallHow; ms: number }[] = [];
  msCalls = 0;
  /** Calls that gave x-input-tokens, and the sum of those tokens. */
  msTokenCalls = 0;
  msTokens = 0;
  translation = { input: 0, output: 0, estimated: false };
  route: RouteKind = "turn";
  agent = "";
  question = false;

  run(runId: string | undefined, model?: string): void {
    if (!runId) return;
    if (model || !this.runs.has(runId)) this.runs.set(runId, model ?? this.runs.get(runId));
  }

  msResponse(inputTokens: number | undefined): void {
    if (inputTokens === undefined || !Number.isFinite(inputTokens)) return;
    this.msTokenCalls++;
    this.msTokens += Math.max(0, inputTokens);
  }

  addTranslation(input: number, output: number, estimated: boolean): void {
    this.translation.input += Math.max(0, input);
    this.translation.output += Math.max(0, output);
    if (estimated) this.translation.estimated = true;
  }
}

/** The cost of one turn. Field order = the doubles of the cost data point (worker/analytics.ts). */
export interface TurnCost {
  turn: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model_cost_usd: number;
  run_credits: number;
  run_fee_usd: number;
  ms_calls: number;
  ms_cost_usd: number;
  transcription_seconds: number;
  transcription_cost_usd: number;
  translation_tokens: number;
  translation_cost_usd: number;
  total_usd: number;
  turn_ms: number;
}

export interface CostInput {
  turn: number;
  /** Run usage of this turn (the sum of the deltas of all runs it touched). */
  run?: RunUsage;
  msCalls?: number;
  msTokenCalls?: number;
  msTokens?: number;
  transcriptionSeconds?: number;
  /** Billed rakeaudio tokens (x-input-tokens), when the header came. */
  transcriptionTokens?: number;
  translationInput?: number;
  translationOutput?: number;
  turnMs: number;
}

/** The cost math. ms_cost uses the billed tokens, and the measured mean for a call with no header. */
export function turnCost(c: CostInput): TurnCost {
  const run = c.run ?? zeroUsage();
  const msCalls = c.msCalls ?? 0;
  const missing = Math.max(0, msCalls - (c.msTokenCalls ?? 0));
  const msTokens = (c.msTokens ?? 0) + missing * MS_AVERAGE_TOKENS;
  const ms = (msTokens / 1e6) * PRICES.msPerMillionTokens;
  const seconds = c.transcriptionSeconds ?? 0;
  const transcription =
    c.transcriptionTokens !== undefined
      ? (c.transcriptionTokens / 1e6) * PRICES.msPerMillionTokens
      : (seconds / 3600) * PRICES.transcriptionPerHour;
  const tIn = c.translationInput ?? 0;
  const tOut = c.translationOutput ?? 0;
  const translation = (tIn / 1e6) * PRICES.translationInputPerMillion + (tOut / 1e6) * PRICES.translationOutputPerMillion;
  const fee = run.credits * PRICES.runCreditUsd;
  return {
    turn: c.turn,
    input_tokens: run.input_tokens,
    cached_input_tokens: run.cached_input_tokens,
    output_tokens: run.output_tokens,
    reasoning_tokens: run.reasoning_tokens,
    model_cost_usd: run.model_cost_usd,
    run_credits: run.credits,
    run_fee_usd: fee,
    ms_calls: msCalls,
    ms_cost_usd: ms,
    transcription_seconds: seconds,
    transcription_cost_usd: transcription,
    translation_tokens: tIn + tOut,
    translation_cost_usd: translation,
    total_usd: run.model_cost_usd + fee + ms + transcription + translation,
    turn_ms: c.turnMs,
  };
}

/** Rough token count of a text for a Workers AI answer with no usage field (about 4 characters a token). */
export const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 4);

/** Big topic of each agent, by the English agent id segment. Both languages share a topic. */
const TOPICS: Record<string, string> = {
  concierge: "orientation",
  "access-to-care": "access-to-care",
  flu: "flu",
  gastro: "gastro",
  "viruses-vaccines": "vaccination",
  seniors: "seniors",
  "mental-health": "mental-health",
  "pregnancy-children": "pregnancy-children",
  "illness-medication": "illness-medication",
  // The drug agents count with illnesses and medications: the topic list stays the same.
  medications: "illness-medication",
  "prevention-environment": "prevention",
  "sexual-health": "sexual-health",
};

/** French agent id segment to its English counterpart. */
const FR_TO_EN: Record<string, string> = {
  concierge: "concierge",
  "acces-services": "access-to-care",
  grippe: "flu",
  gastro: "gastro",
  "virus-vaccins": "viruses-vaccines",
  aines: "seniors",
  "sante-mentale": "mental-health",
  "grossesse-enfants": "pregnancy-children",
  "maladies-medicaments": "illness-medication",
  medicaments: "medications",
  "prevention-environnement": "prevention-environment",
  "sante-sexuelle": "sexual-health",
};

export const TOPIC_LIST = [...new Set(Object.values(TOPICS))];

export function topicOf(agentId: string): string {
  const [lang, segment = ""] = agentId.split("/");
  const en = lang === "fr" ? FR_TO_EN[segment] : segment;
  return (en && TOPICS[en]) || "other";
}

/** Turns bucket of the conversation: 1, 2-3, 4-6, 7+. */
export function turnsBucket(turn: number): string {
  if (turn <= 1) return "1";
  if (turn <= 3) return "2-3";
  if (turn <= 6) return "4-6";
  return "7+";
}

/** Latency bucket of one agent call: <5s, 5-10s, 10-20s, 20s+. */
export function latencyBucket(ms: number): string {
  if (ms < 5_000) return "<5s";
  if (ms < 10_000) return "5-10s";
  if (ms < 20_000) return "10-20s";
  return "20s+";
}
