import type { ClickHouseClient } from "@clickhouse/client";
import type { PopupEvent } from "../events/schema.js";
import type { EventStore } from "../writer/writer.js";
import { ident } from "./schema.js";

export class ClickHouseEventStore implements EventStore {
  private readonly table: string;

  constructor(
    private readonly client: ClickHouseClient,
    database: string,
  ) {
    this.table = `${ident(database)}.events`;
  }

  async storedIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    // The bloom filter index on event_id lets ClickHouse skip most granules here.
    const rs = await this.client.query({
      query: `SELECT DISTINCT toString(event_id) AS id FROM ${this.table} WHERE event_id IN {ids:Array(UUID)}`,
      query_params: { ids },
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ id: string }>();
    return new Set(rows.map((r) => r.id));
  }

  async insert(events: PopupEvent[]): Promise<void> {
    await this.client.insert({
      table: this.table,
      values: events,
      format: "JSONEachRow",
      // Synchronous insert: when this resolves the rows are visible, so the
      // writer can delete the messages and the next storedIds() sees them.
      clickhouse_settings: { async_insert: 0, date_time_input_format: "best_effort" },
    });
  }
}
