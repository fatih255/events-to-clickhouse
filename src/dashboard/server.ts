import { readFile } from "node:fs/promises";
import type { ClickHouseClient } from "@clickhouse/client";
import Fastify, { type FastifyInstance } from "fastify";
import type { BenchResults } from "../bench/results.js";
import { compareReadPaths } from "../checks/compare.js";
import { dataRange, mvDaily } from "../clickhouse/queries.js";
import { ident } from "../clickhouse/schema.js";
import { renderBench, renderDashboard, renderEmpty } from "./render.js";

export interface DashboardOptions {
  ch: ClickHouseClient;
  database: string;
  benchResultsPath: string;
  days?: number;
}

export function buildDashboard(opts: DashboardOptions): FastifyInstance {
  const app = Fastify();
  const db = ident(opts.database);
  const days = opts.days ?? 14;

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Querystring: { site?: string } }>("/", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    const range = await dataRange(opts.ch, db);
    if (!range) return renderEmpty(db);

    const sitesRs = await opts.ch.query({
      query: `SELECT DISTINCT site_id FROM ${db}.campaign_daily ORDER BY site_id`,
      format: "JSONEachRow",
    });
    const sites = (await sitesRs.json<{ site_id: number }>()).map((r) => Number(r.site_id));
    const requested = Number(request.query.site);
    const siteId = sites.includes(requested) ? requested : sites[0]!;

    const to = range.max;
    const fromMs = Math.max(Date.parse(`${range.min}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000);
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const filter = { from, to, siteId };
    const [rows, check] = await Promise.all([mvDaily(opts.ch, db, filter), compareReadPaths(opts.ch, db, filter)]);
    return renderDashboard({ database: db, sites, siteId, from, to, rows, check });
  });

  app.get("/bench", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    let results: BenchResults | null;
    try {
      results = JSON.parse(await readFile(opts.benchResultsPath, "utf8")) as BenchResults;
    } catch {
      results = null;
    }
    return renderBench(results);
  });

  return app;
}
