// Session guard rules shared by the Durable Object and the in-memory test version.
import { usageDelta, usageMax, type RunUsage } from "./costs";

/** "ok" gives the id of the new flight. Only that flight can commit or abort it. */
export type BeginResult = { status: "ok"; flight: string } | { status: "busy" } | { status: "stale" };

/** "lost": another flight owns the session now (the lease ran out). "ended": the session ended in flight. */
export type CommitResult = "ok" | "ended" | "lost";

/** The guard calls the routes need. Tests use an in-memory version. */
export interface Guard {
  init(sid: string, jti: string): Promise<void>;
  begin(sid: string, jti: string): Promise<BeginResult>;
  /**
   * Accepts the new token id and run id, and releases the flight. Only the flight that owns
   * the lease can commit. On "ended" or "lost" the caller cancels the run that it started.
   */
  commit(sid: string, flight: string, jti: string, run: string): Promise<CommitResult>;
  /** Releases the flight when it still owns the lease, and keeps the current token valid. */
  abort(sid: string, flight: string): Promise<void>;
  /**
   * Forgets the session. Any valid token of the session can end it, also an older one (a tab
   * closed while a turn committed). Returns the run id that the guard stored, never a run id
   * from the token. Returns null when the session is not known.
   */
  end(sid: string): Promise<{ run: string } | null>;
  /** True when the session is known and `jti` is its current token (the conversation has not ended). */
  live(sid: string, jti: string): Promise<boolean>;
  /**
   * Run usage is cumulative per run. Takes the totals read now for each run, returns the part
   * that no earlier call returned, and keeps the larger totals. The snapshots stay after `end`
   * (until the idle alarm), so the last read of an ended conversation still gives a delta.
   */
  settle(sid: string, reads: UsageRead[]): Promise<UsageDelta[]>;
}

export interface UsageRead {
  run: string;
  usage: RunUsage;
  /** Model from run.started, when this request saw it. */
  model?: string;
}

export interface UsageDelta {
  run: string;
  delta: RunUsage;
  /** Model of the run: from this read, else the one stored at an earlier read. */
  model?: string;
}

/** Usage snapshots of a session, by run id. Ids and numbers only. */
export type UsageState = Record<string, { u: RunUsage; m?: string; t: number }>;

/** A session keeps the snapshots of its last runs only. */
const MAX_RUNS = 12;

export function settleUsage(state: UsageState | undefined, reads: UsageRead[], now: number): { deltas: UsageDelta[]; next: UsageState } {
  const next: UsageState = { ...state };
  const deltas: UsageDelta[] = [];
  for (const r of reads) {
    const seen = next[r.run];
    const model = r.model ?? seen?.m;
    deltas.push({ run: r.run, delta: usageDelta(r.usage, seen?.u), ...(model ? { model } : {}) });
    next[r.run] = { u: usageMax(seen?.u, r.usage), ...(model ? { m: model } : {}), t: now };
  }
  const keys = Object.keys(next).toSorted((a, b) => next[b]!.t - next[a]!.t);
  for (const k of keys.slice(MAX_RUNS)) delete next[k];
  return { deltas, next };
}

export interface State {
  jti: string;
  /** Epoch ms until the current flight lease ends, 0 when idle. */
  lease: number;
  /** Id of the flight that owns the lease, empty when idle. */
  flight?: string;
  /** The run id of the latest committed turn, empty before the first turn. */
  run?: string;
}

/**
 * Time budget of one /api/chat request for all its Run calls (pipeline.ts). The pipeline
 * stops with reply_timeout when the budget ends.
 */
export const TURN_BUDGET_MS = 150_000;
/**
 * The lease ends a stuck flight. It is longer than TURN_BUDGET_MS plus the milliseconds
 * checks (3 s timeout each, a few per turn), so a live flight never loses its lease.
 */
export const LEASE_MS = 240_000;
/** The guard forgets a session this long after its last use. */
export const IDLE_MS = 15 * 60_000;

export function flightId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The rules, on one state value. The Durable Object and the memory guard both use them. */
export const rules = {
  begin(s: State | undefined, jti: string, now: number): { result: BeginResult; next?: State } {
    if (!s || s.jti !== jti) return { result: { status: "stale" } };
    if (s.lease > now) return { result: { status: "busy" } };
    const flight = flightId();
    return { result: { status: "ok", flight }, next: { ...s, lease: now + LEASE_MS, flight } };
  },
  commit(s: State | undefined, flight: string, jti: string, run: string): { result: CommitResult; next?: State } {
    if (!s) return { result: "ended" };
    if (s.flight !== flight) return { result: "lost" };
    return { result: "ok", next: { jti, lease: 0, flight: "", run } };
  },
  abort(s: State | undefined, flight: string): State | undefined {
    if (!s || s.flight !== flight) return undefined;
    return { ...s, lease: 0, flight: "" };
  },
};

/** In-memory guard for tests. Same rules as the Durable Object. */
export function memoryGuard(now: () => number = Date.now): Guard & { size(): number } {
  const map = new Map<string, State>();
  const usage = new Map<string, UsageState>();
  return {
    size: () => map.size,
    async init(sid, jti) {
      map.set(sid, { jti, lease: 0, flight: "", run: "" });
    },
    async begin(sid, jti) {
      const { result, next } = rules.begin(map.get(sid), jti, now());
      if (next) map.set(sid, next);
      return result;
    },
    async commit(sid, flight, jti, run) {
      const { result, next } = rules.commit(map.get(sid), flight, jti, run);
      if (next) map.set(sid, next);
      return result;
    },
    async abort(sid, flight) {
      const next = rules.abort(map.get(sid), flight);
      if (next) map.set(sid, next);
    },
    async live(sid, jti) {
      return map.get(sid)?.jti === jti;
    },
    async end(sid) {
      const s = map.get(sid);
      if (!s) return null;
      map.delete(sid);
      return { run: s.run ?? "" };
    },
    async settle(sid, reads) {
      const { deltas, next } = settleUsage(usage.get(sid), reads, now());
      usage.set(sid, next);
      return deltas;
    },
  };
}
