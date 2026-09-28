/**
 * A line chart for the members-over-time report (src/admin/reports.tsx): one
 * line per year laid over the same January-to-December axis, or one line
 * across every year.
 *
 * Drawn on the server as inline SVG, like the orders-by-month bars
 * (src/admin/monthChart.tsx), and for the same reasons: no charting library
 * or client bundle for the admin pages, and the page's own colours, dark mode
 * included (`.line-chart` in src/styles.ts). The table beneath it is the
 * precise version and what a screen reader is pointed at; each line carries
 * its label in a `<title>` for anyone hovering over it.
 */

import type { FC } from "hono/jsx";
import { ticks } from "./monthChart";

const WIDTH = 720;
const HEIGHT = 280;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 48 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

export interface LineSeries {
  label: string;
  /** `x` from 0 (left edge) to 1 (right edge). */
  points: { x: number; value: number }[];
}

/** Colours for the lines, oldest first; the last series is always verde. */
const PALETTE_SIZE = 6;

export const LineChart: FC<{
  series: LineSeries[];
  xLabels: { x: number; text: string }[];
  description: string;
}> = ({ series, xLabels, description }) => {
  const max = Math.max(0, ...series.flatMap((line) => line.points.map((point) => point.value)));
  const gridlines = ticks(max);
  const top = gridlines[gridlines.length - 1];
  const x = (fraction: number) => MARGIN.left + fraction * PLOT_WIDTH;
  const y = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const colour = (i: number) =>
    i === series.length - 1 ? "latest" : `series-${(series.length - 2 - i) % PALETTE_SIZE}`;

  return (
    <figure class="line-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={description}>
        {gridlines.map((value) => (
          <g class="gridline">
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(value).toFixed(1)} y2={y(value).toFixed(1)} />
            <text x={MARGIN.left - 6} y={y(value).toFixed(1)} text-anchor="end" dominant-baseline="middle">
              {value.toLocaleString("en-US")}
            </text>
          </g>
        ))}
        {xLabels.map((label) => (
          <text class="x-label" x={x(label.x).toFixed(1)} y={HEIGHT - 8} text-anchor="middle">
            {label.text}
          </text>
        ))}
        {series.map((line, i) =>
          line.points.length === 0 ? null : (
            <path
              class={`line ${colour(i)}`}
              d={line.points.map((point, n) => `${n === 0 ? "M" : "L"}${x(point.x).toFixed(1)},${y(point.value).toFixed(1)}`).join("")}
            >
              <title>{line.label}</title>
            </path>
          ),
        )}
      </svg>
      <figcaption>
        {series.map((line, i) => (
          <>
            <span class={`swatch ${colour(i)}`} /> {line.label}{" "}
          </>
        ))}
      </figcaption>
    </figure>
  );
};
