import { describe, expect, it } from "vitest";
import { generateEvents, toIncoming } from "../../src/events/generator.js";
import { parseIncomingEvent } from "../../src/events/schema.js";
import { niceMax } from "../../src/dashboard/chart.js";

const opts = {
  seed: 7,
  rows: 5_000,
  sites: 3,
  campaignsPerSite: 4,
  start: new Date("2026-10-01T00:00:00Z"),
  days: 14,
};

describe("generateEvents", () => {
  it("is deterministic for a seed", () => {
    expect([...generateEvents(opts)]).toEqual([...generateEvents(opts)]);
    expect([...generateEvents({ ...opts, seed: 8 })][0]).not.toEqual([...generateEvents(opts)][0]);
  });

  it("emits exactly the requested number of unique, in-range events", () => {
    const events = [...generateEvents(opts)];
    expect(events).toHaveLength(5_000);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(5_000);
    const end = opts.start.getTime() + opts.days * 86_400_000;
    expect(events.every((e) => e.tsMs >= opts.start.getTime() && e.tsMs < end)).toBe(true);
  });

  it("produces events the collector accepts", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    for (const e of [...generateEvents(opts)].slice(0, 200)) {
      expect(parseIncomingEvent(toIncoming(e), { now, maxAgeDays: 30 }).ok).toBe(true);
    }
  });

  it("has a plausible funnel: fewer clicks than impressions, fewer submits than clicks", () => {
    const counts = { impression: 0, click: 0, submit: 0, close: 0 };
    for (const e of generateEvents(opts)) counts[e.event_type]++;
    expect(counts.click).toBeLessThan(counts.impression);
    expect(counts.submit).toBeLessThan(counts.click);
    expect(counts.submit).toBeGreaterThan(0);
  });
});

describe("niceMax", () => {
  it.each([
    [0, 1],
    [7, 10],
    [0.034, 0.05],
    [230, 250],
    [1001, 2000],
  ])("rounds %d up to %d", (input, expected) => {
    expect(niceMax(input)).toBeCloseTo(expected);
  });
});
