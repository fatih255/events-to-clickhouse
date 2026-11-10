import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ClickHouseClient } from "@clickhouse/client";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { generateEvents, type GeneratedEvent, type GeneratorOptions } from "../events/generator.js";
import { dropDatabase, ident, migrate } from "../clickhouse/schema.js";

const LINES_PER_CHUNK = 20_000;

function chCsvTime(ms: number): string {
  // 2026-07-01T12:34:56.789Z -> 2026-07-01 12:34:56.789
  return new Date(ms).toISOString().replace("T", " ").slice(0, 23);
}

function* take<T>(it: Iterator<T>, n: number): Generator<T> {
  for (let i = 0; i < n; i++) {
    const r = it.next();
    if (r.done) return;
    yield r.value;
  }
}

function lines(events: Iterable<GeneratedEvent>, format: (e: GeneratedEvent) => string): Readable {
  return Readable.from(
    (function* () {
      let buf: string[] = [];
      for (const e of events) {
        buf.push(format(e));
        if (buf.length >= LINES_PER_CHUNK) {
          yield buf.join("");
          buf = [];
        }
      }
      if (buf.length > 0) yield buf.join("");
    })(),
    { objectMode: false },
  );
}

const chLine = (e: GeneratedEvent): string => {
  const t = chCsvTime(e.tsMs);
  return `${e.event_id}\t${e.event_type}\t${e.site_id}\t${e.campaign_id}\t${t}\t${e.device}\t${e.country}\t${t}\n`;
};

const pgLine = (e: GeneratedEvent): string => {
  const t = `${chCsvTime(e.tsMs)}+00`;
  return `${e.event_id}\t${e.event_type}\t${e.site_id}\t${e.campaign_id}\t${t}\t${e.device}\t${e.country}\t${t}\n`;
};

/**
 * Loads the synthetic dataset into ClickHouse in inserts of `rowsPerInsert`.
 * The materialized view fills campaign_daily as part of each insert.
 */
export async function loadClickHouse(
  client: ClickHouseClient,
  database: string,
  gen: GeneratorOptions,
  rowsPerInsert = 1_000_000,
): Promise<void> {
  await dropDatabase(client, database);
  await migrate(client, database);
  const it = generateEvents(gen);
  for (let loaded = 0; loaded < gen.rows; loaded += rowsPerInsert) {
    await client.insert({
      table: `${ident(database)}.events`,
      values: lines(take(it, Math.min(rowsPerInsert, gen.rows - loaded)), chLine),
      format: "TabSeparated",
    });
  }
}

/** Merges parts so FINAL and the SummingMergeTree reads work on settled data. */
export async function optimizeClickHouse(client: ClickHouseClient, database: string): Promise<void> {
  const db = ident(database);
  await client.command({ query: `OPTIMIZE TABLE ${db}.events FINAL`, clickhouse_settings: { alter_sync: "2" } });
  await client.command({ query: `OPTIMIZE TABLE ${db}.campaign_daily FINAL` });
}

export const PG_SCHEMA = `
  DROP TABLE IF EXISTS events CASCADE;
  DROP TYPE IF EXISTS event_type CASCADE;
  DROP TYPE IF EXISTS device CASCADE;
  CREATE TYPE event_type AS ENUM ('impression', 'click', 'submit', 'close');
  CREATE TYPE device AS ENUM ('desktop', 'mobile', 'tablet');
  CREATE TABLE events (
    event_id    uuid        NOT NULL,
    event_type  event_type  NOT NULL,
    site_id     integer     NOT NULL,
    campaign_id integer     NOT NULL,
    ts          timestamptz NOT NULL,
    device      device      NOT NULL,
    country     char(2)     NOT NULL,
    received_at timestamptz NOT NULL
  );`;

/** Indexes are built after COPY; that's the usual way to bulk load Postgres. */
export const PG_INDEXES = `
  ALTER TABLE events ADD PRIMARY KEY (event_id);
  CREATE INDEX events_site_campaign_ts ON events (site_id, campaign_id, ts);
  CREATE INDEX events_ts ON events (ts);`;

/** The Postgres counterpart of campaign_daily. Refreshed by hand, not on insert. */
export const PG_ROLLUP = `
  DROP MATERIALIZED VIEW IF EXISTS campaign_daily;
  CREATE MATERIALIZED VIEW campaign_daily AS
  SELECT
    (ts AT TIME ZONE 'UTC')::date AS day, site_id, campaign_id,
    count(*) FILTER (WHERE event_type = 'impression') AS impressions,
    count(*) FILTER (WHERE event_type = 'click')      AS clicks,
    count(*) FILTER (WHERE event_type = 'submit')     AS submits,
    count(*) FILTER (WHERE event_type = 'close')      AS closes
  FROM events
  GROUP BY 1, 2, 3;
  CREATE UNIQUE INDEX campaign_daily_key ON campaign_daily (site_id, campaign_id, day);`;

export async function loadPostgres(client: pg.ClientBase, gen: GeneratorOptions): Promise<void> {
  await client.query(PG_SCHEMA);
  const copy = client.query(
    copyFrom(
      "COPY events (event_id, event_type, site_id, campaign_id, ts, device, country, received_at) FROM STDIN",
    ),
  );
  await pipeline(lines(generateEvents(gen), pgLine), copy);
}

export async function indexPostgres(client: pg.ClientBase): Promise<void> {
  await client.query(PG_INDEXES);
  await client.query("VACUUM ANALYZE events");
}

export async function rollupPostgres(client: pg.ClientBase): Promise<void> {
  await client.query(PG_ROLLUP);
  await client.query("ANALYZE campaign_daily");
}
