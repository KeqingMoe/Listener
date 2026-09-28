import type { EChartsOption } from "echarts";
import type { RequestTrendsResponse } from "../../../../contracts/request-trends";
import { axisNumber, metricValue, outcomes, timeLabel, type ChartMetric, type ChartRange, scatterSummary } from "./chartMetrics";

export const plot = { left: 66, right: 20, top: 34, bottom: 58 };
export interface ChartColors { text: string; muted: string; border: string }
export function chartOptions(data: RequestTrendsResponse, metric: ChartMetric, colors: ChartColors, kind: "bar" | "scatter", range: ChartRange = "all"): EChartsOption {
  const { since, until } = data.range;
  const upper = kind === "scatter" ? scatterSummary(data.points, metric, range).upper : null;
  return {
    animation: false,
    textStyle: { color: colors.text },
    grid: plot,
    tooltip: { show: false, trigger: "none", renderMode: "richText" },
    xAxis: {
      type: "time", min: since, max: until, boundaryGap: [0, 0],
      axisPointer: { show: false },
      axisLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.muted, hideOverlap: true, showMinLabel: true, showMaxLabel: true, fontSize: 10, formatter: (value: number) => timeLabel(value, since, until) },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value", min: 0, ...(upper === null ? (kind === "scatter" && metric.key === "cacheHitRate" ? { max: 100 } : {}) : { max: upper }), ...(kind === "bar" ? { minInterval: 1 } : {}),
      name: kind === "bar" ? "请求数" : metric.label, nameLocation: "end", nameGap: 12,
      nameTextStyle: { color: colors.muted, align: "left", padding: [0, 0, 0, -48] },
      axisPointer: { show: false },
      axisLabel: { color: colors.muted, formatter: axisNumber, width: 54, overflow: "truncate", fontSize: 10 },
      splitLine: { lineStyle: { color: colors.border, opacity: 0.5 } },
    },
    series: outcomes.map(outcome => kind === "bar" ? {
      name: outcome.label, type: "bar", stack: "requests", silent: true,
      emphasis: { disabled: true }, animation: false, clip: true,
      // Plot bucket centres, not category indices. The first/last partial buckets
      // therefore remain within the exact response time range.
      barCategoryGap: "12%", itemStyle: { color: outcome.color },
      data: data.buckets.map(bucket => [(bucket.bucketStart + bucket.bucketEnd) / 2, bucket.counts[outcome.key]]),
    } : {
      name: outcome.label, type: "scatter", silent: true, emphasis: { disabled: true },
      animation: false, clip: true, symbolSize: 2, itemStyle: { color: outcome.color, opacity: 0.9 },
      data: data.points.flatMap(point => {
        const value = metricValue(point, metric);
        return point.outcome === outcome.key && Number.isFinite(point.startedAt) && value !== null && (upper === null || value <= upper) ? [[point.startedAt, value]] : [];
      }),
    }),
  };
}
