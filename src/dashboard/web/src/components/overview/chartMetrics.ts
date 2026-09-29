import type { RequestTrendPoint, RequestTrendOutcome } from "../../../../contracts/request-trends";

export const outcomes: { key: RequestTrendOutcome; label: string; color: string }[] = [
  { key: "running", label: "执行中", color: "#4895ef" },
  { key: "interrupted", label: "中断", color: "#a78bfa" },
  { key: "success", label: "成功", color: "#25a47a" },
  { key: "failed", label: "失败", color: "#ed6572" },
  { key: "timeout", label: "超时", color: "#e9a33b" },
  { key: "cancelled", label: "取消", color: "#a99576" },
  { key: "unknown", label: "结果不明", color: "#8995a7" },
];
export const chartMetrics = [
  { key: "duration", label: "耗时（秒）", field: "durationMs", divisor: 1000, unit: "秒" },
  { key: "input", label: "未缓存输入 tokens", field: "inputTokens", divisor: 1, unit: "tokens" },
  { key: "totalInput", label: "总输入 tokens", field: "totalInputTokens", divisor: 1, unit: "tokens" },
  { key: "cachedInput", label: "缓存输入 tokens", field: "cachedInputTokens", divisor: 1, unit: "tokens" },
  { key: "output", label: "输出 tokens", field: "outputTokens", divisor: 1, unit: "tokens" },
  { key: "ttft", label: "TTFT（秒）", field: "ttftMs", divisor: 1000, unit: "秒" },
  { key: "tps", label: "TPS（tokens/秒）", field: "tps", divisor: 1, unit: "tokens/秒" },
  { key: "cacheHitRate", label: "缓存命中率（%）", field: "cacheHitRate", divisor: 0.01, unit: "%" },
] as const;
export type ChartMetric = typeof chartMetrics[number];
export function resolveMetric(value: unknown): ChartMetric {
  return chartMetrics.find(metric => metric.key === value) ?? chartMetrics[0];
}
export function metricValue(point: RequestTrendPoint, metric: ChartMetric): number | null {
  const value = point[metric.field];
  return value == null || !Number.isFinite(value) || value < 0 ? null : value / metric.divisor;
}
export const chartRanges = [
  { key: "all", label: "全部" },
  { key: "p95", label: "主体95%" },
  { key: "p99", label: "主体99%" },
] as const;
export type ChartRange = typeof chartRanges[number]['key'];
export function resolveChartRange(value: unknown): ChartRange {
  return value === "p95" || value === "p99" ? value : "all";
}
export function scatterSummary(points: RequestTrendPoint[], metric: ChartMetric, range: ChartRange = "all") {
  const values = points.flatMap(point => {
    const value = metricValue(point, metric);
    return Number.isFinite(point.startedAt) && value !== null ? [value] : [];
  });
  // Nearest-rank percentile retains all ties; this is a display limit, not outlier detection.
  const limited = range !== "all" && values.length >= 20;
  const sorted = limited ? [...values].sort((a, b) => a - b) : [];
  const upper = limited ? sorted[Math.ceil(values.length * (range === "p95" ? .95 : .99)) - 1]! : null;
  const hidden = upper === null ? 0 : values.filter(value => value > upper).length;
  return { total: points.length, drawable: values.length - hidden, missing: points.length - values.length, hidden, upper, limited };
}
export function coordinateNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
}
export function axisNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}
export function timeLabel(value: number, since: number, until: number): string {
  const start = new Date(since), end = new Date(until);
  const crossDay = start.toDateString() !== end.toDateString();
  return new Date(value).toLocaleString("zh-CN", {
    ...(crossDay ? { month: "2-digit", day: "2-digit" } as const : {}),
    hour: "2-digit", minute: "2-digit", ...(until - since < 3600000 ? { second: "2-digit" } as const : {}), hour12: false,
  });
}
export function coordinateTime(value: number): string {
  const date = new Date(value);
  return `${date.toLocaleString("zh-CN", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}
