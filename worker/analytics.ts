// Workers Analytics Engine data points: the cost of each turn (COSTS, dataset agent_sante_costs)
// and the use of the agents (USAGE, dataset agent_sante_usage). The schemas are in the README,
// section "Analytics and costs". Rules: no text, no IP, no postal code, no session id in clear.
// The index is a hash of the random session id. A failed write never fails a request.
import type { Lang } from "../shared/api";
import { latencyBucket, topicOf, turnsBucket, type CallHow, type RouteKind, type TurnCost } from "./costs";

/** The part of the Analytics Engine binding that this file uses. */
export interface DataPointWriter {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/** Event kinds of the usage dataset that are not an agent call. */
export type UsageEvent =
  | "pii_block"
  | "medical_rewrite"
  | "ended_medical_advice"
  | "ended_too_long"
  | "ended_by_person"
  | "voice"
  | "question";

/** An opaque per-session key: the first 32 hex characters of SHA-256("agent-sante:" + sid). */
export async function sessionKey(sid: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`agent-sante:${sid}`));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Doubles of a cost point, in this order. */
export const COST_DOUBLES = [
  "turn",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "model_cost_usd",
  "run_credits",
  "run_fee_usd",
  "ms_calls",
  "ms_cost_usd",
  "transcription_seconds",
  "transcription_cost_usd",
  "translation_tokens",
  "translation_cost_usd",
  "total_usd",
  "turn_ms",
] as const satisfies readonly (keyof TurnCost)[];

/** Agent ids are catalog ids; anything else becomes "unknown", so no free text reaches a blob. */
const SAFE_ID = /^[a-z0-9][a-z0-9/._:-]{0,99}$/;
const safe = (value: string | undefined): string => (value && SAFE_ID.test(value) ? value : "unknown");

export interface CostPoint {
  key: string;
  agent: string;
  lang: Lang;
  model: string | undefined;
  route: RouteKind;
  cost: TurnCost;
}

export interface UsagePoint {
  key: string;
  agent: string;
  lang: Lang;
  /** An agent call (`how`) or an event. */
  how: CallHow | UsageEvent;
  turn: number;
  /** Duration of the agent call. Absent for an event. */
  ms?: number;
}

export class Analytics {
  constructor(
    private readonly costs?: DataPointWriter,
    private readonly usage?: DataPointWriter,
    private readonly onError: () => void = () => {},
  ) {}

  /** blobs: agent, lang, model, route. doubles: COST_DOUBLES. */
  cost(p: CostPoint): void {
    this.write(this.costs, {
      indexes: [p.key],
      blobs: [safe(p.agent), p.lang, safe(p.model), p.route],
      doubles: COST_DOUBLES.map((k) => round(p.cost[k])),
    });
  }

  /** blobs: agent, topic, lang, how, turns bucket, latency bucket. doubles: [1]. */
  use(p: UsagePoint): void {
    this.write(this.usage, {
      indexes: [p.key],
      blobs: [
        safe(p.agent),
        p.agent ? topicOf(p.agent) : "none",
        p.lang,
        p.how,
        turnsBucket(p.turn),
        p.ms === undefined ? "none" : latencyBucket(p.ms),
      ],
      doubles: [1],
    });
  }

  private write(target: DataPointWriter | undefined, point: { indexes: string[]; blobs: string[]; doubles: number[] }): void {
    if (!target) return;
    try {
      target.writeDataPoint(point);
    } catch {
      this.onError();
    }
  }
}

/** 10 significant decimals: enough for micro-dollar costs, and no float noise in sums. */
const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 1e10) / 1e10 : 0);

/** A fake binding for tests and local development: it keeps the points in memory. */
export function memoryDataset(): DataPointWriter & { points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] } {
  const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  return {
    points,
    writeDataPoint(point) {
      points.push(structuredClone(point));
    },
  };
}
