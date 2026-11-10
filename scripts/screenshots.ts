// Captures the dashboard and benchmark pages from the running app.
// Needs `docker compose up` (or `npm run dashboard`) first.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.DASHBOARD_URL ?? "http://localhost:18121";
const pages = [
  { path: "/?site=1", file: "docs/screenshots/dashboard.png" },
  { path: "/bench", file: "docs/screenshots/benchmark.png" },
];

mkdirSync("docs/screenshots", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", deviceScaleFactor: 1 });
const page = await context.newPage();
for (const p of pages) {
  await page.goto(base + p.path, { waitUntil: "networkidle" });
  await page.screenshot({ path: p.file, fullPage: true });
  console.log(`saved ${p.file}`);
}
await browser.close();
