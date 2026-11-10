// Loads the same seeded synthetic dataset into ClickHouse and Postgres, runs
// the same queries on both, checks the answers match, and writes
// bench/results.json + bench/results.md.
//
//   npm run bench                 # 10M rows
//   BENCH_ROWS=1000000 npm run bench
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import pg from "pg";
import { createClickHouse } from "../src/clickhouse/client.js";
import { config } from "../src/config.js";
import { indexPostgres, loadClickHouse, loadPostgres, optimizeClickHouse, rollupPostgres } from "../src/bench/load.js";
import { benchDataset, benchQueries, normalizeRows, type Variant } from "../src/bench/queries.js";
import { renderMarkdown, type BenchResults } from "../src/bench/results.js";

const rows = Number(process.env.BENCH_ROWS ?? 10_000_000);
const runs = Number(process.env.BENCH_RUNS ?? 7);
const CH_DB = "bench";
const dataset = benchDataset(rows);

const ch = createClickHouse({ database: "default" });
const pgClient = new pg.Client({ connectionString: config.postgres.url });
await pgClient.connect();

async function timed<T>(label: string, fn: () => Promise<T>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(`${label}: ${(ms / 1000).toFixed(1)}s`);
  return ms;
}

console.log(`dataset: ${rows.toLocaleString("en-US")} rows, seed ${dataset.seed}`);
const load = {
  clickhouse_insert_ms: await timed("ClickHouse insert (incl. materialized view)", () => loadClickHouse(ch, CH_DB, dataset)),
  clickhouse_optimize_ms: await timed("ClickHouse OPTIMIZE FINAL", () => optimizeClickHouse(ch, CH_DB)),
  postgres_copy_ms: await timed("Postgres COPY", () => loadPostgres(pgClient, dataset)),
  postgres_index_ms: await timed("Postgres indexes + VACUUM ANALYZE", () => indexPostgres(pgClient)),
  postgres_rollup_ms: await timed("Postgres materialized view", () => rollupPostgres(pgClient)),
};

// Timed queries go over ClickHouse's HTTP interface with plain fetch. On the
// Windows machine used for the README numbers, @clickhouse/client added a
// steady ~14 ms per call (server-side duration ~3 ms), which would have
// measured the client rather than the database.
const chAuth = "Basic " + Buffer.from(`${config.clickhouse.user}:${config.clickhouse.password}`).toString("base64");
async function runCh(sql: string): Promise<Array<Record<string, unknown>>> {
  // use_query_cache is off by default; set it explicitly so nothing is cached between runs.
  const res = await fetch(`${config.clickhouse.url}/?use_query_cache=0`, {
    method: "POST",
    headers: { authorization: chAuth },
    body: `${sql}\nFORMAT JSONEachRow`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
async function runPg(sql: string): Promise<Array<Record<string, unknown>>> {
  return (await pgClient.query(sql)).rows;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const queries: BenchResults["queries"] = [];
for (const q of benchQueries(CH_DB)) {
  const timings: BenchResults["queries"][number]["timings"] = {};
  let reference: string[] | null = null;
  for (const [variant, sql] of Object.entries(q.sql) as Array<[Variant, string]>) {
    const exec = variant.startsWith("ch") ? runCh : runPg;
    const first = normalizeRows(await exec(sql)); // warm-up run, also used for the answer check
    if (reference === null) reference = first;
    else if (JSON.stringify(reference) !== JSON.stringify(first)) {
      console.error(`${q.id}: ${variant} returned different rows`, { expected: reference.slice(0, 5), got: first.slice(0, 5) });
      process.exit(1);
    }
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await exec(sql);
      samples.push(performance.now() - t0);
    }
    timings[variant] = { median_ms: median(samples), min_ms: Math.min(...samples) };
  }
  queries.push({ id: q.id, title: q.title, rows_returned: reference?.length ?? 0, timings, sql: q.sql });
  console.log(q.id, JSON.stringify(timings));
}

const [chSize] = await (
  await ch.query({
    query: `SELECT
      sumIf(data_compressed_bytes, table = 'events') AS events_bytes,
      sumIf(data_compressed_bytes, table = 'campaign_daily') AS rollup_bytes,
      sumIf(rows, table = 'campaign_daily') AS rollup_rows
    FROM system.parts WHERE database = '${CH_DB}' AND active`,
    format: "JSONEachRow",
  })
).json<{ events_bytes: string; rollup_bytes: string; rollup_rows: string }>();
const pgSize = (
  await pgClient.query(
    `SELECT pg_total_relation_size('events') AS events_bytes, pg_total_relation_size('campaign_daily') AS rollup_bytes`,
  )
).rows[0] as { events_bytes: string; rollup_bytes: string };

const [chVersion] = await (await ch.query({ query: "SELECT version() AS v", format: "JSONEachRow" })).json<{ v: string }>();
const pgVersion = (await pgClient.query("SHOW server_version")).rows[0].server_version as string;

function dockerResources(): string {
  try {
    const [cpus, mem] = execFileSync("docker", ["info", "--format", "{{.NCPU}} {{.MemTotal}}"], { encoding: "utf8" }).trim().split(" ");
    return `${cpus} CPUs, ${(Number(mem) / 2 ** 30).toFixed(1)} GiB memory`;
  } catch {
    return "unknown";
  }
}

const results: BenchResults = {
  measured_at: new Date().toISOString(),
  note: "Local benchmark on synthetic data. Both databases run in Docker on the same machine.",
  machine: {
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    logical_cores: os.cpus().length,
    ram_gb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`,
    docker: dockerResources(),
  },
  versions: { clickhouse: chVersion?.v ?? "unknown", postgres: pgVersion },
  dataset: { rows, seed: dataset.seed, sites: dataset.sites, campaigns: dataset.sites * dataset.campaignsPerSite, days: dataset.days },
  runs_per_query: runs,
  load,
  storage: {
    clickhouse_events_bytes: Number(chSize?.events_bytes ?? 0),
    clickhouse_rollup_bytes: Number(chSize?.rollup_bytes ?? 0),
    postgres_events_bytes: Number(pgSize.events_bytes),
    postgres_rollup_bytes: Number(pgSize.rollup_bytes),
    rollup_rows: Number(chSize?.rollup_rows ?? 0),
  },
  queries,
};

mkdirSync("bench", { recursive: true });
writeFileSync("bench/results.json", JSON.stringify(results, null, 2) + "\n");
writeFileSync("bench/results.md", renderMarkdown(results));
console.log("\n" + renderMarkdown(results));
await pgClient.end();
await ch.close();
