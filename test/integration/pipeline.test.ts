import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { DeleteQueueCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareReadPaths } from "../../src/checks/compare.js";
import { buildCollector } from "../../src/collector/server.js";
import { mvDaily, rawDaily } from "../../src/clickhouse/queries.js";
import { dropDatabase, migrate } from "../../src/clickhouse/schema.js";
import { ClickHouseEventStore } from "../../src/clickhouse/store.js";
import type { IncomingEvent } from "../../src/events/schema.js";
import { queueUrl, type SqsQueue } from "../../src/queue/sqs.js";
import type { Queue } from "../../src/queue/types.js";
import { BatchWriter } from "../../src/writer/writer.js";
import { config } from "../../src/config.js";
import { connectClickHouse, createTestQueue, sleep, uniqueName } from "./setup.js";

let ch: ClickHouseClient;
let sqs: SQSClient;
let queueName: string;
let queue: SqsQueue;
let db: string;
let store: ClickHouseEventStore;

const writerOpts = { maxBatch: 500, maxWaitMs: 300, pollers: 2, retries: 3, retryBaseDelayMs: 50 };

const dayAgo = (n: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - n * 86_400_000);
};
const day = (n: number) => dayAgo(n).toISOString().slice(0, 10);

function events(campaign: number, daysAgo: number, counts: Record<IncomingEvent["type"], number>): IncomingEvent[] {
  return (Object.entries(counts) as Array<[IncomingEvent["type"], number]>).flatMap(([type, n]) =>
    Array.from({ length: n }, (_, i) => ({
      event_id: randomUUID(),
      type,
      site_id: 1,
      campaign_id: campaign,
      timestamp: new Date(dayAgo(daysAgo).getTime() + i * 1000).toISOString(),
      device: "mobile" as const,
      country: "TR",
    })),
  );
}

async function post(evts: IncomingEvent[]) {
  const app = buildCollector({ queue, maxEventAgeDays: 30 });
  for (let i = 0; i < evts.length; i += 100) {
    const res = await app.inject({ method: "POST", url: "/events", payload: { events: evts.slice(i, i + 100) } });
    expect(res.statusCode).toBe(202);
  }
}

/** Runs the writer until the queue is empty. */
async function drain(q: Queue = queue) {
  const writer = new BatchWriter(q, store, writerOpts);
  const totals = { inserted: 0, duplicates: 0 };
  for (let empty = 0; empty < 2; ) {
    const r = await writer.runOnce();
    if (!r) empty++;
    else {
      totals.inserted += r.inserted;
      totals.duplicates += r.duplicates;
    }
  }
  return totals;
}

async function rawCountNoFinal(): Promise<number> {
  const rs = await ch.query({ query: `SELECT count() AS n FROM ${db}.events`, format: "JSONEachRow" });
  return Number((await rs.json<{ n: string }>())[0]!.n);
}

const filter = () => ({ from: day(3), to: day(0), siteId: 1 });

beforeAll(async () => {
  ch = await connectClickHouse();
  db = uniqueName("it_pipeline");
  await migrate(ch, db);
  store = new ClickHouseEventStore(ch, db);
  ({ sqs, name: queueName, queue } = await createTestQueue(1));
});

afterAll(async () => {
  await dropDatabase(ch, db);
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl(config.sqs.endpoint, queueName) }));
  await ch.close();
});

describe("collector -> SQS -> writer -> ClickHouse", () => {
  const first = [
    ...events(101, 2, { impression: 40, click: 8, submit: 3, close: 12 }),
    ...events(101, 1, { impression: 25, click: 4, submit: 1, close: 9 }),
    ...events(102, 1, { impression: 10, click: 1, submit: 0, close: 6 }),
  ];

  it("lands events in the raw table and the materialized view with the same numbers", async () => {
    await post(first);
    const totals = await drain();
    expect(totals).toEqual({ inserted: first.length, duplicates: 0 });

    const mv = await mvDaily(ch, db, filter());
    expect(mv).toEqual([
      { day: day(2), site_id: 1, campaign_id: 101, impressions: 40, clicks: 8, submits: 3, closes: 12 },
      { day: day(1), site_id: 1, campaign_id: 101, impressions: 25, clicks: 4, submits: 1, closes: 9 },
      { day: day(1), site_id: 1, campaign_id: 102, impressions: 10, clicks: 1, submits: 0, closes: 6 },
    ]);
    expect(await rawDaily(ch, db, filter())).toEqual(mv);
    expect((await compareReadPaths(ch, db, filter())).mismatches).toEqual([]);
  });

  it("doesn't double count when the client resends the same events", async () => {
    const before = await mvDaily(ch, db, filter());
    await post(first.slice(0, 30));
    const totals = await drain();
    expect(totals).toEqual({ inserted: 0, duplicates: 30 });
    expect(await mvDaily(ch, db, filter())).toEqual(before);
    // No duplicate rows at all, not just after FINAL.
    expect(await rawCountNoFinal()).toBe(first.length);
  });

  it("doesn't double count when SQS redelivers after a lost delete", async () => {
    const extra = events(102, 0, { impression: 15, click: 2, submit: 1, close: 4 });
    await post(extra);

    // First pass: insert works, but every delete "fails", like a crash right after the insert.
    let dropDeletes = true;
    const flaky: Queue = {
      send: (b) => queue.send(b),
      receive: (m, w) => queue.receive(m, w),
      delete: async (handles) => (dropDeletes ? handles : queue.delete(handles)),
    };
    const writer = new BatchWriter(flaky, store, writerOpts);
    const firstPass = await writer.runOnce();
    expect(firstPass).toMatchObject({ inserted: extra.length, deleted: 0 });

    // The visibility timeout (1s) runs out and the same messages come back.
    dropDeletes = false;
    await sleep(1500);
    const totals = await drain(flaky);
    expect(totals).toEqual({ inserted: 0, duplicates: extra.length });

    const mv = await mvDaily(ch, db, filter());
    expect(mv.find((r) => r.day === day(0) && r.campaign_id === 102)).toMatchObject({
      impressions: 15,
      clicks: 2,
      submits: 1,
      closes: 4,
    });
    expect(await rawCountNoFinal()).toBe(first.length + extra.length);
    expect((await compareReadPaths(ch, db, filter())).mismatches).toEqual([]);
  });

  it("the read-path check catches duplicates that bypass the writer", async () => {
    // Insert straight into ClickHouse, skipping the writer's dedupe, the way a
    // second writer or a backfill script might. The MV counts these rows on
    // insert; ReplacingMergeTree + FINAL collapses them on the raw side.
    const dupes = await ch.query({
      query: `SELECT * FROM ${db}.events WHERE campaign_id = 101 AND toDate(ts) = {d:Date} AND event_type = 'click'`,
      query_params: { d: day(2) },
      format: "JSONEachRow",
    });
    const rows = await dupes.json<Record<string, unknown>>();
    expect(rows).toHaveLength(8);
    await ch.insert({ table: `${db}.events`, values: rows, format: "JSONEachRow" });

    const result = await compareReadPaths(ch, db, filter());
    expect(result.mismatches).toEqual([
      { day: day(2), site_id: 1, campaign_id: 101, field: "clicks", raw: 8, mv: 16 },
    ]);
  });
});
