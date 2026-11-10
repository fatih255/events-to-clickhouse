import { createClickHouse, pingClickHouse } from "../clickhouse/client.js";
import { migrate } from "../clickhouse/schema.js";
import { ClickHouseEventStore } from "../clickhouse/store.js";
import { config } from "../config.js";
import { createSqsClient, ensureQueue, queueUrl, SqsQueue } from "../queue/sqs.js";
import { retryUntilReady } from "../util/ready.js";
import { BatchWriter } from "./writer.js";

const log = (message: string) => console.log(`[writer] ${message}`);

// The client is created without a database so migrate() can create it first.
const ch = createClickHouse({ database: "default" });
await retryUntilReady("ClickHouse", () => pingClickHouse(ch));
await retryUntilReady("schema", () => migrate(ch, config.clickhouse.database));

const sqs = createSqsClient(config.sqs.endpoint, config.sqs.region);
await retryUntilReady("SQS", () => ensureQueue(sqs, config.sqs.queueName));

const writer = new BatchWriter(
  new SqsQueue(sqs, queueUrl(config.sqs.endpoint, config.sqs.queueName)),
  new ClickHouseEventStore(ch, config.clickhouse.database),
  { ...config.writer, log },
);

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}
log(`polling ${config.sqs.queueName}, batch up to ${config.writer.maxBatch} or ${config.writer.maxWaitMs}ms`);
await writer.run(controller.signal);
await ch.close();
