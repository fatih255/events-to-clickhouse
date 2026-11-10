export interface Series {
  name: string;
  /** CSS color, normally a var(--series-n) token. */
  color: string;
  values: number[];
}

export interface LineChartOptions {
  /** X axis categories (YYYY-MM-DD), one per value. */
  days: string[];
  series: Series[];
  format: (v: number) => string;
  label: string;
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Rounds up to 1, 2 or 5 times a power of ten so the axis has clean ticks. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  for (const m of [1, 2, 2.5, 5, 10]) if (value <= m * exp) return m * exp;
  return 10 * exp;
}

const shortDay = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** Server-rendered SVG line chart: thin lines, recessive grid, direct labels, hover titles. */
export function lineChart(opts: LineChartOptions): string {
  const W = 1000;
  const H = 260;
  const m = { l: 64, r: 130, t: 12, b: 30 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = opts.days.length;
  const max = niceMax(Math.max(0, ...opts.series.flatMap((s) => s.values)));
  const x = (i: number) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => m.t + ih - (v / max) * ih;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(t)}" y2="${y(t)}" class="grid"/>` +
        `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" class="tick">${escapeHtml(opts.format(t))}</text>`,
    )
    .join("");
  const step = n > 10 ? 2 : 1;
  const xLabels = opts.days
    .map((d, i) =>
      i % step === 0 || i === n - 1
        ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="tick">${escapeHtml(shortDay(d))}</text>`
        : "",
    )
    .join("");

  const lines = opts.series
    .map((s) => {
      const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      const hits = s.values
        .map(
          (v, i) =>
            `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="9" class="hit" style="--c:${s.color}">` +
            `<title>${escapeHtml(`${s.name}, ${shortDay(opts.days[i]!)}: ${opts.format(v)}`)}</title></circle>`,
        )
        .join("");
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${hits}`;
    })
    .join("");

  // Direct labels at the line ends, nudged apart so they don't overlap.
  const ends = opts.series
    .map((s) => ({ s, y: y(s.values.at(-1) ?? 0) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i]!.y - ends[i - 1]!.y < 15) ends[i]!.y = ends[i - 1]!.y + 15;
  }
  const labels = ends
    .map(
      ({ s, y: ly }) =>
        `<circle cx="${m.l + iw + 12}" cy="${ly}" r="4" fill="${s.color}"/>` +
        `<text x="${m.l + iw + 22}" y="${ly + 4}" class="direct">${escapeHtml(s.name)}</text>`,
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(opts.label)}" class="chart">${grid}${xLabels}${lines}${labels}</svg>`;
}
