import type { Device, EventType, IncomingEvent } from "./schema.js";

/** mulberry32: tiny, fast and good enough for synthetic data. Same seed, same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** A v4-shaped UUID built from the seeded generator instead of crypto randomness. */
export function seededUuid(rand: () => number): string {
  const b = new Array<number>(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(rand() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => HEX[x]!);
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

export interface GeneratedEvent {
  event_id: string;
  event_type: EventType;
  site_id: number;
  campaign_id: number;
  tsMs: number;
  device: Device;
  country: string;
}

export interface GeneratorOptions {
  seed: number;
  rows: number;
  sites: number;
  campaignsPerSite: number;
  /** First day of data, UTC midnight. */
  start: Date;
  days: number;
}

const COUNTRIES: Array<[string, number]> = [
  ["US", 24], ["TR", 14], ["DE", 10], ["GB", 9], ["FR", 7], ["BR", 6],
  ["IN", 6], ["NL", 5], ["ES", 5], ["IT", 5], ["CA", 5], ["JP", 4],
];
const DEVICE_WEIGHTS: Array<[Device, number]> = [["mobile", 58], ["desktop", 36], ["tablet", 6]];

function picker<T>(items: Array<[T, number]>): (r: number) => T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  const cumulative: number[] = [];
  let acc = 0;
  for (const [, w] of items) cumulative.push((acc += w / total));
  return (r) => {
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r < cumulative[mid]!) hi = mid;
      else lo = mid + 1;
    }
    return items[lo]![0];
  };
}

interface Campaign {
  site_id: number;
  campaign_id: number;
  clickRate: number;
  submitRate: number;
}

/** Campaign ids are site_id * 100 + n, so they're readable on the dashboard. */
export function campaignId(site: number, n: number): number {
  return site * 100 + n;
}

/**
 * Yields popup "sessions": an impression, then maybe a click and a submit,
 * or a close. Campaign traffic and conversion rates differ per campaign so
 * the dashboard has something to show. Output is fully determined by the options.
 */
export function* generateEvents(opts: GeneratorOptions): Generator<GeneratedEvent> {
  const rand = mulberry32(opts.seed);
  const campaigns: Array<[Campaign, number]> = [];
  for (let s = 1; s <= opts.sites; s++) {
    for (let c = 1; c <= opts.campaignsPerSite; c++) {
      const weight = 0.2 + rand() * rand() * 4;
      campaigns.push([
        {
          site_id: s,
          campaign_id: campaignId(s, c),
          clickRate: 0.03 + rand() * 0.12,
          submitRate: 0.15 + rand() * 0.4,
        },
        weight,
      ]);
    }
  }
  const pickCampaign = picker(campaigns);
  const pickCountry = picker(COUNTRIES);
  const pickDevice = picker(DEVICE_WEIGHTS);
  const startMs = opts.start.getTime();
  const spanMs = opts.days * 86_400_000;

  let emitted = 0;
  const emit = (c: Campaign, type: EventType, tsMs: number, device: Device, country: string): GeneratedEvent => {
    emitted++;
    return {
      event_id: seededUuid(rand),
      event_type: type,
      site_id: c.site_id,
      campaign_id: c.campaign_id,
      tsMs,
      device,
      country,
    };
  };

  while (emitted < opts.rows) {
    const c = pickCampaign(rand());
    const device = pickDevice(rand());
    const country = pickCountry(rand());
    // Keep follow-up events inside the window so every row is in range.
    const ts = startMs + Math.floor(rand() * (spanMs - 120_000));
    yield emit(c, "impression", ts, device, country);
    if (emitted >= opts.rows) break;
    if (rand() < c.clickRate) {
      yield emit(c, "click", ts + 1_000 + Math.floor(rand() * 30_000), device, country);
      if (emitted >= opts.rows) break;
      if (rand() < c.submitRate) {
        yield emit(c, "submit", ts + 31_000 + Math.floor(rand() * 60_000), device, country);
      }
    } else if (rand() < 0.45) {
      yield emit(c, "close", ts + 500 + Math.floor(rand() * 15_000), device, country);
    }
  }
}

export function toIncoming(e: GeneratedEvent): IncomingEvent {
  return {
    event_id: e.event_id,
    type: e.event_type,
    site_id: e.site_id,
    campaign_id: e.campaign_id,
    timestamp: new Date(e.tsMs).toISOString(),
    device: e.device,
    country: e.country,
  };
}
