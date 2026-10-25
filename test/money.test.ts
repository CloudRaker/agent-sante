// CAD amounts on the site: one fixed rate from the stored USD, fr-CA and en-CA formats.
import { describe, expect, it } from "vitest";
import { USD_TO_CAD, cadDecimals, formatCad, toCad } from "../shared/money";

describe("CAD money", () => {
  it("converts the stored USD with one fixed rate", () => {
    expect(USD_TO_CAD).toBe(1.46);
    expect(toCad(1)).toBeCloseTo(1.46, 10);
    expect(toCad(0.05)).toBeCloseTo(0.073, 10);
    expect(toCad(Number.NaN)).toBe(0);
  });

  it("formats fr-CA with the sign after the number and en-CA with the sign before", () => {
    expect(formatCad(0.12, "fr")).toMatch(/^0,12\s\$$/);
    expect(formatCad(0.12, "en")).toBe("$0.12");
    expect(formatCad(1234.5, "fr")).toMatch(/^1\s234,50\s\$$/);
    expect(formatCad(1234.5, "en")).toBe("$1,234.50");
    expect(formatCad(0, "en")).toBe("$0.00");
  });

  it("shows 4 significant digits under one cent, and 2 decimals from one cent up", () => {
    expect([0, 0.004567, 0.0004567, 0.009999, 0.01, 0.42, 12].map(cadDecimals)).toEqual([2, 6, 7, 6, 2, 2, 2]);
    expect(formatCad(0.004567, "fr")).toMatch(/^0,004567\s\$$/);
    expect(formatCad(0.00456789, "en")).toBe("$0.004568");
    expect(formatCad(toCad(0.0003), "en")).toBe("$0.0004380");
  });

  it("never names US dollars", () => {
    for (const v of [0, 0.003, 0.5, 12000]) for (const lang of ["fr", "en"] as const) expect(formatCad(v, lang)).not.toMatch(/US|USD/);
  });
});
