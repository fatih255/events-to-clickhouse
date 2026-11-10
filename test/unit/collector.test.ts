import { describe, expect, it } from "vitest";
import { buildCollector } from "../../src/collector/server.js";
import type { Queue } from "../../src/queue/types.js";
import { MemoryQueue } from "../helpers/memory-queue.js";

const now = new Date("2026-11-10T12:00:00.000Z");
const event = (i: number, patch: Record<string, unknown> = {}) => ({
  event_id: `6f1c2a8e-3b4d-4c5e-9f60-${String(i).padStart(12, "0")}`,
  type: "impression",
  site_id: 1,
  campaign_id: 101,
  timestamp: "2026-11-10T11:00:00Z",
  device: "desktop",
  country: "US",
  ...patch,
});

function setup(queue: Queue = new MemoryQueue()) {
  return { queue, app: buildCollector({ queue, maxEventAgeDays: 30, now: () => now, maxEventsPerRequest: 5 }) };
}

describe("collector", () => {
  it("accepts a single event and queues the normalized row", async () => {
    const queue = new MemoryQueue();
    const { app } = setup(queue);
    const res = await app.inject({ method: "POST", url: "/events", payload: event(1) });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, rejected: [] });
    const [msg] = await queue.receive(10, 0);
    expect(JSON.parse(msg!.body)).toMatchObject({ event_type: "impression", ts: "2026-11-10T11:00:00.000Z" });
  });

  it("queues the valid events of a batch and reports the invalid ones by index", async () => {
    const queue = new MemoryQueue();
    const { app } = setup(queue);
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { events: [event(1), event(2, { type: "hover" }), event(3)] },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].index).toBe(1);
    expect(queue.size).toBe(2);
  });

  it("returns 400 when nothing in the request is valid", async () => {
    const { app, queue } = setup();
    const res = await app.inject({ method: "POST", url: "/events", payload: { events: [event(1, { country: "usa" })] } });
    expect(res.statusCode).toBe(400);
    expect((queue as MemoryQueue).size).toBe(0);
  });

  it("limits the number of events per request", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { events: Array.from({ length: 6 }, (_, i) => event(i)) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when the queue is down so the client retries", async () => {
    const broken: Queue = {
      send: async () => {
        throw new Error("connection refused");
      },
      receive: async () => [],
      delete: async () => [],
    };
    const { app } = setup(broken);
    const res = await app.inject({ method: "POST", url: "/events", payload: event(1) });
    expect(res.statusCode).toBe(503);
  });
});
