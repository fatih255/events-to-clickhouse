import { describe, expect, it } from "vitest";
import { dedupeWithinBatch, withoutStored } from "../../src/writer/dedupe.js";
import { withRetry } from "../../src/writer/retry.js";
import { BatchWriter } from "../../src/writer/writer.js";
import { makeEvent, MemoryStore } from "../helpers/fixtures.js";
import { MemoryQueue } from "../helpers/memory-queue.js";

const noSleep = async () => {};
const opts = { maxBatch: 100, maxWaitMs: 50, pollers: 1, retries: 3, sleep: noSleep };

function setup() {
  const queue = new MemoryQueue();
  const store = new MemoryStore();
  const writer = new BatchWriter(queue, store, opts);
  return { queue, store, writer };
}

describe("dedupe helpers", () => {
  it("keeps the first copy of each event_id in a batch", () => {
    const a = makeEvent();
    const b = makeEvent();
    expect(dedupeWithinBatch([a, b, { ...a, received_at: "later" }, b])).toEqual([a, b]);
  });

  it("drops events that are already stored", () => {
    const a = makeEvent();
    const b = makeEvent();
    expect(withoutStored([a, b], new Set([a.event_id]))).toEqual([b]);
  });
});

describe("withRetry", () => {
  it("retries until it succeeds", async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        if (++calls < 3) throw new Error("nope");
        return "ok";
      },
      { attempts: 5, baseDelayMs: 1, sleep: noSleep },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the last attempt with the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { attempts: 3, baseDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow("fail 3");
    expect(calls).toBe(3);
  });

  it("backs off exponentially, capped", async () => {
    const delays: number[] = [];
    await withRetry(
      async (attempt) => {
        if (attempt < 6) throw new Error("x");
      },
      { attempts: 6, baseDelayMs: 100, maxDelayMs: 1000, sleep: async (ms) => void delays.push(ms) },
    );
    // Full jitter in [cap/2, cap], cap = 100, 200, 400, 800, 1000.
    const caps = [100, 200, 400, 800, 1000];
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(caps[i]! / 2);
      expect(d).toBeLessThanOrEqual(caps[i]!);
    });
  });
});

describe("BatchWriter", () => {
  it("inserts a batch and deletes the messages afterwards", async () => {
    const { queue, store, writer } = setup();
    const events = [makeEvent(), makeEvent({ event_type: "click" }), makeEvent({ event_type: "submit" })];
    await queue.send(events.map((e) => JSON.stringify(e)));

    const result = await writer.runOnce();
    expect(result).toMatchObject({ received: 3, inserted: 3, duplicates: 0, deleted: 3, failed: false });
    expect(store.rows.size).toBe(3);
    expect(queue.size).toBe(0);
  });

  it("does not double count a redelivered message", async () => {
    const { queue, store, writer } = setup();
    const e = makeEvent();
    // The same event twice in the queue (client retry), then again later (SQS redelivery).
    await queue.send([JSON.stringify(e), JSON.stringify(e)]);
    expect(await writer.runOnce()).toMatchObject({ inserted: 1, duplicates: 1 });
    await queue.send([JSON.stringify(e)]);
    expect(await writer.runOnce()).toMatchObject({ inserted: 0, duplicates: 1, deleted: 1 });
    expect(store.inserted).toHaveLength(1);
    expect(queue.size).toBe(0);
  });

  it("keeps messages on the queue when every insert attempt fails, then recovers without duplicates", async () => {
    const { queue, store, writer } = setup();
    const events = [makeEvent(), makeEvent()];
    await queue.send(events.map((e) => JSON.stringify(e)));
    store.failNext = 3;

    expect(await writer.runOnce()).toMatchObject({ failed: true, deleted: 0 });
    expect(store.insertCalls).toBe(3);
    expect(queue.size).toBe(2);

    // Visibility timeout runs out and SQS hands them out again.
    queue.expireVisibility();
    expect(await writer.runOnce()).toMatchObject({ inserted: 2, failed: false });
    expect(store.inserted).toHaveLength(2);
    expect(queue.size).toBe(0);
  });

  it("re-checks stored ids on retry when an insert landed but reported an error", async () => {
    const { queue, store, writer } = setup();
    const events = [makeEvent(), makeEvent(), makeEvent()];
    await queue.send(events.map((e) => JSON.stringify(e)));
    store.failAfterWriteNext = 1;

    const result = await writer.runOnce();
    expect(result).toMatchObject({ failed: false, deleted: 3 });
    // The first insert landed. The retry looked the ids up, found all three
    // and skipped the insert, so each row was written once.
    expect(store.insertCalls).toBe(1);
    expect(store.inserted).toHaveLength(3);
  });

  it("leaves invalid messages for the dead-letter queue and writes the rest", async () => {
    const { queue, store, writer } = setup();
    await queue.send(["not json", JSON.stringify({ hello: "world" }), JSON.stringify(makeEvent())]);
    const result = await writer.runOnce();
    expect(result).toMatchObject({ received: 3, invalid: 2, inserted: 1, deleted: 1 });
    expect(store.rows.size).toBe(1);
    expect(queue.size).toBe(2);
  });

  it("returns null when the queue is empty", async () => {
    const { writer } = setup();
    expect(await writer.runOnce()).toBeNull();
  });
});
