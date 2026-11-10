import type { ClickHouseClient } from "@clickhouse/client";
import { ident } from "./schema.js";

export interface DailyRow {
  day: string;
  site_id: number;
  campaign_id: number;
  impressions: number;
  clicks: number;
  submits: number;
  closes: number;
}

export interface DailyFilter {
  /** Inclusive, YYYY-MM-DD (UTC). */
  from: string;
  to: string;
  siteId?: number;
}

const COUNT_FIELDS = ["impressions", "clicks", "submits", "closes"] as const;

function toDailyRow(r: Record<string, unknown>): DailyRow {
  return {
    day: String(r.date),
    site_id: Number(r.site_id),
    campaign_id: Number(r.campaign_id),
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    submits: Number(r.submits),
    closes: Number(r.closes),
  };
}

async function select(client: ClickHouseClient, query: string, filter: DailyFilter): Promise<DailyRow[]> {
  const rs = await client.query({
    query,
    query_params: { from: filter.from, to: filter.to, site: filter.siteId ?? 0 },
    format: "JSONEachRow",
  });
  return (await rs.json<Record<string, unknown>>()).map(toDailyRow);
}

/**
 * Read path 1: count straight from raw events. FINAL makes ReplacingMergeTree
 * collapse duplicate event_ids at query time, so this is the "true" number.
 */
export function rawDailyQuery(database: string): string {
  const db = ident(database);
  return `
    SELECT
      toString(toDate(ts)) AS date, site_id, campaign_id,
      countIf(event_type = 'impression') AS impressions,
      countIf(event_type = 'click')      AS clicks,
      countIf(event_type = 'submit')     AS submits,
      countIf(event_type = 'close')      AS closes
    FROM ${db}.events FINAL
    WHERE toDate(ts) BETWEEN {from:Date} AND {to:Date}
      AND ({site:UInt32} = 0 OR site_id = {site:UInt32})
    GROUP BY date, site_id, campaign_id
    ORDER BY date, site_id, campaign_id`;
}

/**
 * Read path 2: the materialized view's rollup. SummingMergeTree may not have
 * merged every part yet, so it still needs sum() and GROUP BY.
 */
export function mvDailyQuery(database: string): string {
  const db = ident(database);
  return `
    SELECT
      toString(day) AS date, site_id, campaign_id,
      sum(impressions) AS impressions,
      sum(clicks)      AS clicks,
      sum(submits)     AS submits,
      sum(closes)      AS closes
    FROM ${db}.campaign_daily
    WHERE day BETWEEN {from:Date} AND {to:Date}
      AND ({site:UInt32} = 0 OR site_id = {site:UInt32})
    GROUP BY date, site_id, campaign_id
    ORDER BY date, site_id, campaign_id`;
}

export const rawDaily = (c: ClickHouseClient, db: string, f: DailyFilter) => select(c, rawDailyQuery(db), f);
export const mvDaily = (c: ClickHouseClient, db: string, f: DailyFilter) => select(c, mvDailyQuery(db), f);

export function conversionRate(row: Pick<DailyRow, "impressions" | "submits">): number {
  return row.impressions === 0 ? 0 : row.submits / row.impressions;
}

export function clickThroughRate(row: Pick<DailyRow, "impressions" | "clicks">): number {
  return row.impressions === 0 ? 0 : row.clicks / row.impressions;
}

/** Latest day present in the rollup, or null when there's no data yet. */
export async function dataRange(client: ClickHouseClient, database: string): Promise<{ min: string; max: string } | null> {
  const rs = await client.query({
    query: `SELECT toString(min(day)) AS min, toString(max(day)) AS max, count() AS n FROM ${ident(database)}.campaign_daily`,
    format: "JSONEachRow",
  });
  const [row] = await rs.json<{ min: string; max: string; n: string }>();
  if (!row || Number(row.n) === 0) return null;
  return { min: row.min, max: row.max };
}

export { COUNT_FIELDS };
