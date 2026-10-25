import { describe, expect, it } from "vitest";
import examples from "./fixtures/pii-examples.json";
import { regexPii } from "../worker/safety/checks";

// Synthetic test messages (no real person).
// The regex layer runs with no model, so it must never block a clean message,
// and every kind it reports must be one the case expects.
interface Case {
  id: string;
  expected: string;
  kinds: string[];
  text: string;
  layer?: string;
}
const cases = (examples as unknown as { cases: Case[] }).cases;
const isPii = (c: Case) => c.kinds.length > 0;

describe("PII examples, regex layer", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(100);
  });
  it.each(cases.filter((c) => !isPii(c)).map((c) => [c.id, c.text] as const))("does not block clean case %s", (_id, text) => {
    expect(regexPii(text)).toEqual([]);
  });
  it.each(cases.filter(isPii).map((c) => [c.id, c] as const))("reports only expected kinds for %s", (_id, c) => {
    for (const kind of regexPii(c.text)) expect(c.kinds).toContain(kind);
  });
});

describe("PII examples, names in self-introductions and signatures", () => {
  const named = cases.filter((c) => c.layer === "name-intro");
  it("has 30 or more cases", () => {
    expect(named.length).toBeGreaterThanOrEqual(30);
  });
  it.each(named.filter(isPii).map((c) => [c.id, c.text] as const))("blocks %s before any network call", (_id, text) => {
    expect(regexPii(text)).toContain("person_name");
  });
});
