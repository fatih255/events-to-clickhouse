import { describe, expect, it } from "vitest";
import { collectBatch } from "../../src/writer/batch.js";
import type { Queue, QueueMessage } from "../../src/queue/types.js";
import { MemoryQueue } from "../helpers/memory-queue.js";

describe("collectBatch", () => {
  it("flushes on size: stops once maxBatch messages are collected", async () => {
    const queue = new MemoryQueue();
    await queue.send(Array.from({ length: 500 }, (_, i) => `m${i}`));
    const batch = await collectBatch(queue, { maxBatch: 100, maxWaitMs: 5_000, pollers: 1 });
    expect(batch).toHaveLength(100);
    // The rest are still waiting.
    expect((await collectBatch(queue, { maxBatch: 1000, maxWaitMs: 100, pollers: 1 })).length).toBe(400);
  });

  it("flushes on time: returns what it has when maxWaitMs runs out", async () => {
    // A slow trickle: one message every 20ms.
    let sent = 0;
    const trickle: Queue = {
      send: async () => {},
      delete: async () => [],
      receive: async (): Promise<QueueMessage[]> => {
        await new Promise((r) => setTimeout(r, 20));
        sent++;
        return [{ id: `m${sent}`, receiptHandle: `h${sent}`, body: "{}", receiveCount: 1 }];
      },
    };
    const started = Date.now();
    const batch = await collectBatch(trickle, { maxBatch: 1000, maxWaitMs: 150, pollers: 1 });
    const took = Date.now() - started;
    expect(batch.length).toBeGreaterThan(2);
    expect(batch.length).toBeLessThan(1000);
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1000);
  });

  it("returns an empty batch when the queue stays empty", async () => {
    const batch = await collectBatch(new MemoryQueue(), { maxBatch: 10, maxWaitMs: 60, pollers: 2 });
    expect(batch).toEqual([]);
  });

  it("uses several pollers without receiving a message twice", async () => {
    const queue = new MemoryQueue();
    await queue.send(Array.from({ length: 95 }, (_, i) => `m${i}`));
    const batch = await collectBatch(queue, { maxBatch: 95, maxWaitMs: 2_000, pollers: 4 });
    expect(new Set(batch.map((m) => m.id)).size).toBe(95);
  });

  it("never asks SQS for more than 10 messages per call", async () => {
    const asked: number[] = [];
    const queue = new MemoryQueue();
    await queue.send(Array.from({ length: 25 }, (_, i) => `m${i}`));
    const spy: Queue = {
      send: (b) => queue.send(b),
      delete: (h) => queue.delete(h),
      receive: (max, wait) => {
        asked.push(max);
        return queue.receive(max, wait);
      },
    };
    await collectBatch(spy, { maxBatch: 25, maxWaitMs: 1_000, pollers: 1 });
    expect(Math.max(...asked)).toBeLessThanOrEqual(10);
    expect(asked.at(-1)).toBe(5);
  });
});
