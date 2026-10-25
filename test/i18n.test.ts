import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { fr } from "../src/i18n/fr";
import { pages } from "../src/i18n/pages";
import { toolPages } from "../src/i18n/tool-pages";

/** Lists every key path, with array lengths and function arity, so fr and en must match exactly. */
function shape(value: unknown, path = ""): string[] {
  if (typeof value === "function") return [`${path}()${value.length}`];
  if (typeof value === "string") return [path];
  if (Array.isArray(value)) return [`${path}[${value.length}]`, ...value.flatMap((v, i) => shape(v, `${path}[${i}]`))];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
  return [path];
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const claims = (list: string[], word: RegExp) => list.filter((s) => word.test(s) && /10 minutes/.test(s));

describe("i18n", () => {
  it("fr and en have the same keys", () => {
    expect(shape(en).toSorted()).toEqual(shape(fr).toSorted());
  });
  it("the static pages have the same structure", () => {
    expect(shape(pages.en).toSorted()).toEqual(shape(pages.fr).toSorted());
  });
  it("the tool pages have the same structure", () => {
    expect(shape(toolPages.en).toSorted()).toEqual(shape(toolPages.fr).toSorted());
  });
  it("no string is empty, and no copy uses an em dash", () => {
    for (const s of [...strings(fr), ...strings(en), ...strings(pages), ...strings(toolPages)]) {
      expect(s.trim().length).toBeGreaterThan(0);
      expect(s).not.toContain("\u2014");
    }
  });
  it("the English copy is not left in French", () => {
    expect(en.chat.placeholder).not.toBe(fr.chat.placeholder);
    expect(en.gate.accept).not.toBe(fr.gate.accept);
  });
  it("the gate keeps the brief retention sentence", () => {
    expect(strings(fr)).toContain("Vos échanges sont effacés environ 10 minutes après la fin de la conversation.");
  });
  it("every retention claim uses the exact retention sentence", () => {
    const FR = "Vos échanges sont effacés environ 10 minutes après la fin de la conversation.";
    const EN = "Your messages are deleted about 10 minutes after the conversation ends.";
    const frClaims = claims([...strings(fr), ...strings(pages.fr), ...strings(toolPages.fr)], /effac/);
    const enClaims = claims([...strings(en), ...strings(pages.en), ...strings(toolPages.en)], /delete/);
    expect(frClaims.length).toBeGreaterThan(3);
    expect(enClaims.length).toBe(frClaims.length);
    for (const s of frClaims) expect(s).toContain(FR);
    for (const s of enClaims) expect(s).toContain(EN);
  });
  it("the gate links the privacy page, which says that milliseconds runs in Montréal", () => {
    expect(fr.gate.privacyLink.length).toBeGreaterThan(0);
    expect(en.gate.privacyLink.length).toBeGreaterThan(0);
    expect(JSON.stringify(pages.fr.privacy)).toContain("hébergé à Montréal");
    expect(JSON.stringify(pages.en.privacy)).toMatch(/Montr[ée]al/);
  });
});
