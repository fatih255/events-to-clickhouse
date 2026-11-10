import type { Queue, QueueMessage } from "../queue/types.js";

export interface CollectOptions {
  /** Flush when this many messages are collected. */
  maxBatch: number;
  /** ...or when this much time has passed since collection started, whichever comes first. */
  maxWaitMs: number;
  /** Parallel ReceiveMessage loops. SQS gives at most 10 messages per call. */
  pollers: number;
}

/**
 * Collects one batch from the queue. Size-based and time-based at once: it
 * stops as soon as `maxBatch` messages are in hand or `maxWaitMs` runs out.
 * Returns an empty array when the queue stayed empty for the whole window.
 */
export async function collectBatch(queue: Queue, opts: CollectOptions): Promise<QueueMessage[]> {
  const deadline = Date.now() + opts.maxWaitMs;
  const batch: QueueMessage[] = [];

  const poll = async (): Promise<void> => {
    while (batch.length < opts.maxBatch) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const want = Math.min(10, opts.maxBatch - batch.length);
      // Long polling is in whole seconds; 0 means "return right away".
      const waitSeconds = Math.min(20, Math.floor(remainingMs / 1000));
      const messages = await queue.receive(want, waitSeconds);
      if (messages.length === 0 && waitSeconds === 0) {
        // Short poll came back empty; don't spin.
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(0, deadline - Date.now()))));
      }
      batch.push(...messages);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.pollers) }, poll));
  // Pollers that were mid-receive when the batch filled can overshoot a little;
  // that's fine, those messages just ride along in this batch.
  return batch;
}
