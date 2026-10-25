// The activity steps of one turn in the browser: the Worker sends step updates by id while the
// turn runs. Times are the Worker's milliseconds since the request started.
import type { Activity, ActivityKind, ActivityParams, ActivityState } from "@shared/activity";

export interface ActivityStep {
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  params: ActivityParams;
  /** Worker time of the first update. */
  start: number;
  /** Worker time of the update that ended the step. */
  end?: number;
}

/** The steps of a checked reply, for the compact summary under it. */
export interface TurnActivity {
  steps: ActivityStep[];
  /** Time from send to reply, measured in the browser. */
  totalMs: number;
}

/** Adds or updates one step. A later update keeps the params that it does not repeat. */
export function applyActivity(steps: ActivityStep[], a: Activity): ActivityStep[] {
  const i = steps.findIndex((s) => s.id === a.id);
  const ended = a.state === "running" ? undefined : a.t;
  if (i === -1) return [...steps, { id: a.id, kind: a.kind, state: a.state, params: { ...a.params }, start: a.t, end: ended }];
  const prev = steps[i]!;
  const next: ActivityStep = { ...prev, state: a.state, params: { ...prev.params, ...a.params }, end: ended ?? prev.end };
  return steps.map((s, k) => (k === i ? next : s));
}

/** Closes the steps that still run when the reply is in (the Worker closes them, this is a guard). */
export function settleSteps(steps: ActivityStep[]): ActivityStep[] {
  const last = Math.max(0, ...steps.map((s) => s.end ?? s.start));
  return steps.map((s) => (s.state === "running" ? { ...s, state: "done", end: last } : s));
}

/** Steps that count in the summary: a heartbeat is not a step of its own. */
export const countedSteps = (steps: ActivityStep[]) => steps.filter((s) => s.kind !== "waiting" && s.kind !== "agent_status");

/** The latest agent status line, when it is the newest step: the polite live region reads it. */
export function latestStatus(steps: ActivityStep[]): string | undefined {
  const last = steps.at(-1);
  return last?.kind === "agent_status" ? last.params.text : undefined;
}

/**
 * The coarse phase for the screen reader summary. It changes about three times per turn
 * (message check, agent work, reply check), not at every step.
 */
export function livePhase(steps: ActivityStep[]): "checking" | "working" | "reviewing" {
  const running = steps.filter((s) => s.state === "running");
  const current = running.at(-1) ?? steps.at(-1);
  if (!current || current.kind === "privacy") return "checking";
  if (current.kind === "safety" || current.kind === "rewrite") return "reviewing";
  return "working";
}
