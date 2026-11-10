import type { GeneratorOptions } from "../events/generator.js";

/** The benchmark dataset. Fixed dates so every run generates the same rows. */
export function benchDataset(rows: number): GeneratorOptions {
  return {
    seed: 42,
    rows,
    sites: 20,
    campaignsPerSite: 10,
    start: new Date("2026-07-01T00:00:00Z"),
    days: 92,
  };
}

export type Variant = "ch_raw" | "ch_mv" | "pg_raw" | "pg_mv";

export interface BenchQuery {
  id: string;
  title: string;
  sql: Partial<Record<Variant, string>>;
}

/**
 * Same question, same answer, written for each engine and read path.
 * ClickHouse raw queries use FINAL because that's what a correct read of a
 * ReplacingMergeTree costs. The bench script checks every variant returns
 * identical rows before it reports any timing.
 */
export function benchQueries(chDb: string): BenchQuery[] {
  const counts = (fn: (type: string) => string) =>
    ["impression", "click", "submit", "close"].map((t, i) => `${fn(t)} AS ${["impressions", "clicks", "submits", "closes"][i]}`).join(",\n      ");
  const chCounts = counts((t) => `countIf(event_type = '${t}')`);
  const pgCounts = counts((t) => `count(*) FILTER (WHERE event_type = '${t}')`);

  return [
    {
      id: "dashboard",
      title: "Daily metrics per campaign, one site, 30 days",
      sql: {
        ch_raw: `SELECT toString(toDate(ts)) AS date, campaign_id,
      ${chCounts}
    FROM ${chDb}.events FINAL
    WHERE site_id = 7 AND ts >= '2026-09-01 00:00:00' AND ts < '2026-10-01 00:00:00'
    GROUP BY date, campaign_id ORDER BY date, campaign_id`,
        ch_mv: `SELECT toString(day) AS date, campaign_id,
      sum(impressions) AS impressions, sum(clicks) AS clicks, sum(submits) AS submits, sum(closes) AS closes
    FROM ${chDb}.campaign_daily
    WHERE site_id = 7 AND day BETWEEN '2026-09-01' AND '2026-09-30'
    GROUP BY date, campaign_id ORDER BY date, campaign_id`,
        pg_raw: `SELECT to_char((ts AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date, campaign_id,
      ${pgCounts}
    FROM events
    WHERE site_id = 7 AND ts >= '2026-09-01 00:00:00+00' AND ts < '2026-10-01 00:00:00+00'
    GROUP BY 1, 2 ORDER BY 1, 2`,
        pg_mv: `SELECT to_char(day, 'YYYY-MM-DD') AS date, campaign_id, impressions, clicks, submits, closes
    FROM campaign_daily
    WHERE site_id = 7 AND day BETWEEN '2026-09-01' AND '2026-09-30'
    ORDER BY 1, 2`,
      },
    },
    {
      id: "top-conversion",
      title: "Top 10 campaigns by conversion rate, all 92 days",
      sql: {
        ch_raw: `SELECT campaign_id, countIf(event_type = 'impression') AS impressions, countIf(event_type = 'submit') AS submits,
      round(submits / impressions, 6) AS conversion_rate
    FROM ${chDb}.events FINAL
    GROUP BY campaign_id ORDER BY conversion_rate DESC, campaign_id LIMIT 10`,
        ch_mv: `SELECT campaign_id, sum(impressions) AS impressions, sum(submits) AS submits,
      round(submits / impressions, 6) AS conversion_rate
    FROM ${chDb}.campaign_daily
    GROUP BY campaign_id ORDER BY conversion_rate DESC, campaign_id LIMIT 10`,
        pg_raw: `SELECT campaign_id, impressions, submits, round(submits::numeric / impressions, 6) AS conversion_rate
    FROM (SELECT campaign_id,
            count(*) FILTER (WHERE event_type = 'impression') AS impressions,
            count(*) FILTER (WHERE event_type = 'submit') AS submits
          FROM events GROUP BY campaign_id) t
    ORDER BY conversion_rate DESC, campaign_id LIMIT 10`,
        pg_mv: `SELECT campaign_id, impressions, submits, round(submits::numeric / impressions, 6) AS conversion_rate
    FROM (SELECT campaign_id, sum(impressions) AS impressions, sum(submits) AS submits
          FROM campaign_daily GROUP BY campaign_id) t
    ORDER BY conversion_rate DESC, campaign_id LIMIT 10`,
      },
    },
    {
      id: "country-device",
      title: "Events by country and device, last 7 days, all sites",
      sql: {
        ch_raw: `SELECT country, toString(device) AS device, count() AS events
    FROM ${chDb}.events FINAL
    WHERE ts >= '2026-09-24 00:00:00' AND ts < '2026-10-01 00:00:00'
    GROUP BY country, device ORDER BY country, device`,
        pg_raw: `SELECT country, device::text AS device, count(*) AS events
    FROM events
    WHERE ts >= '2026-09-24 00:00:00+00' AND ts < '2026-10-01 00:00:00+00'
    GROUP BY 1, 2 ORDER BY 1, 2`,
      },
    },
    {
      id: "campaign-hourly",
      title: "Hourly events for one campaign on one day",
      sql: {
        ch_raw: `SELECT toHour(ts) AS hour, toString(event_type) AS event_type, count() AS events
    FROM ${chDb}.events FINAL
    WHERE site_id = 7 AND campaign_id = 705 AND ts >= '2026-09-15 00:00:00' AND ts < '2026-09-16 00:00:00'
    GROUP BY hour, event_type ORDER BY hour, event_type`,
        pg_raw: `SELECT extract(hour FROM ts AT TIME ZONE 'UTC')::int AS hour, event_type::text AS event_type, count(*) AS events
    FROM events
    WHERE site_id = 7 AND campaign_id = 705 AND ts >= '2026-09-15 00:00:00+00' AND ts < '2026-09-16 00:00:00+00'
    GROUP BY 1, 2 ORDER BY 1, 2`,
      },
    },
  ];
}

/** Turns rows from either engine into comparable strings. */
export function normalizeRows(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) =>
    Object.values(row)
      .map((v) => {
        const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
        return n === null ? String(v) : String(Math.round(n * 1e6) / 1e6);
      })
      .join("|"),
  );
}
