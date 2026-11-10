// All settings come from the environment. Defaults point at the ports that
// docker-compose.yml publishes on localhost, so scripts work outside Docker too.

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export const config = {
  clickhouse: {
    url: str("CLICKHOUSE_URL", "http://localhost:18123"),
    user: str("CLICKHOUSE_USER", "etc"),
    password: str("CLICKHOUSE_PASSWORD", "etc_local_only"),
    database: str("CLICKHOUSE_DATABASE", "analytics"),
  },
  sqs: {
    endpoint: str("SQS_ENDPOINT", "http://localhost:18125"),
    region: str("AWS_REGION", "us-east-1"),
    queueName: str("SQS_QUEUE", "events"),
  },
  postgres: {
    url: str("POSTGRES_URL", "postgres://etc:etc_local_only@localhost:15432/bench"),
  },
  collector: {
    port: int("COLLECTOR_PORT", 18120),
    maxEventAgeDays: int("MAX_EVENT_AGE_DAYS", 30),
  },
  writer: {
    maxBatch: int("WRITER_MAX_BATCH", 1000),
    maxWaitMs: int("WRITER_MAX_WAIT_MS", 1000),
    pollers: int("WRITER_POLLERS", 4),
    retries: int("WRITER_RETRIES", 5),
  },
  dashboard: {
    port: int("DASHBOARD_PORT", 18121),
  },
};
