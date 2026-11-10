import type { ClickHouseClient } from "@clickhouse/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexPostgres, loadClickHouse, loadPostgres, optimizeClickHouse, rollupPostgres } from "../../src/bench/load.js";
import { benchDataset, benchQueries, normalizeRows, type Variant } from "../../src/bench/queries.js";
import { compareReadPaths } from "../../src/checks/compare.js";
import { dropDatabase } from "../../src/clickhouse/schema.js";
import { config } from "../../src/config.js";
import { retryUntilReady } from "../../src/util/ready.js";
import { connectClickHouse, uniqueName } from "./setup.js";

// The same loaders and queries as `npm run bench`, on a small dataset, in
// throwaway databases. Checks that both engines and both read paths give
// identical answers.
const ROWS = 200_000;

let ch: ClickHouseClient;
let admin: pg.Client;
let client: pg.Client;
const chDb = uniqueName("it_bench");
const pgDb = uniqueName("it_bench");

beforeAll(async () => {
  ch = await connectClickHouse();
  // A pg.Client can only connect once, so each attempt gets a fresh one.
  await retryUntilReady(
    "Postgres",
    async () => {
      const c = new pg.Client({ connectionString: config.postgres.url });
      try {
        await c.connect();
      } catch (error) {
        await c.end().catch(() => {});
        throw error;
      }
      admin = c;
    },
    60_000,
  );
  await admin.query(`CREATE DATABASE ${pgDb}`);
  const url = new URL(config.postgres.url);
  url.pathname = `/${pgDb}`;
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();

  const dataset = benchDataset(ROWS);
  await loadClickHouse(ch, chDb, dataset, 50_000);
  await optimizeClickHouse(ch, chDb);
  await loadPostgres(client, dataset);
  await indexPostgres(client);
  await rollupPostgres(client);
});

afterAll(async () => {
  await client?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${pgDb}`);
  await admin?.end();
  await dropDatabase(ch, chDb);
  await ch.close();
});

describe("benchmark dataset", () => {
  it("loads the same row count into both databases", async () => {
    const rs = await ch.query({ query: `SELECT count() AS n FROM ${chDb}.events`, format: "JSONEachRow" });
    expect(Number((await rs.json<{ n: string }>())[0]!.n)).toBe(ROWS);
    expect(Number((await client.query("SELECT count(*) AS n FROM events")).rows[0].n)).toBe(ROWS);
  });

  it("raw events and the materialized view agree after a bulk load", async () => {
    const result = await compareReadPaths(ch, chDb, { from: "2026-07-01", to: "2026-09-30" });
    expect(result.keys).toBeGreaterThan(1000);
    expect(result.mismatches).toEqual([]);
  });

  for (const q of benchQueries(chDb)) {
    it(`${q.id}: every engine and read path returns the same rows`, async () => {
      const answers: Partial<Record<Variant, string[]>> = {};
      for (const [variant, sql] of Object.entries(q.sql) as Array<[Variant, string]>) {
        const rows = variant.startsWith("ch")
          ? await (await ch.query({ query: sql, format: "JSONEachRow" })).json<Record<string, unknown>>()
          : (await client.query(sql)).rows;
        answers[variant] = normalizeRows(rows);
      }
      const [first, ...rest] = Object.values(answers);
      expect(first!.length).toBeGreaterThan(0);
      for (const other of rest) expect(other).toEqual(first);
    });
  }
});
