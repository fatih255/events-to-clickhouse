import type { Variant } from "./queries.js";

export interface BenchResults {
  measured_at: string;
  note: string;
  machine: { cpu: string; logical_cores: number; ram_gb: number; os: string; docker: string };
  versions: { clickhouse: string; postgres: string };
  dataset: { rows: number; seed: number; sites: number; campaigns: number; days: number };
  runs_per_query: number;
  load: {
    clickhouse_insert_ms: number;
    clickhouse_optimize_ms: number;
    postgres_copy_ms: number;
    postgres_index_ms: number;
    postgres_rollup_ms: number;
  };
  storage: {
    clickhouse_events_bytes: number;
    clickhouse_rollup_bytes: number;
    postgres_events_bytes: number;
    postgres_rollup_bytes: number;
    rollup_rows: number;
  };
  queries: Array<{
    id: string;
    title: string;
    rows_returned: number;
    timings: Partial<Record<Variant, { median_ms: number; min_ms: number }>>;
    sql: Partial<Record<Variant, string>>;
  }>;
}

export const VARIANT_LABELS: Record<Variant, string> = {
  ch_raw: "ClickHouse raw (FINAL)",
  ch_mv: "ClickHouse MV",
  pg_raw: "Postgres raw",
  pg_mv: "Postgres matview",
};

export const VARIANTS: Variant[] = ["ch_raw", "ch_mv", "pg_raw", "pg_mv"];

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms).toLocaleString("en-US")} ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(2)} GiB`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(0)} MiB`;
  return `${(bytes / 2 ** 10).toFixed(0)} KiB`;
}

export function renderMarkdown(r: BenchResults): string {
  const lines = [
    `Local benchmark on synthetic data: ${r.dataset.rows.toLocaleString("en-US")} rows, ${r.dataset.campaigns} campaigns, ${r.dataset.days} days.`,
    `${r.machine.cpu}, ${r.machine.ram_gb} GB RAM, ${r.machine.os}. Docker: ${r.machine.docker}.`,
    `ClickHouse ${r.versions.clickhouse}, Postgres ${r.versions.postgres}. Median of ${r.runs_per_query} runs after one warm-up, timed from Node (ClickHouse over HTTP, Postgres over its wire protocol).`,
    "",
    `| Query | ${VARIANTS.map((v) => VARIANT_LABELS[v]).join(" | ")} |`,
    `|---|${VARIANTS.map(() => "--:").join("|")}|`,
    ...r.queries.map((q) => `| ${q.title} | ${VARIANTS.map((v) => formatMs(q.timings[v]?.median_ms)).join(" | ")} |`),
    "",
    "| Load and storage | ClickHouse | Postgres |",
    "|---|--:|--:|",
    `| Load | ${formatMs(r.load.clickhouse_insert_ms)} insert + ${formatMs(r.load.clickhouse_optimize_ms)} OPTIMIZE | ${formatMs(r.load.postgres_copy_ms)} COPY + ${formatMs(r.load.postgres_index_ms)} indexes |`,
    `| Raw events on disk | ${formatBytes(r.storage.clickhouse_events_bytes)} | ${formatBytes(r.storage.postgres_events_bytes)} (with indexes) |`,
    `| Daily rollup | ${formatBytes(r.storage.clickhouse_rollup_bytes)} | ${formatBytes(r.storage.postgres_rollup_bytes)} |`,
    "",
  ];
  return lines.join("\n");
}
