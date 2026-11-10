// Computes the daily per-campaign aggregate twice, from raw events and from the
// materialized view, and reports every (day, site, campaign, field) where they differ.
// Exits 1 on any mismatch so it can run in CI or cron.
//
//   npm run check:read-paths
//   npm run check:read-paths -- --db bench --from 2026-07-01 --to 2026-09-30
import { parseArgs } from "node:util";
import { formatComparison, compareReadPaths } from "../src/checks/compare.js";
import { createClickHouse } from "../src/clickhouse/client.js";
import { dataRange } from "../src/clickhouse/queries.js";
import { config } from "../src/config.js";

const { values } = parseArgs({
  options: {
    db: { type: "string", default: config.clickhouse.database },
    from: { type: "string" },
    to: { type: "string" },
    site: { type: "string" },
  },
});

const db = values.db!;
const ch = createClickHouse({ database: db });
const range = await dataRange(ch, db);
if (!range) {
  console.log(`no data in ${db}.campaign_daily yet`);
  await ch.close();
  process.exit(0);
}
const filter = {
  from: values.from ?? range.min,
  to: values.to ?? range.max,
  siteId: values.site ? Number(values.site) : undefined,
};
console.log(`comparing ${db}.events (FINAL) with ${db}.campaign_daily, ${filter.from}..${filter.to}`);
const t0 = performance.now();
const result = await compareReadPaths(ch, db, filter);
console.log(formatComparison(result));
console.log(`took ${Math.round(performance.now() - t0)} ms`);
await ch.close();
process.exit(result.mismatches.length === 0 ? 0 : 1);
