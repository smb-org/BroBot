export const STATISTICS_CHART_PLOT = { left: 42, right: 42, top: 20, bottom: 142, width: 760 };

export const statisticsChartScaleY = (value: number, maximum: number, top = STATISTICS_CHART_PLOT.top, bottom = STATISTICS_CHART_PLOT.bottom): number =>
  top + (bottom - top) * (1 - value / Math.max(1, maximum));

export const statisticsChartAxisTicks = (maximum: number, divisions = 2): Array<{ fraction: number; value: number }> => {
  const count = Math.max(1, Math.floor(Number.isFinite(divisions) ? divisions : 2));
  return Array.from({ length: count + 1 }, (_, index) => ({
    fraction: index / count,
    value: maximum * (1 - index / count),
  }));
};

export interface StatisticsChartPoint {
  at: string | number;
  value: number | null;
}

/** Shared SVG line primitive for time-based statistics series. */
export const statisticsChartLinePath = (
  points: readonly StatisticsChartPoint[],
  start: number,
  end: number,
  maximum: number,
  width: number,
  plot = STATISTICS_CHART_PLOT,
): string => {
  const plotWidth = Math.max(1, width - plot.left - plot.right);
  let open = false;
  return points.map(({ at, value }) => {
    if (value === null) { open = false; return ""; }
    const timestamp = typeof at === "number" ? at : Date.parse(at);
    if (!Number.isFinite(timestamp)) { open = false; return ""; }
    const x = plot.left + ((timestamp - start) / Math.max(1, end - start)) * plotWidth;
    const y = statisticsChartScaleY(value, maximum, plot.top, plot.bottom);
    const command = open ? "L" : "M";
    open = true;
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
};

/** The same series closed down to the x axis, one polygon per uninterrupted run. */
export const statisticsChartAreaPath = (
  points: readonly StatisticsChartPoint[],
  start: number,
  end: number,
  maximum: number,
  width: number,
  plot = STATISTICS_CHART_PLOT,
): string => statisticsChartLinePath(points, start, end, maximum, width, plot)
  .split(/\s+(?=M)/u)
  .filter((run) => run.length > 0)
  .map((run) => {
    const xs = [...run.matchAll(/[ML]([\d.-]+),/gu)].map((match) => match[1] ?? "0");
    return `${run} L${xs.at(-1) ?? "0"},${String(plot.bottom)} L${xs[0] ?? "0"},${String(plot.bottom)} Z`;
  })
  .join(" ");
