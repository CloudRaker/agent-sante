// Usage counts of the StatsCounter Durable Object: per day, per topic, per agent, per bucket.
// Counts only: unknown keys and free text are dropped.
import { describe, expect, it } from "vitest";
import { usageCounts } from "../worker/app";
import { TurnMeter } from "../worker/costs";
import { lengths, memoryStats } from "../worker/stats-core";
import { daysBefore } from "../worker/time";

const now = 0;

describe("StatsCounter usage counts", () => {
  it("starts empty, with a 14-day chart of zeros", async () => {
    const stats = memoryStats();
    const s = await stats.summary(30, "2026-10-24");
    expect(s.usage!.calls).toBe(0);
    expect(s.usage!.agents).toEqual({});
    expect(s.usage!.perDay).toHaveLength(14);
    expect(s.usage!.perDay[0]).toEqual({ day: "2026-10-11", conversations: 0 });
    expect(s.usage!.perDay.at(-1)).toEqual({ day: "2026-10-24", conversations: 0 });
  });

  it("adds calls by agent and topic, buckets, and keeps the topics of the last 7 days apart", async () => {
    const stats = memoryStats();
    await stats.record({ day: "2026-10-10", usage: { agents: { "fr/grippe": 2 }, topics: { flu: 2 } }, nowMs: now });
    await stats.record({
      day: "2026-10-24",
      counts: { conversations: 3 },
      usage: { agents: { "fr/concierge": 1, "en/flu": 1 }, topics: { orientation: 1, flu: 1 }, reached: { "1": 1 }, latency: { "5-10s": 1 } },
      nowMs: now,
    });
    await stats.record({ day: "2026-10-23", counts: { conversations: 2 }, usage: { reached: { "1": 1, "2-3": 1 }, latency: { "<5s": 1 } }, nowMs: now });
    const u = (await stats.summary(30, "2026-10-24")).usage!;
    expect(u.calls).toBe(4);
    expect(u.agents).toEqual({ "fr/grippe": 2, "fr/concierge": 1, "en/flu": 1 });
    expect(u.topics).toMatchObject({ flu: 3, orientation: 1 });
    expect(u.topicsWeek).toMatchObject({ flu: 1, orientation: 1 });
    expect(u.turns).toEqual({ "1": 1, "2-3": 1, "4-6": 0, "7+": 0 });
    expect(u.latency).toEqual({ "<5s": 1, "5-10s": 1, "10-20s": 0, "20s+": 0 });
    expect(u.perDay.at(-1)).toEqual({ day: "2026-10-24", conversations: 3 });
    expect(u.perDay.at(-2)).toEqual({ day: "2026-10-23", conversations: 2 });
  });

  it("drops unknown keys, free text, bad numbers, and caps the agent ids", async () => {
    const stats = memoryStats();
    await stats.record({
      day: "2026-10-24",
      usage: {
        agents: { "Jean Tremblay": 1, "fr/grippe": Number.NaN, "fr/gastro": -3, "../x": 1, "en/flu": 1.7 },
        topics: { flu: 1, "my headache": 4 } as never,
        reached: { "99": 1 } as never,
        latency: { "1h": 1 } as never,
      },
      nowMs: now,
    });
    for (let i = 0; i < 80; i++) await stats.record({ day: "2026-10-24", usage: { agents: { [`fr/a${i}`]: 1 } }, nowMs: now });
    const u = (await stats.summary(30, "2026-10-24")).usage!;
    expect(JSON.stringify(u)).not.toContain("Tremblay");
    expect(JSON.stringify(u)).not.toContain("headache");
    expect(u.agents["en/flu"]).toBe(1);
    expect(Object.keys(u.agents)).toHaveLength(64);
    expect(u.latency).toEqual({ "<5s": 0, "5-10s": 0, "10-20s": 0, "20s+": 0 });
  });

  it("turns the 'reached' counts into conversation lengths", () => {
    expect(lengths({ "1": 10, "2-3": 6, "4-6": 2, "7+": 1 })).toEqual({ "1": 4, "2-3": 4, "4-6": 1, "7+": 1 });
    expect(lengths({ "1": 0, "2-3": 1, "4-6": 0, "7+": 0 })).toEqual({ "1": 0, "2-3": 1, "4-6": 0, "7+": 0 });
  });

  it("counts a message once: its calls, the bucket it enters and the response time of a reply", () => {
    const meter = new TurnMeter();
    meter.calls.push({ agent: "fr/concierge", how: "concierge", ms: 3000 }, { agent: "fr/grippe", how: "handoff", ms: 4000 });
    const out = { lang: "fr" as const, replied: true, rewrites: 0, turnMs: 7_500, answered: 1 };
    expect(usageCounts(meter, out)).toEqual({
      agents: { "fr/concierge": 1, "fr/grippe": 1 },
      topics: { orientation: 1, flu: 1 },
      reached: { "1": 1 },
      latency: { "5-10s": 1 },
    });
    // The third answered message is inside the "2-3" bucket: no new bucket.
    expect(usageCounts(meter, { ...out, answered: 3 }).reached).toEqual({});
    expect(usageCounts(meter, { ...out, answered: 4 }).reached).toEqual({ "4-6": 1 });
    // An error: calls count, but no length and no response time.
    expect(usageCounts(meter, { ...out, replied: false })).toMatchObject({ reached: {}, latency: {} });
  });

  it("counts days back across a month end", () => {
    expect(daysBefore("2026-11-02", 3)).toBe("2026-10-30");
  });
});
