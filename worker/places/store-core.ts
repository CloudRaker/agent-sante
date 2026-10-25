// The place state of one session, keyed by its place reference (worker/places/postal.ts
// `placeRef`). It holds the position and the postal code of the person (shown back to that
// person only, never sent to the model), and the tool results
// of the turn in flight, until the chat pipeline takes them for the reply attachments.
import type { Lang } from "../../shared/api";
import type { AppointmentLink, PlaceItem } from "../../shared/places";
import type { GeoPoint } from "./postal";

export interface SessionPlace extends GeoPoint {
  /** Conversation language when the place was set (default language of the links). */
  lang: Lang;
  /** Epoch ms. */
  at: number;
  /** The full postal code ("H3J 1T6"), shown back to the person only. Never in a tool answer. */
  code?: string;
}

export type ToolResult =
  | { kind: "places"; at: number; area: string; items: PlaceItem[] }
  | { kind: "appointments"; at: number; link: AppointmentLink };

export interface PlaceStore {
  set(ref: string, place: SessionPlace): Promise<void>;
  get(ref: string): Promise<SessionPlace | null>;
  /** Adds a tool result. False when the reference has no place (nothing to attach to). */
  add(ref: string, result: ToolResult): Promise<boolean>;
  /** Returns the results added at or after `since`, and clears all results. */
  take(ref: string, since: number): Promise<ToolResult[]>;
  /** Forgets everything (the person ended the conversation). */
  end(ref: string): Promise<void>;
}

/** Max results kept per session between two takes. */
export const MAX_RESULTS = 12;

export interface PlaceState {
  place?: SessionPlace;
  results: ToolResult[];
}

export const placeRules = {
  add(s: PlaceState | undefined, result: ToolResult): PlaceState | null {
    if (!s?.place) return null;
    return { ...s, results: [...s.results, result].slice(-MAX_RESULTS) };
  },
  take(s: PlaceState | undefined, since: number): { results: ToolResult[]; next?: PlaceState } {
    if (!s) return { results: [] };
    return { results: s.results.filter((r) => r.at >= since), next: { ...s, results: [] } };
  },
};

/** In-memory store for tests and the local fake mode. */
export function memoryPlaces(): PlaceStore & { size(): number } {
  const map = new Map<string, PlaceState>();
  return {
    size: () => map.size,
    async set(ref, place) {
      map.set(ref, { place, results: map.get(ref)?.results ?? [] });
    },
    async get(ref) {
      return map.get(ref)?.place ?? null;
    },
    async add(ref, result) {
      const next = placeRules.add(map.get(ref), result);
      if (!next) return false;
      map.set(ref, next);
      return true;
    },
    async take(ref, since) {
      const { results, next } = placeRules.take(map.get(ref), since);
      if (next) map.set(ref, next);
      return results;
    },
    async end(ref) {
      map.delete(ref);
    },
  };
}
