/**
 * The membership-orders chart on the membership-over-time report
 * (src/admin/reports.tsx): orders are counts per month, which read best as
 * bars. Each group is a month; within it, one bar per series, one per year.
 *
 * Drawn on the server as inline SVG like the line charts beside it
 * (src/admin/lineChart.tsx), and sharing their gridlines, styles and series
 * colours, so a year is the same colour on both. The table beneath it is the
 * precise version and what a screen reader is pointed at; each bar carries
 * its exact figure in a `<title>` for anyone hovering over it.
 */

import type { FC } from "hono/jsx";
import { seriesColour, ticks } from "./lineChart";

const WIDTH = 720;
const HEIGHT = 280;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 48 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

/** The share of each group's width its bars take; the rest is the gap between groups. */
const GROUP_FILL = 0.8;

export interface BarGroup {
  /** Shown under the axis; empty for none, as on most months of the timeline. */
  label: string;
  /** Names the group in each bar's tooltip, e.g. "Mar" or "Mar 2024". */
  title: string;
}

export interface BarSeries {
  label: string;
  /** One per group; null draws no bar, as for a month still to come. */
  values: (number | null)[];
}

export const BarChart: FC<{
  groups: BarGroup[];
  series: BarSeries[];
  /** Singular and plural for the tooltip, e.g. ["order", "orders"]. */
  unit: [string, string];
  description: string;
}> = ({ groups, series, unit, description }) => {
  const max = Math.max(0, ...series.flatMap((each) => each.values.map((value) => value ?? 0)));
  const gridlines = ticks(max);
  const top = gridlines[gridlines.length - 1];
  const y = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const band = PLOT_WIDTH / Math.max(groups.length, 1);
  const barWidth = (band * GROUP_FILL) / Math.max(series.length, 1);
  const groupLeft = (g: number) => MARGIN.left + g * band + (band * (1 - GROUP_FILL)) / 2;

  return (
    <figure class="line-chart bar-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={description}>
        {gridlines.map((value) => (
          <g class="gridline">
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(value).toFixed(1)} y2={y(value).toFixed(1)} />
            <text x={MARGIN.left - 6} y={y(value).toFixed(1)} text-anchor="end" dominant-baseline="middle">
              {value.toLocaleString("en-US")}
            </text>
          </g>
        ))}
        {groups.map((group, g) =>
          group.label ? (
            <text class="x-label" x={(MARGIN.left + (g + 0.5) * band).toFixed(1)} y={HEIGHT - 8} text-anchor="middle">
              {group.label}
            </text>
          ) : null,
        )}
        {series.map((each, i) =>
          each.values.map((value, g) =>
            value === null ? null : (
              <rect
                class={seriesColour(i, series.length)}
                x={(groupLeft(g) + i * barWidth).toFixed(1)}
                y={y(value).toFixed(1)}
                width={barWidth.toFixed(1)}
                height={(MARGIN.top + PLOT_HEIGHT - y(value)).toFixed(1)}
              >
                <title>{`${groups[g].title}${series.length > 1 ? ` ${each.label}` : ""}: ${value.toLocaleString("en-US")} ${value === 1 ? unit[0] : unit[1]}`}</title>
              </rect>
            ),
          ),
        )}
      </svg>
      {series.length > 1 && (
        <figcaption>
          {series.map((each, i) => (
            <>
              <span class={`swatch ${seriesColour(i, series.length)}`} /> {each.label}{" "}
            </>
          ))}
        </figcaption>
      )}
    </figure>
  );
};
