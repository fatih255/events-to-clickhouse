import type { PopupEvent } from "../events/schema.js";

/** Keeps the first copy of each event_id. Clients retry, so one batch can hold the same event twice. */
export function dedupeWithinBatch(events: PopupEvent[]): PopupEvent[] {
  const seen = new Set<string>();
  const out: PopupEvent[] = [];
  for (const e of events) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    out.push(e);
  }
  return out;
}

/** Drops events whose id is already stored. */
export function withoutStored(events: PopupEvent[], storedIds: ReadonlySet<string>): PopupEvent[] {
  return events.filter((e) => !storedIds.has(e.event_id));
}
