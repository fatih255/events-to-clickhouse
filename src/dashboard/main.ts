import { createClickHouse, pingClickHouse } from "../clickhouse/client.js";
import { migrate } from "../clickhouse/schema.js";
import { config } from "../config.js";
import { retryUntilReady } from "../util/ready.js";
import { buildDashboard } from "./server.js";

const ch = createClickHouse({ database: "default" });
await retryUntilReady("ClickHouse", () => pingClickHouse(ch));
// Safe to run alongside the writer: every statement is IF NOT EXISTS.
await retryUntilReady("schema", () => migrate(ch, config.clickhouse.database));

const app = buildDashboard({
  ch,
  database: config.clickhouse.database,
  benchResultsPath: process.env.BENCH_RESULTS ?? "bench/results.json",
});
await app.listen({ host: "0.0.0.0", port: config.dashboard.port });
console.log(`dashboard on http://localhost:${config.dashboard.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
