import Fastify, { type FastifyInstance } from "fastify";
import { parseIncomingEvent } from "../events/schema.js";
import type { Queue } from "../queue/types.js";

export interface CollectorOptions {
  queue: Queue;
  maxEventAgeDays: number;
  /** Max events per request. Popup scripts batch a few events per beacon. */
  maxEventsPerRequest?: number;
  now?: () => Date;
  logger?: boolean;
}

/**
 * POST /events accepts one event or { events: [...] }. Valid events go to the
 * queue; invalid ones are reported back by index and dropped. The response is
 * 202 because nothing is in ClickHouse yet, only on the queue.
 */
export function buildCollector(opts: CollectorOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });
  const maxEvents = opts.maxEventsPerRequest ?? 100;
  const now = opts.now ?? (() => new Date());

  app.get("/health", async () => ({ ok: true }));

  app.post("/events", async (request, reply) => {
    const body = request.body as unknown;
    const items: unknown[] =
      body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
        ? (body as { events: unknown[] }).events
        : [body];

    if (items.length === 0 || items.length > maxEvents) {
      return reply.code(400).send({ error: `send between 1 and ${maxEvents} events per request` });
    }

    const at = now();
    const accepted: string[] = [];
    const rejected: Array<{ index: number; issues: string[] }> = [];
    items.forEach((item, index) => {
      const result = parseIncomingEvent(item, { now: at, maxAgeDays: opts.maxEventAgeDays });
      if (result.ok) accepted.push(JSON.stringify(result.event));
      else rejected.push({ index, issues: result.issues });
    });

    if (accepted.length === 0) {
      return reply.code(400).send({ accepted: 0, rejected });
    }
    try {
      await opts.queue.send(accepted);
    } catch (error) {
      request.log.error({ err: error }, "queue send failed");
      // The client keeps its event_ids and retries; the writer dedupes.
      return reply.code(503).send({ error: "queue unavailable, retry later" });
    }
    return reply.code(202).send({ accepted: accepted.length, rejected });
  });

  return app;
}
