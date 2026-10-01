import type {
  RequestTrendPoint,
  RequestTrendOutcome,
} from '../../../../contracts/request-trends';

export const outcomes: {
  key: RequestTrendOutcome;
  label: string;
  color: string;
}[] = [
  { key: 'running', label: '执行中', color: '#4895ef' },
  { key: 'interrupted', label: '中断', color: '#a78bfa' },
  { key: 'success', label: '成功', color: '#25a47a' },
  { key: 'failed', label: '失败', color: '#ed6572' },
  { key: 'timeout', label: '超时', color: '#e9a33b' },
  { key: 'cancelled', label: '取消', color: '#a99576' },
  { key: 'unknown', label: '结果不明', color: '#8995a7' },
];
export const chartMetrics = [
  {
    key: 'duration',
    label: '耗时（秒）',
    field: 'durationMs',
    divisor: 1000,
    unit: '秒',
  },
  {
    key: 'input',
    label: '未缓存输入 tokens',
    field: 'inputTokens',
    divisor: 1,
    unit: 'tokens',
  },
  {
    key: 'totalInput',
    label: '总输入 tokens',
    field: 'totalInputTokens',
    divisor: 1,
    unit: 'tokens',
  },
  {
    key: 'cachedInput',
    label: '缓存输入 tokens',
    field: 'cachedInputTokens',
    divisor: 1,
    unit: 'tokens',
  },
  {
    key: 'output',
    label: '输出 tokens',
    field: 'outputTokens',
    divisor: 1,
    unit: 'tokens',
  },
  {
    key: 'ttft',
    label: 'TTFT（秒）',
    field: 'ttftMs',
    divisor: 1000,
    unit: '秒',
  },
  {
    key: 'tps',
    label: 'TPS（tokens/秒）',
    field: 'tps',
    divisor: 1,
    unit: 'tokens/秒',
  },
  {
    key: 'cacheHitRate',
    label: '缓存命中率（%）',
    field: 'cacheHitRate',
    divisor: 0.01,
    unit: '%',
  },
] as const;

export type ChartMetric = (typeof chartMetrics)[number];

export function resolveMetric(value: unknown): ChartMetric {
  return chartMetrics.find((metric) => metric.key === value) ?? chartMetrics[0];
}

export function metricValue(
  point: RequestTrendPoint,
  metric: ChartMetric,
): number | null {
  const value = point[metric.field];
  return value == null || !Number.isFinite(value) || value < 0
    ? null
    : value / metric.divisor;
}

export const chartRanges = [
  { key: 'all', label: '全部' },
  { key: 'p99', label: '99%' },
  { key: 'p95', label: '95%' },
] as const;

export type ChartRange = (typeof chartRanges)[number]['key'];

export function resolveChartRange(value: unknown): ChartRange {
  return value === 'p95' || value === 'p99' ? value : 'all';
}

export const chartScales = [
  { key: 'linear', label: '线性' },
  { key: 'log', label: '对数' },
] as const;

export type ChartScale = (typeof chartScales)[number]['key'];

/** 百分比指标有固定的0..100区间，不提供对数刻度。 */
export const supportsLog = (metric: ChartMetric) =>
  metric.key !== 'cacheHitRate';

export function resolveChartScale(
  value: unknown,
  metric: ChartMetric,
): ChartScale {
  return value === 'log' && supportsLog(metric) ? 'log' : 'linear';
}

export const chartDots = [
  { key: 'fine', label: '细点' },
  { key: 'bold', label: '粗点' },
] as const;

export type ChartDots = (typeof chartDots)[number]['key'];

/** 细点适合密集数据，重叠处近似实色；粗点半透明，稀疏时更易辨认。 */
export const dotStyles: Record<ChartDots, { size: number; opacity: number }> = {
  fine: { size: 2, opacity: 0.9 },
  bold: { size: 5, opacity: 0.5 },
};

export function resolveChartDots(value: unknown): ChartDots {
  return value === 'bold' ? 'bold' : 'fine';
}

export interface ScatterView {
  range: ChartRange;
  scale: ChartScale;
  dots: ChartDots;
}

export const defaultScatterView: ScatterView = {
  range: 'all',
  scale: 'linear',
  dots: 'fine',
};

/** 最近秩百分位：取排序后第ceil(n*p)个值，结果总是真实样本值。 */
export function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

export function scatterSummary(
  points: RequestTrendPoint[],
  metric: ChartMetric,
  range: ChartRange = 'all',
  scale: ChartScale = 'linear',
) {
  const values = points.flatMap((point) => {
    const value = metricValue(point, metric);
    return Number.isFinite(point.startedAt) && value !== null ? [value] : [];
  });
  // 两端各裁去一半：95%显示P2.5..P97.5，99%显示P0.5..P99.5。
  // 最近秩百分位会保留所有并列值；这只是显示范围，不是离群值检测。
  const limited = range !== 'all' && values.length >= 20;
  const sorted = limited ? [...values].sort((a, b) => a - b) : [];
  const tail = range === 'p95' ? 0.025 : 0.005;
  const cut = Math.floor(values.length * tail);
  const lower = limited ? sorted[cut]! : null;
  const upper = limited ? sorted[values.length - 1 - cut]! : null;
  const below =
    lower === null ? 0 : values.filter((value) => value < lower).length;
  const above =
    upper === null ? 0 : values.filter((value) => value > upper).length;
  // 对数轴无法表示0，这些点如实计数而不是挪到底边。
  const unplottable =
    scale === 'log'
      ? values.filter(
          (value) =>
            value <= 0 &&
            (lower === null || value >= lower) &&
            (upper === null || value <= upper),
        ).length
      : 0;
  return {
    total: points.length,
    drawable: values.length - below - above - unplottable,
    missing: points.length - values.length,
    below,
    above,
    unplottable,
    lower,
    upper,
    limited,
  };
}

/** 1、2、5乘10的幂中不小于 value 的最小值。 */
function niceStep(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  const unit = value / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/**
 * 线性纵轴的下界：不强制从0开始，取不高于最小显示值的整齐刻度。
 * 预留少量边距；同值数据也保留可见的纵轴跨度。
 */
export function axisFloor(min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  if (min <= 0) {
    return 0;
  }
  const span = Math.max(max - min, min * 0.05);
  const padding = Math.min(span * 0.05, min * 0.05);
  const step = niceStep(Math.min(span / 5, min / 10));
  return Math.max(0, niceFloor(min - padding, step));
}

function niceFloor(value: number, step: number) {
  // 消除浮点误差，例如 0.1*3。
  return Number((Math.floor(value / step + 1e-9) * step).toPrecision(12));
}

/** 窗口内至少有这么多样本才画对应的统计线，样本过少的位置断开。 */
export const TREND_MIN_SAMPLES = { median: 5, p95: 20 } as const;

/** 窗口宽度为柱状图桶宽的倍数；每半个桶取一次值，曲线比逐桶统计平滑。 */
export const TREND_WINDOW_BUCKETS = 3;

const TREND_MAX_POSITIONS = 400;

export interface TrendLines {
  median: Array<[number, number | null]>;
  /** 每个时间窗口自己的P95，与按全部样本计算的显示上限不是同一个值。 */
  p95: Array<[number, number | null]>;
  /** 与P95共同标出窗口内中间约90%的分位范围，不是回归置信带。 */
  p5: Array<[number, number | null]>;
}

/**
 * 滑动窗口的中位数与P5/P95：在范围内每半个桶取一个位置，统计其前后各1.5个桶时长内的请求。
 * 统计包括被显示范围裁剪掉的样本；对数刻度下非正值的统计结果留空。
 */
export function trendLines(
  points: RequestTrendPoint[],
  range: { since: number; until: number },
  bucketMs: number,
  metric: ChartMetric,
  scale: ChartScale,
): TrendLines {
  const samples = points
    .flatMap((point) => {
      const value = metricValue(point, metric);
      return value !== null && Number.isFinite(point.startedAt)
        ? [[point.startedAt, value] as const]
        : [];
    })
    .sort((a, b) => a[0] - b[0]);
  const median: TrendLines['median'] = [],
    p95: TrendLines['p95'] = [],
    p5: TrendLines['p5'] = [];
  // 位置数有上限，范围与桶宽不匹配时也不会退化成海量循环。
  const step = Math.max(
      bucketMs / 2,
      (range.until - range.since) / TREND_MAX_POSITIONS,
    ),
    half = (bucketMs * TREND_WINDOW_BUCKETS) / 2;
  if (!(step > 0) || range.until < range.since) {
    return { median, p95, p5 };
  }
  const keep = (value: number | null) =>
    value !== null && (scale !== 'log' || value > 0) ? value : null;
  let start = 0,
    end = 0;
  for (let at = range.since; at <= range.until + step / 2; at += step) {
    const x = Math.min(at, range.until);
    // 样本按时间排序，窗口两端单调前移。
    while (start < samples.length && samples[start]![0] < x - half) {
      start++;
    }
    while (end < samples.length && samples[end]![0] <= x + half) {
      end++;
    }
    const values = samples
      .slice(start, end)
      .map((sample) => sample[1])
      .sort((a, b) => a - b);
    median.push([
      x,
      keep(
        values.length >= TREND_MIN_SAMPLES.median
          ? percentile(values, 0.5)
          : null,
      ),
    ]);
    p5.push([
      x,
      keep(
        values.length >= TREND_MIN_SAMPLES.p95
          ? percentile(values, 0.05)
          : null,
      ),
    ]);
    p95.push([
      x,
      keep(
        values.length >= TREND_MIN_SAMPLES.p95
          ? percentile(values, 0.95)
          : null,
      ),
    ]);
  }
  return { median, p95, p5 };
}

export function coordinateNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(
    value,
  );
}

export function axisNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

export function timeLabel(value: number, since: number, until: number): string {
  const start = new Date(since),
    end = new Date(until);
  const crossDay = start.toDateString() !== end.toDateString();
  return new Date(value).toLocaleString('zh-CN', {
    ...(crossDay ? ({ month: '2-digit', day: '2-digit' } as const) : {}),
    hour: '2-digit',
    minute: '2-digit',
    ...(until - since < 3600000 ? ({ second: '2-digit' } as const) : {}),
    hour12: false,
  });
}

export function coordinateTime(value: number): string {
  const date = new Date(value);
  return `${date.toLocaleString('zh-CN', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
