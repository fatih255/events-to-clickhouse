import { describe, expect, it } from "vitest";
import { compareDaily, formatComparison } from "../../src/checks/compare.js";
import type { DailyRow } from "../../src/clickhouse/queries.js";
import { normalizeRows } from "../../src/bench/queries.js";

const row = (patch: Partial<DailyRow> = {}): DailyRow => ({
  day: "2026-11-01",
  site_id: 1,
  campaign_id: 101,
  impressions: 100,
  clicks: 10,
  submits: 3,
  closes: 40,
  ...patch,
});

describe("compareDaily", () => {
  it("reports no mismatches when both read paths agree", () => {
    const rows = [row(), row({ campaign_id: 102 }), row({ day: "2026-11-02" })];
    expect(compareDaily(rows, [...rows].reverse())).toEqual({ keys: 3, mismatches: [] });
  });

  it("reports each differing field with both values", () => {
    const result = compareDaily([row()], [row({ impressions: 101, submits: 4 })]);
    expect(result.mismatches).toEqual([
      { day: "2026-11-01", site_id: 1, campaign_id: 101, field: "impressions", raw: 100, mv: 101 },
      { day: "2026-11-01", site_id: 1, campaign_id: 101, field: "submits", raw: 3, mv: 4 },
    ]);
  });

  it("reports rows that exist on only one side", () => {
    const result = compareDaily([row(), row({ campaign_id: 102 })], [row()]);
    expect(result.mismatches).toEqual([
      { day: "2026-11-01", site_id: 1, campaign_id: 102, field: "row", raw: 1, mv: null },
    ]);
  });

  it("ignores an all-zero row that exists on only one side", () => {
    const zero = row({ campaign_id: 103, impressions: 0, clicks: 0, submits: 0, closes: 0 });
    expect(compareDaily([row()], [row(), zero]).mismatches).toEqual([]);
  });

  it("formats a readable report", () => {
    expect(formatComparison({ keys: 5, mismatches: [] })).toContain("agree on all 5");
    const text = formatComparison(compareDaily([row()], [row({ clicks: 12 })]));
    expect(text).toContain("MISMATCH: 1 differences");
    expect(text).toMatch(/clicks\s+10\s+12\s+2/);
  });
});

describe("normalizeRows", () => {
  it("makes ClickHouse and Postgres rows comparable", () => {
    // ClickHouse JSON returns UInt64 as strings, pg returns bigint as strings and numerics as strings.
    const ch = [{ day: "2026-09-01", campaign_id: 705, impressions: "120", conversion_rate: 0.0123456 }];
    const pg = [{ day: "2026-09-01", campaign_id: 705, impressions: "120", conversion_rate: "0.012346" }];
    expect(normalizeRows(ch)).toEqual(normalizeRows(pg));
  });
});
