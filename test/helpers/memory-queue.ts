import type { Queue, QueueMessage } from "../../src/queue/types.js";

interface Stored {
  id: string;
  body: string;
  receiveCount: number;
  invisibleUntil: number;
  handle: string | null;
}

/**
 * In-memory queue with SQS-like visibility timeouts, for unit tests.
 * A message that isn't deleted comes back after `visibilityMs`.
 */
export class MemoryQueue implements Queue {
  private messages: Stored[] = [];
  private seq = 0;

  constructor(
    private readonly visibilityMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async send(bodies: string[]): Promise<void> {
    for (const body of bodies) {
      this.messages.push({ id: `m${++this.seq}`, body, receiveCount: 0, invisibleUntil: 0, handle: null });
    }
  }

  async receive(max: number, _waitSeconds: number): Promise<QueueMessage[]> {
    const t = this.now();
    const out: QueueMessage[] = [];
    for (const m of this.messages) {
      if (out.length >= Math.min(max, 10)) break;
      if (m.invisibleUntil > t) continue;
      m.receiveCount++;
      m.invisibleUntil = t + this.visibilityMs;
      m.handle = `${m.id}:${m.receiveCount}`;
      out.push({ id: m.id, receiptHandle: m.handle, body: m.body, receiveCount: m.receiveCount });
    }
    return out;
  }

  async delete(receiptHandles: string[]): Promise<string[]> {
    const handles = new Set(receiptHandles);
    const before = new Set(this.messages.map((m) => m.handle));
    const failed = receiptHandles.filter((h) => !before.has(h));
    this.messages = this.messages.filter((m) => m.handle === null || !handles.has(m.handle));
    return failed;
  }

  /** Makes every in-flight message visible again, as if the visibility timeout ran out. */
  expireVisibility(): void {
    for (const m of this.messages) m.invisibleUntil = 0;
  }

  get size(): number {
    return this.messages.length;
  }
}
