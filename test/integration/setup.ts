import { randomUUID } from "node:crypto";
import { createClickHouse, pingClickHouse } from "../../src/clickhouse/client.js";
import { config } from "../../src/config.js";
import { createSqsClient, ensureQueue, queueUrl, SqsQueue } from "../../src/queue/sqs.js";
import { retryUntilReady } from "../../src/util/ready.js";

/**
 * Integration tests run against the docker compose services
 * (`docker compose up -d clickhouse elasticmq postgres`). Every test file
 * gets its own ClickHouse database and SQS queue so runs don't interfere.
 */
export function uniqueName(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export async function connectClickHouse() {
  const ch = createClickHouse({ database: "default" });
  await retryUntilReady("ClickHouse", () => pingClickHouse(ch), 60_000);
  return ch;
}

export async function createTestQueue(visibilitySeconds = 1) {
  const sqs = createSqsClient(config.sqs.endpoint, config.sqs.region);
  const name = uniqueName("it").replace("_", "-");
  await retryUntilReady("SQS", () => ensureQueue(sqs, name, { VisibilityTimeout: String(visibilitySeconds) }), 60_000);
  return { sqs, name, queue: new SqsQueue(sqs, queueUrl(config.sqs.endpoint, name)) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
