// Stats Durable Object: one global instance ("global") holds the aggregate counters, the daily turn cap
// and the error-rate window. A Durable Object runs one call at a time, so the cap check and the
// increment are atomic. It stores counts only, never text, ids or IP addresses.
import { DurableObject } from "cloudflare:workers";
import type { StatsResponse } from "../shared/api";
import { StatsCore, type AlertAction, type KeyStore, type RecordInput, type Stats } from "./stats-core";

export class StatsCounter extends DurableObject {
  private core = new StatsCore(storageStore(this.ctx.storage));

  take(day: string, cap: number): Promise<{ ok: boolean; used: number }> {
    return this.core.take(day, cap);
  }
  atCapacity(day: string, cap: number): Promise<boolean> {
    return this.core.atCapacity(day, cap);
  }
  record(input: RecordInput): Promise<AlertAction> {
    return this.core.record(input);
  }
  window(): Promise<{ total: number; errors: number }> {
    return this.core.window();
  }
  summary(days?: number, today?: string): Promise<StatsResponse> {
    return this.core.summary(days, today);
  }
}

/** The part of the Durable Object storage API this file uses. */
interface ObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

function storageStore(storage: ObjectStorage): KeyStore {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    list: (prefix) => storage.list({ prefix }),
  };
}

/** Stats backed by the STATS namespace (one global object). */
export function durableStats(ns: DurableObjectNamespace<StatsCounter>): Stats {
  const stub = () => ns.get(ns.idFromName("global"));
  return {
    take: (day, cap) => stub().take(day, cap),
    atCapacity: (day, cap) => stub().atCapacity(day, cap),
    record: (input) => stub().record(input),
    window: () => stub().window(),
    summary: (days, today) => stub().summary(days, today),
  };
}
