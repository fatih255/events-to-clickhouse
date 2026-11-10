import type { ClickHouseClient } from "@clickhouse/client";
import { COUNT_FIELDS, mvDaily, rawDaily, type DailyFilter, type DailyRow } from "../clickhouse/queries.js";

export interface Mismatch {
  day: string;
  site_id: number;
  campaign_id: number;
  /** A count field, or "row" when one side has no row for this key at all. */
  field: (typeof COUNT_FIELDS)[number] | "row";
  raw: number | null;
  mv: number | null;
}

export interface Comparison {
  keys: number;
  mismatches: Mismatch[];
}

const keyOf = (r: DailyRow) => `${r.day}|${r.site_id}|${r.campaign_id}`;

/**
 * Compares the same daily aggregate from two read paths, key by key and
 * field by field, so the report says exactly where they disagree.
 */
export function compareDaily(raw: DailyRow[], mv: DailyRow[]): Comparison {
  const rawByKey = new Map(raw.map((r) => [keyOf(r), r]));
  const mvByKey = new Map(mv.map((r) => [keyOf(r), r]));
  const keys = [...new Set([...rawByKey.keys(), ...mvByKey.keys()])].sort();
  const mismatches: Mismatch[] = [];

  for (const key of keys) {
    const a = rawByKey.get(key);
    const b = mvByKey.get(key);
    const ref = (a ?? b)!;
    const base = { day: ref.day, site_id: ref.site_id, campaign_id: ref.campaign_id };
    if (!a || !b) {
      // A day where every count is zero on the existing side isn't a real gap.
      const present = (a ?? b)!;
      if (COUNT_FIELDS.some((f) => present[f] !== 0)) {
        mismatches.push({ ...base, field: "row", raw: a ? 1 : null, mv: b ? 1 : null });
      }
      continue;
    }
    for (const field of COUNT_FIELDS) {
      if (a[field] !== b[field]) mismatches.push({ ...base, field, raw: a[field], mv: b[field] });
    }
  }
  return { keys: keys.length, mismatches };
}

export async function compareReadPaths(
  client: ClickHouseClient,
  database: string,
  filter: DailyFilter,
): Promise<Comparison> {
  const [raw, mv] = await Promise.all([rawDaily(client, database, filter), mvDaily(client, database, filter)]);
  return compareDaily(raw, mv);
}

export function formatComparison(c: Comparison, limit = 20): string {
  if (c.mismatches.length === 0) {
    return `OK: raw events and campaign_daily agree on all ${c.keys} (day, site, campaign) rows.`;
  }
  const lines = [
    `MISMATCH: ${c.mismatches.length} differences across ${c.keys} (day, site, campaign) rows.`,
    "",
    "day         site  campaign  field        raw       mv        diff",
  ];
  for (const m of c.mismatches.slice(0, limit)) {
    const diff = m.raw !== null && m.mv !== null ? String(m.mv - m.raw) : "-";
    lines.push(
      [
        m.day.padEnd(11),
        String(m.site_id).padEnd(5),
        String(m.campaign_id).padEnd(9),
        m.field.padEnd(12),
        String(m.raw ?? "missing").padEnd(9),
        String(m.mv ?? "missing").padEnd(9),
        diff,
      ].join(" "),
    );
  }
  if (c.mismatches.length > limit) lines.push(`... and ${c.mismatches.length - limit} more`);
  return lines.join("\n");
}
