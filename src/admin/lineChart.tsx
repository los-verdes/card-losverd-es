/**
 * The line charts on the membership-over-time report (src/admin/reports.tsx):
 * one line per year laid over the same January-to-December axis, or one line
 * across every year.
 *
 * Drawn on the server as inline SVG, with no charting library and no script:
 * a library would mean a client bundle the admin pages do not otherwise have.
 * Inline rather than an image, so it takes the page's colours, dark mode
 * included (`.line-chart` in src/styles.ts). The table beneath it is the
 * precise version and what a screen reader is pointed at; each line carries
 * its label in a `<title>` for anyone hovering over it.
 */

import type { FC } from "hono/jsx";

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

/**
 * The gap between the y axis's gridlines, for a chart whose tallest value is
 * `max`: a round number (1, 2 or 5 times a power of ten) giving about five
 * gridlines, so a tallest value of 62 gets lines at 20, 40, 60 and a member
 * count of 2,100 at 500, 1,000 and so on. Always a whole number, at least 1.
 */
export function tickStep(max: number): number {
  const rough = max / 5;
  if (rough <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const round = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return round * magnitude;
}

/** Gridline values from zero to the first one at or above `max`. */
export function ticks(max: number): number[] {
  const step = tickStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

/** Colours for the lines, oldest first; the last series is always verde. */
const PALETTE_SIZE = 6;

/**
 * The colour class for series `i` of `count`: the latest is verde, earlier
 * ones walk back through the palette. Shared with the bar chart
 * (src/admin/barChart.tsx), so a year is the same colour on both charts.
 */
export function seriesColour(i: number, count: number): string {
  return i === count - 1 ? "latest" : `series-${(count - 2 - i) % PALETTE_SIZE}`;
}

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
  const colour = (i: number) => seriesColour(i, series.length);

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
