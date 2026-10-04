import type { EChartsOption } from 'echarts';
import type { fitLines } from './chartFit';
import type { RequestTrendsResponse } from '../../../../contracts/request-trends';
import {
  axisNumber,
  axisFloor,
  sampleSummary,
  sampleTrendLines,
  validSample,
  type NumericSample,
  outcomes,
  timeLabel,
  type ChartMetric,
  type ScatterView,
  defaultScatterView,
  dotStyles,
} from './chartMetrics';

export const plot = { left: 66, right: 20, top: 34, bottom: 58 };

/** 群的颜色独立于当前筛选，全部群与单群视图保持一致。 */
export function fitColor(groupId: string): string {
  let hash = 2166136261;
  for (const char of groupId) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return `hsl(${(hash >>> 0) % 360}, 65%, 40%)`;
}

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

type BarData = Pick<RequestTrendsResponse, 'range' | 'buckets'>;

export function barOptions(data: BarData, colors: ChartColors): EChartsOption {
  return {
    ...baseOptions(data.range, colors),
    yAxis: {
      ...valueAxis(colors),
      type: 'value',
      min: 0,
      minInterval: 1,
      name: '请求数',
    },
    series: barSeries(data),
  };
}

export interface ScatterData {
  range: { since: number; until: number };
  bucketMs: number;
  samples: NumericSample[];
  categories: { key: string; label: string; color: string }[];
}

/** Scatter renderer only accepts numeric samples, never request/wake DTOs. */
export function scatterOptions(
  data: ScatterData,
  metric: ChartMetric,
  colors: ChartColors,
  view: ScatterView = defaultScatterView,
  fitted: ReturnType<typeof fitLines> = [],
): EChartsOption {
  const log = view.scale === 'log';
  const summary = sampleSummary(data.samples, view.range, view.scale);
  const lower = summary?.lower ?? null;
  const upper = summary?.upper ?? null;
  const shown = (value: number) =>
    (lower === null || value >= lower) &&
    (upper === null || value <= upper) &&
    (!log || value > 0);
  const values = data.samples
    .filter((point) => validSample(point) && shown(point.value))
    .map((point) => point.value);
  const minimum = values.length ? values.reduce((a, b) => Math.min(a, b)) : 0;
  const maximum = values.length ? values.reduce((a, b) => Math.max(a, b)) : 0;
  // 显示范围只由保留的散点决定，不让未裁剪的统计线重新撑开纵轴。
  const floor = !log ? axisFloor(minimum, maximum) : 0;
  const ceiling =
    upper === null
      ? metric.key === 'cacheHitRate'
        ? 100
        : null
      : upper > floor
        ? upper
        : floor + Math.max(Math.abs(floor) * 0.01, 0.001);
  const dots = dotStyles[view.dots];
  const trends =
    view.guides === 'quantiles'
      ? sampleTrendLines(data.samples, data.range, data.bucketMs, view.scale)
      : null;
  const fits = view.guides === 'fit' ? fitted : [];
  return {
    ...baseOptions(data.range, colors),
    yAxis: {
      ...valueAxis(colors),
      // 对数轴的下限由数据决定，0和负值不可表示。
      ...(log
        ? { type: 'log', logBase: 10, ...(minimum > 0 ? { min: minimum } : {}) }
        : { type: 'value', min: floor }),
      ...(ceiling !== null
        ? { max: log ? Math.max(ceiling, minimum * 1.01) : ceiling }
        : {}),
      name: metric.label,
    },
    series: [
      ...[...data.categories]
        .sort(
          (a, b) =>
            DRAW_ORDER.indexOf(a.key as (typeof DRAW_ORDER)[number]) -
            DRAW_ORDER.indexOf(b.key as (typeof DRAW_ORDER)[number]),
        )
        .map((outcome, order) => {
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
            data: data.samples.flatMap((point) =>
              point.category === outcome.key &&
              validSample(point) &&
              shown(point.value)
                ? [[point.time, point.value]]
                : [],
            ),
          };
        }),
      ...(trends
        ? [
            trendSeries('中位数', trends.median, colors.text, 'solid'),
            trendSeries('P95', trends.p95, colors.text, 'dashed'),
            trendSeries('P5', trends.p5, colors.text, 'dashed'),
          ]
        : []),
      ...fits.map((line) => ({
        ...trendSeries(
          `群 ${line.groupId} 拟合`,
          line.data.map(([x, y]): [number, number | null] => [
            x,
            log && y !== null && y <= 0 ? null : y,
          ]),
          fitColor(line.groupId),
          'solid',
        ),
        // 已做局部稳健拟合，只轻度平滑连接；null边界保持断开。
        smooth: 0.2,
        lineStyle: {
          color: fitColor(line.groupId),
          width: 1.8,
          opacity: 0.8,
        },
      })),
    ],
  };
}

function baseOptions(range: ScatterData['range'], colors: ChartColors) {
  const { since, until } = range;
  return {
    animation: false,
    textStyle: { color: colors.text },
    grid: plot,
    tooltip: {
      show: false,
      trigger: 'none' as const,
      renderMode: 'richText' as const,
    },
    xAxis: {
      type: 'time' as const,
      min: since,
      max: until,
      boundaryGap: [0, 0] as [number, number],
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
  };
}

function valueAxis(colors: ChartColors) {
  return {
    nameLocation: 'end' as const,
    nameGap: 12,
    nameTextStyle: {
      color: colors.muted,
      align: 'left' as const,
      padding: [0, 0, 0, -48],
    },
    axisPointer: { show: false },
    axisLabel: {
      color: colors.muted,
      formatter: axisNumber,
      width: 54,
      overflow: 'truncate' as const,
      fontSize: 10,
    },
    splitLine: { lineStyle: { color: colors.border, opacity: 0.5 } },
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
    lineStyle: {
      color,
      width: 1.5,
      type,
      opacity: type === 'solid' ? 0.85 : 0.55,
    },
    data,
  };
}

function barSeries(data: BarData) {
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
