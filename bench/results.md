Local benchmark on synthetic data: 10,000,000 rows, 200 campaigns, 92 days.
Intel(R) Core(TM) i7-14700KF, 32 GB RAM, Windows_NT 10.0.26200. Docker: 28 CPUs, 15.5 GiB memory.
ClickHouse 25.8.33.6, Postgres 17.6. Median of 7 runs after one warm-up, timed from Node (ClickHouse over HTTP, Postgres over its wire protocol).

| Query | ClickHouse raw (FINAL) | ClickHouse MV | Postgres raw | Postgres matview |
|---|--:|--:|--:|--:|
| Daily metrics per campaign, one site, 30 days | 6.8 ms | 4.1 ms | 129 ms | 1.3 ms |
| Top 10 campaigns by conversion rate, all 92 days | 67 ms | 3.9 ms | 152 ms | 2.0 ms |
| Events by country and device, last 7 days, all sites | 8.5 ms | - | 145 ms | - |
| Hourly events for one campaign on one day | 3.7 ms | - | 0.9 ms | - |

| Load and storage | ClickHouse | Postgres |
|---|--:|--:|
| Load | 31,087 ms insert + 1,941 ms OPTIMIZE | 25,182 ms COPY + 20,290 ms indexes |
| Raw events on disk | 281 MiB | 1.58 GiB (with indexes) |
| Daily rollup | 215 KiB | 2 MiB |
