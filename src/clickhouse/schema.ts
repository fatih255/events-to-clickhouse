import type { ClickHouseClient } from "@clickhouse/client";

const ident = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad identifier: ${name}`);
  return name;
};

/**
 * Raw events plus a daily per-campaign rollup kept up to date by a
 * materialized view.
 *
 * events: ReplacingMergeTree keyed on event_id, so a duplicate that slips past
 * the writer's dedupe still collapses on merge (and right away with FINAL).
 * Partitioned by month; ORDER BY starts with site and campaign because every
 * dashboard query filters on those first.
 *
 * campaign_daily: SummingMergeTree fed by the MV on every insert. The MV only
 * sees inserted blocks, never merges, so it would count a duplicate twice.
 * That's why the writer dedupes before inserting, and why
 * scripts/compare-read-paths.ts exists.
 */
export function schemaStatements(database: string): string[] {
  const db = ident(database);
  return [
    `CREATE DATABASE IF NOT EXISTS ${db}`,
    `CREATE TABLE IF NOT EXISTS ${db}.events
     (
       event_id    UUID,
       event_type  Enum8('impression' = 1, 'click' = 2, 'submit' = 3, 'close' = 4),
       site_id     UInt32,
       campaign_id UInt32,
       ts          DateTime64(3, 'UTC'),
       device      Enum8('desktop' = 1, 'mobile' = 2, 'tablet' = 3),
       country     LowCardinality(String),
       received_at DateTime64(3, 'UTC'),
       INDEX idx_event_id event_id TYPE bloom_filter(0.01) GRANULARITY 1
     )
     ENGINE = ReplacingMergeTree
     PARTITION BY toYYYYMM(ts)
     ORDER BY (site_id, campaign_id, toDate(ts), event_id)`,
    `CREATE TABLE IF NOT EXISTS ${db}.campaign_daily
     (
       day         Date,
       site_id     UInt32,
       campaign_id UInt32,
       impressions UInt64,
       clicks      UInt64,
       submits     UInt64,
       closes      UInt64
     )
     ENGINE = SummingMergeTree
     PARTITION BY toYYYYMM(day)
     ORDER BY (site_id, campaign_id, day)`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${db}.campaign_daily_mv TO ${db}.campaign_daily AS
     SELECT
       toDate(ts) AS day,
       site_id,
       campaign_id,
       countIf(event_type = 'impression') AS impressions,
       countIf(event_type = 'click')      AS clicks,
       countIf(event_type = 'submit')     AS submits,
       countIf(event_type = 'close')      AS closes
     FROM ${db}.events
     GROUP BY day, site_id, campaign_id`,
  ];
}

export async function migrate(client: ClickHouseClient, database: string): Promise<void> {
  for (const query of schemaStatements(database)) {
    await client.command({ query });
  }
}

export async function dropDatabase(client: ClickHouseClient, database: string): Promise<void> {
  await client.command({ query: `DROP DATABASE IF EXISTS ${ident(database)}` });
}

export { ident };
