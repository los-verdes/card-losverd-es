/**
 * The orders-by-month chart (src/admin/reports.tsx): each month's orders for
 * the chosen year beside the year before, as pairs of bars.
 *
 * Drawn on the server as inline SVG, with no charting library and no script.
 * Twenty-four bars and a handful of gridlines are a few dozen elements, and
 * a library would mean a client bundle the admin pages do not otherwise
 * have. Inline rather than an image so it takes the page's colours, dark
 * mode included, from the stylesheet (`.month-chart` in src/styles.ts).
 *
 * The table beneath it stays the precise version, and the one a screen
 * reader is pointed at: the chart is labelled as a picture of that table,
 * with each bar's exact figure in a `<title>` for anyone hovering over it.
 */

import type { FC } from "hono/jsx";
import type { MonthlyOrders } from "./reportQueries";

const WIDTH = 720;
const HEIGHT = 260;
const MARGIN = { top: 12, right: 8, bottom: 28, left: 40 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The gap between the y axis's gridlines, for a chart whose tallest bar is
 * `max` orders. Always a whole number of orders, at least 1.
 */
export function tickStep(max: number): number {
  // TODO(human): pick a "round" step. This placeholder divides by five and
  // rounds up, so a tallest bar of 62 gets gridlines at 13, 26, 39...
  return Math.max(1, Math.ceil(max / 5));
}

/** Gridline values from zero to the first one at or above `max`. */
export function ticks(max: number): number[] {
  const step = tickStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

export const MonthlyOrdersChart: FC<{ months: MonthlyOrders[]; year: number }> = ({ months, year }) => {
  const max = Math.max(0, ...months.flatMap((m) => [m.orders, m.previous_year_orders]));
  const gridlines = ticks(max);
  const top = gridlines[gridlines.length - 1];
  const y = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const band = PLOT_WIDTH / 12;
  const barWidth = band * 0.36;

  const bar = (value: number, x: number, className: string, label: string) => (
    <rect class={className} x={x.toFixed(1)} y={y(value).toFixed(1)} width={barWidth.toFixed(1)}
      height={(MARGIN.top + PLOT_HEIGHT - y(value)).toFixed(1)}>
      <title>{`${label}: ${value} ${value === 1 ? "order" : "orders"}`}</title>
    </rect>
  );

  return (
    <figure class="month-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Membership orders per month, ${year} against ${year - 1}; the same figures are in the table below.`}>
        {gridlines.map((value) => (
          <g class="gridline">
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(value).toFixed(1)} y2={y(value).toFixed(1)} />
            <text x={MARGIN.left - 6} y={y(value).toFixed(1)} text-anchor="end" dominant-baseline="middle">
              {value}
            </text>
          </g>
        ))}
        {months.map((m, i) => {
          const left = MARGIN.left + i * band + (band - barWidth * 2) / 2;
          return (
            <g>
              {bar(m.previous_year_orders, left, "previous-year", `${MONTH_ABBREVIATIONS[i]} ${year - 1}`)}
              {bar(m.orders, left + barWidth, "this-year", `${MONTH_ABBREVIATIONS[i]} ${year}`)}
              <text class="month" x={(MARGIN.left + (i + 0.5) * band).toFixed(1)} y={HEIGHT - 8} text-anchor="middle">
                {MONTH_ABBREVIATIONS[i]}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        <span class="swatch this-year" /> {year} <span class="swatch previous-year" /> {year - 1}
      </figcaption>
    </figure>
  );
};
