// Sends two weeks of synthetic popup traffic through the collector.
// The seed is today's date, so running it twice on the same day sends the
// same event_ids again, and the dashboard numbers shouldn't move.
import { generateEvents, toIncoming } from "../src/events/generator.js";
import type { IncomingEvent } from "../src/events/schema.js";
import { retryUntilReady } from "../src/util/ready.js";

const collectorUrl = process.env.COLLECTOR_URL ?? "http://localhost:18120";
const rows = Number(process.env.DEMO_EVENTS ?? 150_000);
const days = 14;
const perRequest = 25;
const concurrency = 8;
/** Share of requests sent a second time, like a beacon retried after a timeout. */
const repeatShare = 0.05;

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const start = new Date(today.getTime() - days * 86_400_000);
const seed = Number(today.toISOString().slice(0, 10).replaceAll("-", ""));

const events = [...generateEvents({ seed, rows, sites: 3, campaignsPerSite: 4, start, days })].map(toIncoming);
const requests: IncomingEvent[][] = [];
for (let i = 0; i < events.length; i += perRequest) requests.push(events.slice(i, i + perRequest));

// Deterministic choice of which requests get repeated.
const repeated = requests.filter((_, i) => (i * 2654435761) % 1000 < repeatShare * 1000);
const queue = [...requests, ...repeated];

await retryUntilReady("collector", async () => {
  const res = await fetch(`${collectorUrl}/health`);
  if (!res.ok) throw new Error(`status ${res.status}`);
});

let accepted = 0;
let next = 0;
async function worker(): Promise<void> {
  while (next < queue.length) {
    const batch = queue[next++]!;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${collectorUrl}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
      if (res.status === 202) {
        accepted += ((await res.json()) as { accepted: number }).accepted;
        break;
      }
      if (attempt >= 5) throw new Error(`collector returned ${res.status}: ${await res.text()}`);
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const seconds = ((performance.now() - t0) / 1000).toFixed(1);
console.log(
  `sent ${events.length} unique events in ${requests.length} requests, plus ${repeated.length} repeated requests ` +
    `(${accepted} events accepted by the collector, ${accepted - events.length} of them repeats) in ${seconds}s`,
);
