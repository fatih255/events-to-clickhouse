import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { config } from "../config.js";

export function createClickHouse(overrides: { database?: string } = {}): ClickHouseClient {
  return createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.user,
    password: config.clickhouse.password,
    database: overrides.database ?? config.clickhouse.database,
    request_timeout: 120_000,
    clickhouse_settings: {
      // Accept ISO 8601 strings like 2026-11-10T09:30:00.000Z in inserts.
      date_time_input_format: "best_effort",
      // Keeps long bench queries and inserts from being cut off as idle.
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: "10000",
    },
  });
}

/** Throws until ClickHouse answers a ping. */
export async function pingClickHouse(client: ClickHouseClient): Promise<void> {
  const res = await client.ping();
  if (!res.success) throw res.error;
}
