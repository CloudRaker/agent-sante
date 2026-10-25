// Aggregate counters, the daily turn cap and the error-rate alert rule.
// One Durable Object holds them (worker/stats.ts). It stores counts only: no text, no ids, no IP.
// The same logic runs on an in-memory store in the tests.
import {
  COST_CATEGORIES,
  COUNTERS,
  LATENCY_BUCKETS,
  TOPICS,
  TURNS_BUCKETS,
  type CostCategory,
  type CostSums,
  type Counter,
  type LatencyBucket,
  type StatsResponse,
  type Topic,
  type TurnsBucket,
  type UsageSummary,
} from "../shared/api";
import { daysBefore } from "./time";

export interface KeyStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

export type AlertAction = "fire" | "resolve" | null;

export interface RecordInput {
  day: string;
  counts?: Partial<Record<Counter, number>>;
  /** Cost of one turn (or one voice message), added to the sums of the day. USD and counts only. */
  costs?: { usd: Partial<Record<CostCategory, number>>; conversations?: number; turns?: number };
  /** Usage counts of one message, written with its USAGE data points. Counts only. */
  usage?: UsageInput;
  /** HTTP status of an API request, for the error-rate rule. */
  status?: number;
  nowMs: number;
}

/** Usage counts of one message. Unknown keys are dropped, so no free text is stored. */
export interface UsageInput {
  /** Agent calls by agent id (catalog id, "fr/grippe"). */
  agents?: Record<string, number>;
  /** Agent calls by big topic. */
  topics?: Partial<Record<Topic, number>>;
  /**
   * Conversations that reached the first message of a length bucket: "1" at the first reply,
   * "2-3" at the second, "4-6" at the fourth, "7+" at the seventh.
   */
  reached?: Partial<Record<TurnsBucket, number>>;
  /** Replies by response time. */
  latency?: Partial<Record<LatencyBucket, number>>;
}

/** Usage counts of one Québec day (key `u:<day>`). */
interface UsageDay {
  calls: number;
  agents: Record<string, number>;
  topics: Record<Topic, number>;
  reached: Record<TurnsBucket, number>;
  latency: Record<LatencyBucket, number>;
}

/** Agent ids are catalog ids. At most MAX_AGENTS ids per day, so the stored object stays small. */
const AGENT_ID = /^(fr|en)\/[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_AGENTS = 64;
/** Days in the conversations chart, and in "top topics this week". */
export const CHART_DAYS = 14;
export const WEEK_DAYS = 7;

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const emptyUsageDay = (): UsageDay => ({ calls: 0, agents: {}, topics: zeros(TOPICS), reached: zeros(TURNS_BUCKETS), latency: zeros(LATENCY_BUCKETS) });
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function addKnown<K extends string>(into: Record<K, number>, keys: readonly K[], add: Partial<Record<string, number>> | undefined): void {
  if (!add) return;
  for (const [k, n] of Object.entries(add)) if ((keys as readonly string[]).includes(k)) into[k as K] = (into[k as K] ?? 0) + count(n);
}

function addUsage(day: UsageDay, add: UsageInput): void {
  for (const [id, n] of Object.entries(add.agents ?? {})) {
    if (!AGENT_ID.test(id) || count(n) === 0) continue;
    if (!(id in day.agents) && Object.keys(day.agents).length >= MAX_AGENTS) continue;
    day.agents[id] = (day.agents[id] ?? 0) + count(n);
    day.calls += count(n);
  }
  addKnown(day.topics, TOPICS, add.topics);
  addKnown(day.reached, TURNS_BUCKETS, add.reached);
  addKnown(day.latency, LATENCY_BUCKETS, add.latency);
}

/** Conversations by length from the "reached" counts: reached "1" minus reached "2-3", and so on. */
export function lengths(reached: Record<TurnsBucket, number>): Record<TurnsBucket, number> {
  const out = zeros(TURNS_BUCKETS);
  TURNS_BUCKETS.forEach((b, i) => {
    const next = TURNS_BUCKETS[i + 1];
    out[b] = Math.max(0, reached[b] - (next ? reached[next] : 0));
  });
  return out;
}

/** Error-rate rule: over the last 5 minutes, at least 10 server errors and 25 % of requests. */
export const ALERT = { windowMinutes: 5, minErrors: 10, minRatio: 0.25, resolveRatio: 0.05, cooldownMs: 30 * 60_000 } as const;

type Window = Record<string, { t: number; e: number }>;
interface AlertState {
  firing: boolean;
  lastFired: number;
}

const empty = (): Record<Counter, number> => Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<Counter, number>;
export const emptyCosts = (): CostSums => ({
  usd: Object.fromEntries(COST_CATEGORIES.map((c) => [c, 0])) as Record<CostCategory, number>,
  conversations: 0,
  turns: 0,
});
const positive = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
/** Sums keep 10 decimals: micro-dollar costs, no float noise. */
const fix = (n: number) => Math.round(n * 1e10) / 1e10;
function addCosts(into: CostSums, add: { usd: Partial<Record<CostCategory, number>>; conversations?: number; turns?: number }): void {
  for (const c of COST_CATEGORIES) into.usd[c] = fix((into.usd[c] ?? 0) + positive(add.usd[c]));
  into.conversations += Math.floor(positive(add.conversations));
  into.turns += Math.floor(positive(add.turns));
}

export class StatsCore {
  constructor(private readonly store: KeyStore) {}

  /** Takes one turn from the daily cap. cap <= 0 means no cap. */
  async take(day: string, cap: number): Promise<{ ok: boolean; used: number }> {
    const used = (await this.store.get<number>(`turns:${day}`)) ?? 0;
    if (cap > 0 && used >= cap) return { ok: false, used };
    await this.store.put(`turns:${day}`, used + 1);
    return { ok: true, used: used + 1 };
  }

  async atCapacity(day: string, cap: number): Promise<boolean> {
    return cap > 0 && ((await this.store.get<number>(`turns:${day}`)) ?? 0) >= cap;
  }

  async record(input: RecordInput): Promise<AlertAction> {
    if (input.counts && Object.values(input.counts).some((n) => n)) {
      const counts = (await this.store.get<Record<Counter, number>>(`c:${input.day}`)) ?? empty();
      for (const [k, n] of Object.entries(input.counts)) {
        if (COUNTERS.includes(k as Counter) && Number.isFinite(n) && n! > 0) counts[k as Counter] += Math.floor(n!);
      }
      await this.store.put(`c:${input.day}`, counts);
    }
    if (input.costs) {
      const sums = (await this.store.get<CostSums>(`k:${input.day}`)) ?? emptyCosts();
      addCosts(sums, input.costs);
      await this.store.put(`k:${input.day}`, sums);
    }
    if (input.usage) {
      const day = (await this.store.get<UsageDay>(`u:${input.day}`)) ?? emptyUsageDay();
      addUsage(day, input.usage);
      await this.store.put(`u:${input.day}`, day);
    }
    if (input.status === undefined) return null;
    return this.track(input.status, input.nowMs);
  }

  private async track(status: number, nowMs: number): Promise<AlertAction> {
    const minute = Math.floor(nowMs / 60_000);
    const window = (await this.store.get<Window>("w")) ?? {};
    for (const k of Object.keys(window)) if (Number(k) <= minute - ALERT.windowMinutes) delete window[k];
    const bucket = (window[minute] ??= { t: 0, e: 0 });
    bucket.t++;
    if (status >= 500) bucket.e++;
    await this.store.put("w", window);
    let t = 0;
    let e = 0;
    for (const b of Object.values(window)) {
      t += b.t;
      e += b.e;
    }
    const alert = (await this.store.get<AlertState>("a")) ?? { firing: false, lastFired: 0 };
    if (!alert.firing && e >= ALERT.minErrors && e / t >= ALERT.minRatio && nowMs - alert.lastFired >= ALERT.cooldownMs) {
      await this.store.put<AlertState>("a", { firing: true, lastFired: nowMs });
      return "fire";
    }
    if (alert.firing && t >= 10 && e / t < ALERT.resolveRatio) {
      await this.store.put<AlertState>("a", { ...alert, firing: false });
      return "resolve";
    }
    return null;
  }

  async window(): Promise<{ total: number; errors: number }> {
    const window = (await this.store.get<Window>("w")) ?? {};
    return Object.values(window).reduce((a, b) => ({ total: a.total + b.t, errors: a.errors + b.e }), { total: 0, errors: 0 });
  }

  /** Totals, the last `days` days, the cost sums and the usage counts. `today` is the Québec day of the request. */
  async summary(days = 30, today?: string): Promise<StatsResponse> {
    const all = await this.store.list<Record<Counter, number>>("c:");
    const rows = [...all.entries()]
      .map(([k, counts]) => ({ day: k.slice(2), counts: { ...empty(), ...counts } }))
      .toSorted((a, b) => b.day.localeCompare(a.day));
    const totals = empty();
    for (const r of rows) for (const c of COUNTERS) totals[c] += r.counts[c];
    const costRows = [...(await this.store.list<CostSums>("k:")).entries()]
      .map(([k, sums]) => {
        const row = emptyCosts();
        addCosts(row, sums);
        return { day: k.slice(2), ...row };
      })
      .toSorted((a, b) => b.day.localeCompare(a.day));
    const costTotals = emptyCosts();
    for (const r of costRows) addCosts(costTotals, r);
    return {
      totals,
      days: rows.slice(0, days),
      since: rows.at(-1)?.day ?? null,
      costs: { totals: costTotals, days: costRows.slice(0, days), since: costRows.at(-1)?.day ?? null },
      usage: await this.usageSummary(today ?? rows[0]?.day ?? null, new Map(rows.map((r) => [r.day, r.counts.conversations]))),
    };
  }

  private async usageSummary(today: string | null, conversations: Map<string, number>): Promise<UsageSummary> {
    const all = await this.store.list<UsageDay>("u:");
    const total = emptyUsageDay();
    const week = zeros(TOPICS);
    const weekStart = today ? daysBefore(today, WEEK_DAYS - 1) : null;
    for (const [k, stored] of all) {
      const day = k.slice(2);
      const clean = emptyUsageDay();
      addUsage(clean, { agents: stored.agents, topics: stored.topics, reached: stored.reached, latency: stored.latency });
      addUsage(total, clean);
      if (weekStart && today && day >= weekStart && day <= today) addKnown(week, TOPICS, clean.topics);
    }
    const perDay = today
      ? Array.from({ length: CHART_DAYS }, (_, i) => {
          const day = daysBefore(today, CHART_DAYS - 1 - i);
          return { day, conversations: conversations.get(day) ?? 0 };
        })
      : [];
    return {
      calls: total.calls,
      topics: total.topics,
      topicsWeek: week,
      agents: total.agents,
      turns: lengths(total.reached),
      latency: total.latency,
      perDay,
    };
  }
}

/** Map-backed store for tests and for the in-memory fallback. */
export function memoryStore(): KeyStore {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return structuredClone(map.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      map.set(key, structuredClone(value));
    },
    async list<T>(prefix: string) {
      const out = new Map<string, T>();
      for (const [k, v] of map) if (k.startsWith(prefix)) out.set(k, structuredClone(v) as T);
      return out;
    },
  };
}

/** What the routes need from the stats object. */
export interface Stats {
  take(day: string, cap: number): Promise<{ ok: boolean; used: number }>;
  atCapacity(day: string, cap: number): Promise<boolean>;
  record(input: RecordInput): Promise<AlertAction>;
  window(): Promise<{ total: number; errors: number }>;
  summary(days?: number, today?: string): Promise<StatsResponse>;
}

export function memoryStats(): Stats {
  return new StatsCore(memoryStore());
}
