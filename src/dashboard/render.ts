import type { Comparison } from "../checks/compare.js";
import { clickThroughRate, conversionRate, type DailyRow } from "../clickhouse/queries.js";
import { formatBytes, formatMs, VARIANT_LABELS, VARIANTS, type BenchResults } from "../bench/results.js";
import { escapeHtml, lineChart } from "./chart.js";

const SERIES = 4;

const STYLE = `
:root {
  color-scheme: light;
  --surface: #fcfcfb; --panel: #ffffff; --border: #e4e3df;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #77766f;
  --grid: #ecebe7; --accent: #2a78d6;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --good: #0f7b3e; --good-bg: #e7f5ec; --critical: #b42318; --critical-bg: #fdecea;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19; --panel: #222220; --border: #3a3a37;
    --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #9a998f;
    --grid: #33332f; --accent: #3987e5;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --good: #5fd08f; --good-bg: #16301f; --critical: #ff8a80; --critical-bg: #3a1a17;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text-primary);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1160px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 4px; }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 16px; margin: 0 0 12px; }
nav a { color: var(--text-secondary); text-decoration: none; margin-left: 16px; }
nav a[aria-current="page"] { color: var(--text-primary); font-weight: 600; }
.sub { color: var(--text-secondary); margin: 0 0 20px; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
.pill { padding: 4px 12px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary); text-decoration: none; background: var(--panel); }
.pill[aria-current="page"] { border-color: var(--accent); color: var(--text-primary); font-weight: 600; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile .k { color: var(--text-secondary); font-size: 13px; }
.tile .v { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.status { display: flex; gap: 10px; align-items: flex-start; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; }
.status.good { background: var(--good-bg); color: var(--good); }
.status.critical { background: var(--critical-bg); color: var(--critical); }
.status p { margin: 0; color: var(--text-primary); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; color: var(--text-secondary); font-size: 13px; margin-bottom: 4px; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--c); margin-right: 6px; }
.chart { width: 100%; height: auto; display: block; }
.chart .grid { stroke: var(--grid); stroke-width: 1; }
.chart .tick { fill: var(--text-muted); font-size: 12px; }
.chart .direct { fill: var(--text-secondary); font-size: 13px; }
.chart .hit { fill: transparent; }
.chart .hit:hover { fill: var(--c); fill-opacity: .25; stroke: var(--c); stroke-width: 2; }
.charts { display: grid; grid-template-columns: 1fr; gap: 16px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--text-secondary); font-weight: 600; font-size: 13px; }
.scroll { overflow-x: auto; }
.muted { color: var(--text-muted); font-size: 13px; }
details { margin-top: 8px; }
pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-x: auto; font-size: 12px; }
code { font-size: 13px; }
td.best { font-weight: 700; }
`;

function layout(title: string, active: "dashboard" | "bench", body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
  <h1>events-to-clickhouse <span class="muted">demo page</span></h1>
  <nav>
    <a href="/" ${active === "dashboard" ? 'aria-current="page"' : ""}>Campaign dashboard</a>
    <a href="/bench" ${active === "bench" ? 'aria-current="page"' : ""}>ClickHouse vs Postgres</a>
  </nav>
</header>
${body}
</main>
</body>
</html>`;
}

const int = (n: number) => n.toLocaleString("en-US");
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export interface DashboardData {
  database: string;
  sites: number[];
  siteId: number;
  from: string;
  to: string;
  rows: DailyRow[];
  check: Comparison;
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function renderEmpty(database: string): string {
  return layout(
    "Campaign dashboard",
    "dashboard",
    `<div class="panel"><h2>No events yet</h2><p>${escapeHtml(database)}.campaign_daily is empty. Send some traffic with <code>npm run traffic</code> (or <code>docker compose up</code>, which runs the <code>demo-traffic</code> service) and reload.</p></div>`,
  );
}

export function renderDashboard(d: DashboardData): string {
  const days = daysBetween(d.from, d.to);
  const campaigns = [...new Set(d.rows.map((r) => r.campaign_id))].sort((a, b) => a - b);

  const totals = campaigns.map((id) => {
    const rs = d.rows.filter((r) => r.campaign_id === id);
    const sum = (f: "impressions" | "clicks" | "submits" | "closes") => rs.reduce((s, r) => s + r[f], 0);
    return { id, impressions: sum("impressions"), clicks: sum("clicks"), submits: sum("submits"), closes: sum("closes") };
  });
  const all = totals.reduce(
    (a, t) => ({ impressions: a.impressions + t.impressions, clicks: a.clicks + t.clicks, submits: a.submits + t.submits }),
    { impressions: 0, clicks: 0, submits: 0 },
  );

  // Colors follow campaign id order, so a campaign keeps its color across pages.
  const charted = campaigns.slice(0, SERIES);
  const seriesFor = (metric: (r: DailyRow) => number) =>
    charted.map((id, i) => ({
      name: `Campaign ${id}`,
      color: `var(--series-${i + 1})`,
      values: days.map((day) => {
        const r = d.rows.find((x) => x.campaign_id === id && x.day === day);
        return r ? metric(r) : 0;
      }),
    }));
  const legend = `<div class="legend">${charted
    .map((id, i) => `<span style="--c:var(--series-${i + 1})">Campaign ${id}</span>`)
    .join("")}</div>`;
  const more = campaigns.length > SERIES ? `<p class="muted">Charts show the first ${SERIES} campaigns; the table has all of them.</p>` : "";

  const check =
    d.check.mismatches.length === 0
      ? `<div class="status good" role="status"><strong>&#10003; Read paths agree</strong><p>Raw <code>events FINAL</code> and the <code>campaign_daily</code> materialized view give the same counts for all ${d.check.keys} day/campaign rows on this page.</p></div>`
      : `<div class="status critical" role="status"><strong>&#9888; Read paths disagree</strong><p>${d.check.mismatches.length} differences between raw events and the materialized view. Run <code>npm run check:read-paths</code> for the full list.</p></div>`;

  const body = `
<p class="sub">Daily per-campaign metrics from ClickHouse (<code>${escapeHtml(d.database)}.campaign_daily</code>), ${escapeHtml(d.from)} to ${escapeHtml(d.to)} UTC. Synthetic events sent through the collector and SQS by <code>scripts/demo-traffic.ts</code>.</p>
<div class="row">${d.sites
    .map((s) => `<a class="pill" href="/?site=${s}" ${s === d.siteId ? 'aria-current="page"' : ""}>Site ${s}</a>`)
    .join("")}</div>
${check}
<div class="tiles">
  <div class="panel tile"><div class="k">Impressions</div><div class="v">${int(all.impressions)}</div></div>
  <div class="panel tile"><div class="k">Clicks</div><div class="v">${int(all.clicks)}</div></div>
  <div class="panel tile"><div class="k">Submits</div><div class="v">${int(all.submits)}</div></div>
  <div class="panel tile"><div class="k">Conversion rate (submits / impressions)</div><div class="v">${pct(conversionRate(all))}</div></div>
</div>
<div class="charts">
  <div class="panel"><h2>Impressions per day</h2>${legend}${lineChart({ days, series: seriesFor((r) => r.impressions), format: (v) => int(Math.round(v)), label: "Impressions per day by campaign" })}</div>
  <div class="panel"><h2>Conversion rate per day</h2>${legend}${lineChart({ days, series: seriesFor((r) => conversionRate(r)), format: (v) => `${(v * 100).toFixed(1)}%`, label: "Conversion rate per day by campaign" })}${more}</div>
</div>
<div class="panel scroll">
  <h2>Campaign totals</h2>
  <table>
    <thead><tr><th>Campaign</th><th>Impressions</th><th>Clicks</th><th>CTR</th><th>Submits</th><th>Conversion rate</th><th>Closes</th></tr></thead>
    <tbody>${totals
      .map(
        (t) =>
          `<tr><td>Campaign ${t.id}</td><td>${int(t.impressions)}</td><td>${int(t.clicks)}</td><td>${pct(clickThroughRate(t))}</td><td>${int(t.submits)}</td><td>${pct(conversionRate(t))}</td><td>${int(t.closes)}</td></tr>`,
      )
      .join("")}</tbody>
  </table>
</div>`;
  return layout("Campaign dashboard", "dashboard", body);
}

export function renderBench(r: BenchResults | null): string {
  if (!r) {
    return layout(
      "ClickHouse vs Postgres",
      "bench",
      `<div class="panel"><h2>No benchmark results yet</h2><p>Run <code>npm run bench</code> with the compose services up. It writes <code>bench/results.json</code>, which this page reads.</p></div>`,
    );
  }
  const rowsTable = r.queries
    .map((q) => {
      const times = VARIANTS.map((v) => q.timings[v]?.median_ms);
      const best = Math.min(...times.filter((t): t is number => t !== undefined));
      return `<tr><td>${escapeHtml(q.title)}</td>${times
        .map((t) => `<td${t === best ? ' class="best"' : ""}>${formatMs(t)}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  const sql = r.queries
    .map(
      (q) =>
        `<details><summary>${escapeHtml(q.title)}: SQL</summary>${VARIANTS.filter((v) => q.sql[v])
          .map((v) => `<p class="muted">${VARIANT_LABELS[v]}</p><pre>${escapeHtml(q.sql[v]!)}</pre>`)
          .join("")}</details>`,
    )
    .join("");

  const body = `
<p class="sub">Local benchmark on synthetic data. ${int(r.dataset.rows)} seeded events (${r.dataset.campaigns} campaigns, ${r.dataset.sites} sites, ${r.dataset.days} days), loaded into both databases running in Docker on one machine. Every variant returned the same rows before it was timed.</p>
<div class="panel scroll">
  <h2>Query time, median of ${r.runs_per_query} runs</h2>
  <table>
    <thead><tr><th>Query</th>${VARIANTS.map((v) => `<th>${VARIANT_LABELS[v]}</th>`).join("")}</tr></thead>
    <tbody>${rowsTable}</tbody>
  </table>
  <p class="muted">Bold is the fastest variant per row. "-" means that read path doesn't apply (the rollup has no country, device or hour). Timed from Node, so each number includes the round trip: plain HTTP for ClickHouse, the wire protocol for Postgres.</p>
  ${sql}
</div>
<div class="panel scroll">
  <h2>Load and storage</h2>
  <table>
    <thead><tr><th></th><th>ClickHouse</th><th>Postgres</th></tr></thead>
    <tbody>
      <tr><td>Bulk load</td><td>${formatMs(r.load.clickhouse_insert_ms)} insert (MV filled during insert)</td><td>${formatMs(r.load.postgres_copy_ms)} COPY</td></tr>
      <tr><td>After load</td><td>${formatMs(r.load.clickhouse_optimize_ms)} OPTIMIZE FINAL</td><td>${formatMs(r.load.postgres_index_ms)} indexes + VACUUM ANALYZE, ${formatMs(r.load.postgres_rollup_ms)} matview</td></tr>
      <tr><td>Raw events on disk</td><td>${formatBytes(r.storage.clickhouse_events_bytes)} compressed</td><td>${formatBytes(r.storage.postgres_events_bytes)} incl. 3 indexes</td></tr>
      <tr><td>Daily rollup (${int(r.storage.rollup_rows)} rows)</td><td>${formatBytes(r.storage.clickhouse_rollup_bytes)}</td><td>${formatBytes(r.storage.postgres_rollup_bytes)}</td></tr>
    </tbody>
  </table>
</div>
<div class="panel">
  <h2>Setup</h2>
  <p>${escapeHtml(r.machine.cpu)}, ${r.machine.logical_cores} logical cores, ${r.machine.ram_gb} GB RAM, ${escapeHtml(r.machine.os)}. Docker: ${escapeHtml(r.machine.docker)}.<br>
  ClickHouse ${escapeHtml(r.versions.clickhouse)}, default settings. Postgres ${escapeHtml(r.versions.postgres)} with the settings in <code>docker-compose.yml</code>. Measured ${escapeHtml(r.measured_at.slice(0, 10))}.</p>
</div>`;
  return layout("ClickHouse vs Postgres", "bench", body);
}
