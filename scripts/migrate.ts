// Creates the ClickHouse database, tables and materialized view. The writer
// also runs this on startup, so you only need it when working without Docker.
import { createClickHouse } from "../src/clickhouse/client.js";
import { migrate } from "../src/clickhouse/schema.js";
import { config } from "../src/config.js";

const ch = createClickHouse({ database: "default" });
await migrate(ch, config.clickhouse.database);
console.log(`migrated ${config.clickhouse.database}`);
await ch.close();
