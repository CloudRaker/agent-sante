// Minimal Workers types for type-checking worker code from the DOM/test context.
// The real types come from worker/env.d.ts in tsconfig.worker.json.
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    protected ctx: {
      storage: {
        get<T>(k: string): Promise<T | undefined>;
        put(k: string, v: unknown): Promise<void>;
        list<T>(options: { prefix: string }): Promise<Map<string, T>>;
        setAlarm(t: number): Promise<void>;
        deleteAll(): Promise<void>;
        delete(k: string): Promise<boolean>;
      };
    };
    protected env: Env;
    alarm?(): Promise<void>;
  }
}
interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): unknown;
  get(id: unknown): T;
}
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: import("hono").Context["executionCtx"]): Response | Promise<Response>;
}
