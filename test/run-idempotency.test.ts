// Run idempotency keys: an identical retry reuses the key, a retry that differs (another agent,
// another input) gets a new key, so Run never answers idempotency_mismatch on every attempt.
import { describe, expect, it } from "vitest";
import { RunClient } from "../worker/run/client";

function recordingClient() {
  const keys: string[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    return new Response(JSON.stringify({ error: { code: "stop" } }), { status: 400, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { keys, client: new RunClient({ token: "t", origin: "https://run.example", base: "b", fetcher }) };
}

describe("idempotency keys", () => {
  it("keep the caller key, and add a fingerprint of the request", async () => {
    const { keys, client } = recordingClient();
    await client.start("fr/concierge", "Bonjour", "sid.m1.start").catch(() => {});
    await client.start("fr/concierge", "Bonjour", "sid.m1.start").catch(() => {});
    await client.start("fr/maladies-medicaments", "Bonjour", "sid.m1.start").catch(() => {});
    await client.start("fr/concierge", "Bonjour !", "sid.m1.start").catch(() => {});
    expect(keys[0]).toMatch(/^sid\.m1\.start\.[0-9a-z]+$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });
});
