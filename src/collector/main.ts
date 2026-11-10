import { config } from "../config.js";
import { createSqsClient, ensureQueue, queueUrl, SqsQueue } from "../queue/sqs.js";
import { retryUntilReady } from "../util/ready.js";
import { buildCollector } from "./server.js";

const sqs = createSqsClient(config.sqs.endpoint, config.sqs.region);
// The queue is declared in docker/elasticmq.conf; this just checks it's reachable.
await retryUntilReady("SQS", () => ensureQueue(sqs, config.sqs.queueName));
const queue = new SqsQueue(sqs, queueUrl(config.sqs.endpoint, config.sqs.queueName));

const app = buildCollector({ queue, maxEventAgeDays: config.collector.maxEventAgeDays, logger: true });
await app.listen({ host: "0.0.0.0", port: config.collector.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
