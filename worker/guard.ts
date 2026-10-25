// Session guard: one Durable Object per session id. It stores only ids, never
// message text. It gives single flight (one turn in flight per session) and makes
// each token single use: only the latest token id (jti) can start a turn.
import { DurableObject } from "cloudflare:workers";

import {
  IDLE_MS,
  rules,
  settleUsage,
  type BeginResult,
  type CommitResult,
  type Guard,
  type State,
  type UsageDelta,
  type UsageRead,
  type UsageState,
} from "./guard-core";

export class SessionGuard extends DurableObject {
  private async state(): Promise<State | undefined> {
    return this.ctx.storage.get<State>("s");
  }
  private async save(state: State): Promise<void> {
    await this.ctx.storage.put("s", state);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async init(jti: string): Promise<void> {
    await this.save({ jti, lease: 0, flight: "", run: "" });
  }

  async begin(jti: string): Promise<BeginResult> {
    const { result, next } = rules.begin(await this.state(), jti, Date.now());
    if (next) await this.save(next);
    return result;
  }

  async commit(flight: string, jti: string, run: string): Promise<CommitResult> {
    const { result, next } = rules.commit(await this.state(), flight, jti, run);
    if (next) await this.save(next);
    return result;
  }

  async abort(flight: string): Promise<void> {
    const next = rules.abort(await this.state(), flight);
    if (next) await this.save(next);
  }

  async end(): Promise<{ run: string } | null> {
    const s = await this.state();
    if (!s) return null;
    // The usage snapshots ("u") stay until the idle alarm: the last cost read may come after the end.
    await this.ctx.storage.delete("s");
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return { run: s.run ?? "" };
  }

  async settle(reads: UsageRead[]): Promise<UsageDelta[]> {
    const { deltas, next } = settleUsage(await this.ctx.storage.get<UsageState>("u"), reads, Date.now());
    await this.ctx.storage.put("u", next);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return deltas;
  }

  async live(jti: string): Promise<boolean> {
    return (await this.state())?.jti === jti;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** Guard backed by the SESSIONS Durable Object namespace. */
export function durableGuard(ns: DurableObjectNamespace<SessionGuard>): Guard {
  const stub = (sid: string) => ns.get(ns.idFromName(sid));
  return {
    init: (sid, jti) => stub(sid).init(jti),
    begin: (sid, jti) => stub(sid).begin(jti),
    commit: (sid, flight, jti, run) => stub(sid).commit(flight, jti, run),
    abort: (sid, flight) => stub(sid).abort(flight),
    end: (sid) => stub(sid).end(),
    live: (sid, jti) => stub(sid).live(jti),
    settle: (sid, reads) => stub(sid).settle(reads),
  };
}
