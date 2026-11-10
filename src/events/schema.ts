import { z } from "zod";

export const EVENT_TYPES = ["impression", "click", "submit", "close"] as const;
export const DEVICES = ["desktop", "mobile", "tablet"] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type Device = (typeof DEVICES)[number];

/**
 * What a popup script sends. `event_id` is generated on the client, so a
 * browser that retries a request sends the same id again. That id is what
 * makes the rest of the pipeline idempotent.
 */
export const incomingEventSchema = z.object({
  event_id: z.uuid(),
  type: z.enum(EVENT_TYPES),
  site_id: z.int().positive().max(4_294_967_295),
  campaign_id: z.int().positive().max(4_294_967_295),
  timestamp: z.union([z.iso.datetime({ offset: true }), z.int().nonnegative()]),
  device: z.enum(DEVICES),
  country: z.string().regex(/^[A-Z]{2}$/, "expected an ISO 3166-1 alpha-2 code like TR"),
});

export type IncomingEvent = z.infer<typeof incomingEventSchema>;

/** The normalized row the collector puts on the queue and the writer stores. */
export interface PopupEvent {
  event_id: string;
  event_type: EventType;
  site_id: number;
  campaign_id: number;
  /** ISO 8601 in UTC with milliseconds. */
  ts: string;
  device: Device;
  country: string;
  /** When the collector accepted the event, ISO 8601 UTC. */
  received_at: string;
}

export const popupEventSchema = z.object({
  event_id: z.uuid(),
  event_type: z.enum(EVENT_TYPES),
  site_id: z.int().positive(),
  campaign_id: z.int().positive(),
  ts: z.iso.datetime(),
  device: z.enum(DEVICES),
  country: z.string().regex(/^[A-Z]{2}$/),
  received_at: z.iso.datetime(),
});

export interface ValidationOptions {
  now: Date;
  /** Reject events older than this. Late events would land in closed days. */
  maxAgeDays: number;
  /** Allow a little client clock skew into the future. */
  maxFutureSkewMs?: number;
}

export type ParseResult =
  | { ok: true; event: PopupEvent }
  | { ok: false; issues: string[] };

export function parseIncomingEvent(input: unknown, opts: ValidationOptions): ParseResult {
  const parsed = incomingEventSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const e = parsed.data;
  const ts = new Date(e.timestamp);
  const nowMs = opts.now.getTime();
  const skew = opts.maxFutureSkewMs ?? 5 * 60_000;
  if (ts.getTime() > nowMs + skew) {
    return { ok: false, issues: ["timestamp: is in the future"] };
  }
  if (ts.getTime() < nowMs - opts.maxAgeDays * 86_400_000) {
    return { ok: false, issues: [`timestamp: is older than ${opts.maxAgeDays} days`] };
  }
  return {
    ok: true,
    event: {
      event_id: e.event_id.toLowerCase(),
      event_type: e.type,
      site_id: e.site_id,
      campaign_id: e.campaign_id,
      ts: ts.toISOString(),
      device: e.device,
      country: e.country,
      received_at: opts.now.toISOString(),
    },
  };
}
