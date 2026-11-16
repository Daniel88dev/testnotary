import type { ReactNode } from "react";
import type { Overview, OverviewDay } from "../../../src/server/overview.ts";
import { day as dayName, dur } from "../_lib/format.ts";
import { short } from "./history.tsx";

// The Overview's daily chart, drawn on the server as SVG in the product's own colours: cyan for
// skips, amber for everything that ran (audits hatched, fallbacks solid, a mismatch solid), shadow
// results outlined. No chart library and nothing from another origin. Each day has a hover title
// over its whole column, and the numbers are in a table under the chart.

export const METRICS = ["saved", "jobs", "audits"] as const;
export type Metric = (typeof METRICS)[number];

export const CHART_TITLES: Record<Metric, string> = {
  saved: "Test time saved per day",
  jobs: "Test jobs per day by result",
  audits: "Audits and shadow comparisons per day",
};

interface Series {
  key: string;
  label: string;
  /** SVG fill/stroke for the mark. */
  mark: { fill: string; stroke?: string };
  swatch: string;
  value: (day: OverviewDay) => number;
}

const MIN = 60_000;

const SERIES: Record<Metric, Series[]> = {
  saved: [{ key: "saved", label: "Test time saved", mark: { fill: "var(--skip)" }, swatch: "skip", value: (d) => d.savedMs / MIN }],
  jobs: [
    { key: "skip", label: "Skipped", mark: { fill: "var(--skip)" }, swatch: "skip", value: (d) => d.jobs.skip },
    { key: "audit", label: "Audited", mark: { fill: "url(#tn-hatch)", stroke: "var(--run)" }, swatch: "audit", value: (d) => d.jobs.audit },
    { key: "fallback", label: "Ran", mark: { fill: "var(--run)" }, swatch: "run", value: (d) => d.jobs.fallback },
    { key: "would_skip", label: "Would have skipped", mark: { fill: "var(--surface)", stroke: "var(--skip)" }, swatch: "wskip", value: (d) => d.jobs.would_skip },
    {
      key: "would_fall_back",
      label: "Would have fallen back",
      mark: { fill: "var(--surface)", stroke: "var(--run)" },
      swatch: "wrun",
      value: (d) => d.jobs.would_fall_back,
    },
  ],
  audits: [
    { key: "agreed", label: "Agreed", mark: { fill: "url(#tn-hatch)", stroke: "var(--run)" }, swatch: "audit", value: (d) => d.agreed },
    { key: "mismatch", label: "Mismatch", mark: { fill: "var(--run)" }, swatch: "run", value: (d) => d.mismatched },
  ],
};

/** A clean axis: 4 or 5 steps of 1, 2 or 5 × 10^k covering `max`. */
function axis(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * power).find((candidate) => candidate >= raw)!;
  const whole = Math.max(1, step);
  return { top: Math.ceil(max / whole) * whole, step: whole };
}

const minutes = (value: number) => (value >= 120 ? `${Math.round(value / 60)} h` : `${Math.round(value)} m`);

const dayLabel = (day: Date, index: number, count: number) => (index === count - 1 ? "Today" : dayName(day));

/** A bar segment: square at the bottom, 4 px rounded at the top when it ends the bar. */
function segment(x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ""}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ""}V${y + h}Z`;
}

export function OverviewChart({ overview, metric }: { overview: Overview; metric: Metric }) {
  const series = SERIES[metric];
  const days = overview.days;
  const W = 760;
  const H = 230;
  const L = 40;
  const B = 26;
  const T = 22;
  const totals = days.map((day) => series.reduce((sum, s) => sum + s.value(day), 0));
  const { top, step } = axis(Math.max(...totals));
  const y = (value: number) => T + (H - T - B) * (1 - value / top);
  const slot = (W - L) / days.length;
  const barW = Math.min(24, Math.max(2, slot * 0.7));
  const labelEvery = Math.ceil(days.length / 8);
  const format = (value: number) => (metric === "saved" ? dur(value * 60) : String(value));

  const grid: ReactNode[] = [];
  for (let tick = 0; tick <= top + 1e-9; tick += step) {
    grid.push(
      <g key={`g${tick}`}>
        <line x1={L} x2={W} y1={y(tick)} y2={y(tick)} stroke="var(--grid)" strokeWidth={1} />
        <text className="tick" x={L - 8} y={y(tick) + 4} textAnchor="end">
          {metric === "saved" ? minutes(tick) : tick}
        </text>
      </g>,
    );
  }

  const bars: ReactNode[] = [];
  days.forEach((day, index) => {
    const x = L + index * slot + (slot - barW) / 2;
    let below = 0;
    const present = series.filter((s) => s.value(day) > 0);
    present.forEach((s, at) => {
      const value = s.value(day);
      const y0 = y(below);
      const y1 = y(below + value);
      // A 2 px surface gap above every segment but the top one.
      const gap = at < present.length - 1 ? 2 : 0;
      const h = Math.max(1, y0 - y1 - gap);
      const outlined = s.mark.fill === "var(--surface)";
      bars.push(
        <path
          key={`${index}-${s.key}`}
          d={segment(x + (outlined ? 0.75 : 0), y1 + gap, barW - (outlined ? 1.5 : 0), h - (outlined ? 0.75 : 0), at === present.length - 1)}
          fill={s.mark.fill}
          stroke={s.mark.stroke}
          strokeWidth={s.mark.stroke ? (outlined ? 1.5 : 1) : undefined}
        />,
      );
      below += value;
    });
    // The hover target is the whole column, wider than the bar.
    const title = `${dayLabel(day.day, index, days.length)}: ${series.map((s) => `${format(s.value(day))} ${s.label.toLowerCase()}`).join(", ")}`;
    bars.push(
      <rect key={`hit${index}`} className="hit" x={L + index * slot} y={T} width={slot} height={H - T - B} fill="transparent">
        <title>{title}</title>
      </rect>,
    );
  });

  const labels = days.map((day, index) =>
    // Counted back from today, so "Today" never collides with the label before it.
    (days.length - 1 - index) % labelEvery === 0 ? (
      <text key={`l${index}`} className="tick" x={L + index * slot + slot / 2} y={H - 6} textAnchor="middle">
        {dayLabel(day.day, index, days.length)}
      </text>
    ) : null,
  );

  // Mismatches the service recorded: a vertical amber rule at the moment, on the jobs and audits charts.
  const first = days[0]!.day.getTime();
  const notes =
    metric === "saved"
      ? []
      : overview.mismatches.map((mismatch, index) => {
          const mx = L + ((mismatch.at.getTime() - first) / 86_400_000) * slot;
          return (
            <g key={`m${index}`}>
              <line x1={mx} x2={mx} y1={T - 6} y2={H - B} stroke="var(--run)" strokeWidth={1} />
              <text className="tick note" x={mx - 6} y={T - 10} textAnchor="end">
                Mismatch on {short(mismatch.commit)}
              </text>
            </g>
          );
        });

  return (
    <>
      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={CHART_TITLES[metric]}>
          <defs>
            <pattern id="tn-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2" height="4" fill="var(--run)" />
            </pattern>
          </defs>
          {grid}
          {bars}
          {notes}
          {labels}
        </svg>
      </div>
      {series.length > 1 ? (
        <div className="legend" style={{ marginTop: 10 }}>
          {series.map((s) => (
            <span key={s.key}>
              <i className={`sw ${s.swatch}`} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <details className="chart-table">
        <summary>Numbers per day</summary>
        <div className="tbl-wrap">
          <table className="tbl" aria-label="Per day">
            <thead>
              <tr>
                <th>Day</th>
                {series.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((day, reversed) => {
                const index = days.length - 1 - reversed;
                return (
                  <tr key={day.day.toISOString()}>
                    <td>{dayLabel(day.day, index, days.length)}</td>
                    {series.map((s) => (
                      <td key={s.key} className="num">
                        {format(s.value(day))}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
