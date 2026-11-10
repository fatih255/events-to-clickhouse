import { popupEventSchema, type PopupEvent } from "../events/schema.js";
import type { Queue, QueueMessage } from "../queue/types.js";
import { collectBatch, type CollectOptions } from "./batch.js";
import { dedupeWithinBatch, withoutStored } from "./dedupe.js";
import { withRetry } from "./retry.js";

/** Where events end up. ClickHouse in production, a Map in unit tests. */
export interface EventStore {
  /** Returns which of these ids are already stored. */
  storedIds(ids: string[]): Promise<Set<string>>;
  insert(events: PopupEvent[]): Promise<void>;
}

export interface WriterOptions extends CollectOptions {
  retries: number;
  retryBaseDelayMs?: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface BatchResult {
  received: number;
  invalid: number;
  /** Events skipped because they were already stored or repeated in the batch. */
  duplicates: number;
  inserted: number;
  deleted: number;
  /** True when the insert failed after all retries. Nothing was deleted. */
  failed: boolean;
}

export class BatchWriter {
  constructor(
    private readonly queue: Queue,
    private readonly store: EventStore,
    private readonly opts: WriterOptions,
  ) {}

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** Collects one batch and writes it. Returns null when the queue was empty. */
  async runOnce(): Promise<BatchResult | null> {
    const messages = await collectBatch(this.queue, this.opts);
    if (messages.length === 0) return null;
    return this.processBatch(messages);
  }

  async processBatch(messages: QueueMessage[]): Promise<BatchResult> {
    const valid: Array<{ message: QueueMessage; event: PopupEvent }> = [];
    let invalid = 0;
    for (const message of messages) {
      const event = parseMessage(message.body);
      if (event) valid.push({ message, event });
      else {
        // Not deleted on purpose: after maxReceiveCount SQS moves it to the DLQ,
        // where someone can look at it.
        invalid++;
        this.log(`invalid message ${message.id} (receive #${message.receiveCount}), leaving it for the DLQ`);
      }
    }

    const unique = dedupeWithinBatch(valid.map((v) => v.event));
    let inserted: number;
    try {
      // The lookup is inside the retry on purpose. If an insert timed out but
      // actually landed, the next attempt sees those ids and skips them.
      inserted = await withRetry(
        async () => {
          const stored = await this.store.storedIds(unique.map((e) => e.event_id));
          const fresh = withoutStored(unique, stored);
          if (fresh.length > 0) await this.store.insert(fresh);
          return fresh.length;
        },
        {
          attempts: this.opts.retries,
          baseDelayMs: this.opts.retryBaseDelayMs ?? 200,
          sleep: this.opts.sleep,
          onRetry: (error, attempt, delayMs) =>
            this.log(`insert attempt ${attempt} failed (${String(error)}), retrying in ${delayMs}ms`),
        },
      );
    } catch (error) {
      // Leave every message on the queue. They come back after the visibility
      // timeout and the dedupe above keeps the second try from double counting.
      this.log(`insert failed after ${this.opts.retries} attempts: ${String(error)}`);
      return { received: messages.length, invalid, duplicates: 0, inserted: 0, deleted: 0, failed: true };
    }

    // Only now is it safe to delete. Duplicates get deleted too; they're stored already.
    const handles = valid.map((v) => v.message.receiptHandle);
    const failedDeletes = await this.queue.delete(handles);
    if (failedDeletes.length > 0) {
      this.log(`${failedDeletes.length} deletes failed; those messages will be redelivered and skipped`);
    }
    return {
      received: messages.length,
      invalid,
      duplicates: valid.length - inserted,
      inserted,
      deleted: handles.length - failedDeletes.length,
      failed: false,
    };
  }

  /** Runs until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.runOnce();
        if (result) {
          this.log(
            `batch: received=${result.received} inserted=${result.inserted} duplicates=${result.duplicates} invalid=${result.invalid}${result.failed ? " FAILED" : ""}`,
          );
        }
      } catch (error) {
        // Queue errors (ElasticMQ restarting, network). Back off and keep going.
        this.log(`writer loop error: ${String(error)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

function parseMessage(body: string): PopupEvent | null {
  try {
    const parsed = popupEventSchema.safeParse(JSON.parse(body));
    return parsed.success ? (parsed.data as PopupEvent) : null;
  } catch {
    return null;
  }
}
