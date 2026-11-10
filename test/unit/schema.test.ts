import { describe, expect, it } from "vitest";
import { parseIncomingEvent } from "../../src/events/schema.js";

const now = new Date("2026-11-10T12:00:00.000Z");
const opts = { now, maxAgeDays: 30 };
const valid = {
  event_id: "6f1c2a8e-3b4d-4c5e-9f60-718293a4b5c6",
  type: "click",
  site_id: 3,
  campaign_id: 301,
  timestamp: "2026-11-10T11:59:00.000Z",
  device: "mobile",
  country: "TR",
};

describe("parseIncomingEvent", () => {
  it("normalizes a valid event", () => {
    const result = parseIncomingEvent({ ...valid, event_id: valid.event_id.toUpperCase() }, opts);
    expect(result).toEqual({
      ok: true,
      event: {
        event_id: valid.event_id,
        event_type: "click",
        site_id: 3,
        campaign_id: 301,
        ts: "2026-11-10T11:59:00.000Z",
        device: "mobile",
        country: "TR",
        received_at: "2026-11-10T12:00:00.000Z",
      },
    });
  });

  it("accepts epoch milliseconds and timezone offsets", () => {
    const ms = parseIncomingEvent({ ...valid, timestamp: Date.parse("2026-11-10T10:00:00Z") }, opts);
    const offset = parseIncomingEvent({ ...valid, timestamp: "2026-11-10T13:00:00+03:00" }, opts);
    expect(ms.ok && ms.event.ts).toBe("2026-11-10T10:00:00.000Z");
    expect(offset.ok && offset.event.ts).toBe("2026-11-10T10:00:00.000Z");
  });

  it.each([
    ["unknown type", { type: "hover" }, "type"],
    ["bad uuid", { event_id: "123" }, "event_id"],
    ["lowercase country", { country: "tr" }, "country"],
    ["zero site id", { site_id: 0 }, "site_id"],
    ["fractional campaign id", { campaign_id: 1.5 }, "campaign_id"],
    ["unknown device", { device: "watch" }, "device"],
    ["unparseable timestamp", { timestamp: "yesterday" }, "timestamp"],
  ])("rejects %s", (_name, patch, field) => {
    const result = parseIncomingEvent({ ...valid, ...patch }, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain(field);
  });

  it("rejects missing fields", () => {
    const { country: _country, ...rest } = valid;
    const result = parseIncomingEvent(rest, opts);
    expect(result.ok).toBe(false);
  });

  it("rejects events from the future beyond the allowed clock skew", () => {
    expect(parseIncomingEvent({ ...valid, timestamp: "2026-11-10T12:04:00Z" }, opts).ok).toBe(true);
    const result = parseIncomingEvent({ ...valid, timestamp: "2026-11-10T12:10:00Z" }, opts);
    expect(result).toEqual({ ok: false, issues: ["timestamp: is in the future"] });
  });

  it("rejects events older than the max age", () => {
    const result = parseIncomingEvent({ ...valid, timestamp: "2026-10-01T00:00:00Z" }, opts);
    expect(result).toEqual({ ok: false, issues: ["timestamp: is older than 30 days"] });
  });
});
