import type { PopupEvent } from "../../src/events/schema.js";
import type { EventStore } from "../../src/writer/writer.js";

let n = 0;

/** A valid normalized event with a fresh id unless one is given. */
export function makeEvent(patch: Partial<PopupEvent> = {}): PopupEvent {
  n++;
  const hex = n.toString(16).padStart(12, "0");
  return {
    event_id: `00000000-0000-4000-8000-${hex}`,
    event_type: "impression",
    site_id: 1,
    campaign_id: 101,
    ts: "2026-11-09T10:00:00.000Z",
    device: "desktop",
    country: "DE",
    received_at: "2026-11-09T10:00:01.000Z",
    ...patch,
  };
}

/** EventStore backed by a Map, with switches to make inserts fail. */
export class MemoryStore implements EventStore {
  readonly rows = new Map<string, PopupEvent>();
  insertCalls = 0;
  /** Number of upcoming insert calls that throw. */
  failNext = 0;
  /** Simulates "insert landed but the response was lost": stores, then throws. */
  failAfterWriteNext = 0;
  /** Every row ever inserted, including duplicates, like an MV would see them. */
  readonly inserted: PopupEvent[] = [];

  async storedIds(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }

  async insert(events: PopupEvent[]): Promise<void> {
    this.insertCalls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("ClickHouse unavailable");
    }
    for (const e of events) this.rows.set(e.event_id, e);
    this.inserted.push(...events);
    if (this.failAfterWriteNext > 0) {
      this.failAfterWriteNext--;
      throw new Error("socket hang up");
    }
  }
}
