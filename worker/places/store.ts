// Durable Object for the place state of one session (one object per place reference).
// It forgets everything 15 minutes after its last use, like the session guard.
import { DurableObject } from "cloudflare:workers";

import { IDLE_MS } from "../guard-core";
import { placeRules, type PlaceState, type PlaceStore, type SessionPlace, type ToolResult } from "./store-core";

export class SessionPlaces extends DurableObject {
  private async state(): Promise<PlaceState | undefined> {
    return this.ctx.storage.get<PlaceState>("p");
  }
  private async save(state: PlaceState): Promise<void> {
    await this.ctx.storage.put("p", state);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async setPlace(place: SessionPlace): Promise<void> {
    const s = await this.state();
    await this.save({ place, results: s?.results ?? [] });
  }

  async getPlace(): Promise<SessionPlace | null> {
    return (await this.state())?.place ?? null;
  }

  async add(result: ToolResult): Promise<boolean> {
    const next = placeRules.add(await this.state(), result);
    if (!next) return false;
    await this.save(next);
    return true;
  }

  async take(since: number): Promise<ToolResult[]> {
    const { results, next } = placeRules.take(await this.state(), since);
    if (next && results.length) await this.save(next);
    return results;
  }

  async end(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** Store backed by the PLACES Durable Object namespace. */
export function durablePlaces(ns: DurableObjectNamespace<SessionPlaces>): PlaceStore {
  const stub = (ref: string) => ns.get(ns.idFromName(ref));
  return {
    set: (ref, place) => stub(ref).setPlace(place),
    get: (ref) => stub(ref).getPlace(),
    add: (ref, result) => stub(ref).add(result),
    take: (ref, since) => stub(ref).take(since),
    end: (ref) => stub(ref).end(),
  };
}
