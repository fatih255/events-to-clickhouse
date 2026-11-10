import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Queue, QueueMessage } from "./types.js";

const SQS_BATCH = 10;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createSqsClient(endpoint: string, region: string): SQSClient {
  return new SQSClient({
    endpoint,
    region,
    // ElasticMQ ignores credentials, but the SDK insists on having some.
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

/** ElasticMQ accepts any account id in the path; 000000000000 is the usual local one. */
export function queueUrl(endpoint: string, name: string): string {
  return `${endpoint.replace(/\/$/, "")}/000000000000/${name}`;
}

export async function ensureQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string> = {},
): Promise<void> {
  await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
}

export class SqsQueue implements Queue {
  constructor(
    private readonly client: SQSClient,
    private readonly url: string,
  ) {}

  async send(bodies: string[]): Promise<void> {
    await Promise.all(
      chunks(bodies, SQS_BATCH).map(async (batch) => {
        let entries = batch.map((body, i) => ({ Id: String(i), MessageBody: body }));
        // SendMessageBatch can partly fail; retry only the failed entries.
        for (let attempt = 0; attempt < 3 && entries.length > 0; attempt++) {
          const res = await this.client.send(
            new SendMessageBatchCommand({ QueueUrl: this.url, Entries: entries }),
          );
          const failed = new Set((res.Failed ?? []).map((f) => f.Id));
          entries = entries.filter((e) => failed.has(e.Id));
        }
        if (entries.length > 0) throw new Error(`SQS rejected ${entries.length} messages`);
      }),
    );
  }

  async receive(max: number, waitSeconds: number): Promise<QueueMessage[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: Math.min(max, SQS_BATCH),
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    return (res.Messages ?? []).map((m) => ({
      id: m.MessageId ?? "",
      receiptHandle: m.ReceiptHandle ?? "",
      body: m.Body ?? "",
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? "1"),
    }));
  }

  async delete(receiptHandles: string[]): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      chunks(receiptHandles, SQS_BATCH).map(async (batch) => {
        const res = await this.client.send(
          new DeleteMessageBatchCommand({
            QueueUrl: this.url,
            Entries: batch.map((h, i) => ({ Id: String(i), ReceiptHandle: h })),
          }),
        );
        for (const f of res.Failed ?? []) failed.push(batch[Number(f.Id)]!);
      }),
    );
    return failed;
  }
}
