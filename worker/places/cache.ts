// A small JSON cache over the Cache API (caches.default), with a memory layer for tests and
// for one isolate. Keys are synthetic https URLs on our own host; nothing personal goes in a
// key except a rounded position.

export interface JsonCache {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

const KEY_ORIGIN = "https://cache.agentsante.ca/";

export function jsonCache(cache: Cache | undefined, now: () => number = Date.now): JsonCache {
  const memory = new Map<string, { until: number; value: unknown }>();
  return {
    async get<T>(key: string) {
      const m = memory.get(key);
      if (m && m.until > now()) return m.value as T;
      if (!cache) return undefined;
      try {
        const res = await cache.match(KEY_ORIGIN + key);
        if (!res) return undefined;
        const value = (await res.json()) as T;
        memory.set(key, { until: now() + 60_000, value });
        return value;
      } catch {
        return undefined;
      }
    },
    async put(key, value, ttlSeconds) {
      if (memory.size > 500) memory.clear();
      memory.set(key, { until: now() + ttlSeconds * 1000, value });
      if (!cache) return;
      try {
        await cache.put(
          KEY_ORIGIN + key,
          new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` },
          }),
        );
      } catch {
        // The cache is an optimization only.
      }
    },
  };
}
