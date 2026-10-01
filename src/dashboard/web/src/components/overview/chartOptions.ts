import type { EChartsOption } from 'echarts';
import type { RequestTrendsResponse } from '../../../../contracts/request-trends';
import {
  axisNumber,
  axisFloor,
  metricValue,
  outcomes,
  timeLabel,
  type ChartMetric,
  type ScatterView,
  defaultScatterView,
  dotStyles,
  scatterSummary,
  trendLines,
} from './chartMetrics';

export const plot = { left: 66, right: 20, top: 34, bottom: 58 };

interface ChartColors {
  text: string;
  muted: string;
  border: string;
}

/** 成功最先画，少见的失败、超时等结果叠在上面，不会被大量成功点盖住。 */
const DRAW_ORDER = [
  'success',
  'running',
  'interrupted',
  'cancelled',
  'unknown',
  'timeout',
  'failed',
] as const;

export function chartOptions(
  data: RequestTrendsResponse,
  metric: ChartMetric,
  colors: ChartColors,
  kind: 'bar' | 'scatter',
  view: ScatterView = defaultScatterView,
): EChartsOption {
  const { since, until } = data.range;
  const scatter = kind === 'scatter';
  const log = scatter && view.scale === 'log';
  const summary = scatter
    ? scatterSummary(data.points, metric, view.range, view.scale)
    : null;
  const lower = summary?.lower ?? null;
  const upper = summary?.upper ?? null;
  const shown = (value: number) =>
    (lower === null || value >= lower) &&
    (upper === null || value <= upper) &&
    (!log || value > 0);
  const values = scatter
    ? data.points.flatMap((point) => {
        const value = metricValue(point, metric);
        return Number.isFinite(point.startedAt) &&
          value !== null &&
          shown(value)
          ? [value]
          : [];
      })
    : [];
  const minimum = values.length ? values.reduce((a, b) => Math.min(a, b)) : 0;
  const maximum = values.length ? values.reduce((a, b) => Math.max(a, b)) : 0;
  // 显示范围只由保留的散点决定，不让未裁剪的统计线重新撑开纵轴。
  const floor = scatter && !log ? axisFloor(minimum, maximum) : 0;
  const ceiling =
    upper === null
      ? metric.key === 'cacheHitRate'
        ? 100
        : null
      : upper > floor
        ? upper
        : floor + Math.max(Math.abs(floor) * 0.01, 0.001);
  const dots = dotStyles[view.dots];
  const trends = scatter
    ? trendLines(data.points, data.range, data.bucketMs, metric, view.scale)
    : null;
  return {
    animation: false,
    textStyle: { color: colors.text },
    grid: plot,
    tooltip: { show: false, trigger: 'none', renderMode: 'richText' },
    xAxis: {
      type: 'time',
      min: since,
      max: until,
      boundaryGap: [0, 0],
      axisPointer: { show: false },
      axisLine: { lineStyle: { color: colors.border } },
      axisLabel: {
        color: colors.muted,
        hideOverlap: true,
        showMinLabel: true,
        showMaxLabel: true,
        fontSize: 10,
        formatter: (value: number) => timeLabel(value, since, until),
      },
      splitLine: { show: false },
    },
    yAxis: {
      // 对数轴的下限由数据决定，0和负值不可表示。
      ...(log
        ? { type: 'log', logBase: 10, ...(minimum > 0 ? { min: minimum } : {}) }
        : { type: 'value', min: floor }),
      ...(scatter && ceiling !== null
        ? { max: log ? Math.max(ceiling, minimum * 1.01) : ceiling }
        : {}),
      ...(kind === 'bar' ? { minInterval: 1 } : {}),
      name: kind === 'bar' ? '请求数' : metric.label,
      nameLocation: 'end',
      nameGap: 12,
      nameTextStyle: {
        color: colors.muted,
        align: 'left',
        padding: [0, 0, 0, -48],
      },
      axisPointer: { show: false },
      axisLabel: {
        color: colors.muted,
        formatter: axisNumber,
        width: 54,
        overflow: 'truncate',
        fontSize: 10,
      },
      splitLine: { lineStyle: { color: colors.border, opacity: 0.5 } },
    },
    series:
      kind === 'bar'
        ? barSeries(data)
        : [
            ...DRAW_ORDER.map((key, order) => {
              const outcome = outcomes.find((item) => item.key === key)!;
              return {
                name: outcome.label,
                type: 'scatter' as const,
                silent: true,
                emphasis: { disabled: true },
                animation: false,
                clip: true,
                z: 2 + order,
                // 点数超过阈值时ECharts默认分帧绘制：先清空再逐帧补点，每次刷新都会闪。
                // 一万个点内一次画完只需几毫秒，因此关闭渐进渲染。
                progressive: 0,
                symbolSize: dots.size,
                itemStyle: { color: outcome.color, opacity: dots.opacity },
                data: data.points.flatMap((point) => {
                  const value = metricValue(point, metric);
                  return point.outcome === outcome.key &&
                    Number.isFinite(point.startedAt) &&
                    value !== null &&
                    shown(value)
                    ? [[point.startedAt, value]]
                    : [];
                }),
              };
            }),
            trendSeries('中位数', trends!.median, colors.text, 'solid'),
            trendSeries('P95', trends!.p95, colors.text, 'dashed'),
          ],
  };
}

function trendSeries(
  name: string,
  data: Array<[number, number | null]>,
  color: string,
  type: 'solid' | 'dashed',
) {
  return {
    name,
    type: 'line' as const,
    silent: true,
    emphasis: { disabled: true },
    animation: false,
    clip: true,
    z: 20,
    showSymbol: false,
    // 轻度平滑且沿时间轴单调，不会在时间上回折。
    smooth: 0.35,
    smoothMonotone: 'x' as const,
    // 样本不足的桶断开，不跨空桶连线。
    connectNulls: false,
    lineStyle: { color, width: 1.5, type, opacity: 0.85 },
    data,
  };
}

function barSeries(data: RequestTrendsResponse) {
  return outcomes.map((outcome) => ({
    name: outcome.label,
    type: 'bar' as const,
    stack: 'requests',
    silent: true,
    emphasis: { disabled: true },
    animation: false,
    clip: true,
    // 按bucket中点而非类目索引定位，首尾不完整的bucket因此仍落在响应的精确时间范围内。
    barCategoryGap: '12%',
    itemStyle: { color: outcome.color },
    data: data.buckets.map((bucket) => [
      (bucket.bucketStart + bucket.bucketEnd) / 2,
      bucket.counts[outcome.key],
    ]),
  }));
}
