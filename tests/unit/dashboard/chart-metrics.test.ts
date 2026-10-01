import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  RequestTrendPoint,
  RequestTrendsResponse,
} from '../../../src/dashboard/contracts/request-trends.ts';
import {
  axisFloor,
  chartMetrics,
  metricValue,
  resolveMetric,
  scatterSummary,
  resolveChartRange,
  resolveChartScale,
  resolveChartDots,
  trendLines,
  defaultScatterView,
  outcomes,
} from '../../../src/dashboard/web/src/components/overview/chartMetrics.ts';
import { chartOptions } from '../../../src/dashboard/web/src/components/overview/chartOptions.ts';

const p95 = { ...defaultScatterView, range: 'p95' } as const;

type Series = {
  type: string;
  name: string;
  data: number[][];
  symbolSize: number;
  itemStyle: { opacity: number };
  silent: boolean;
  emphasis: { disabled: boolean };
  z: number;
};

const allSeries = (option: ReturnType<typeof chartOptions>) =>
  option.series as Series[];
const scatterSeries = (option: ReturnType<typeof chartOptions>) =>
  allSeries(option).filter((s) => s.type === 'scatter');

const point: RequestTrendPoint = {
  startedAt: 1234567890123,
  outcome: 'failed',
  durationMs: 1500,
  ttftMs: null,
  inputTokens: 0,
  totalInputTokens: 100,
  cachedInputTokens: 100,
  outputTokens: null,
  tps: null,
  cacheHitRate: 1,
};

test('all eight metrics preserve zero and missing values; duration uses seconds and TPS is never inferred', () => {
  assert.deepEqual(
    chartMetrics.map((metric) => metricValue(point, metric)),
    [1.5, 0, 100, 100, null, null, null, 100],
  );
  for (const metric of chartMetrics) {
    assert.equal(metricValue({ ...point, [metric.field]: null }, metric), null);
    assert.equal(metricValue({ ...point, [metric.field]: 0 }, metric), 0);
    assert.equal(metricValue({ ...point, [metric.field]: NaN }, metric), null);
  }
  assert.deepEqual(
    scatterSummary(
      [point, { ...point, durationMs: null }],
      resolveMetric('duration'),
    ),
    {
      total: 2,
      drawable: 1,
      missing: 1,
      below: 0,
      above: 0,
      unplottable: 0,
      lower: null,
      upper: null,
      limited: false,
    },
  );
  assert.equal(resolveChartRange('p95'), 'p95');
  assert.equal(resolveChartRange('bad'), 'all');
});

test('cache hit rates plot percentages and retain zero, missing and percentile semantics', () => {
  const metric = resolveMetric('cacheHitRate');
  assert.equal(metricValue({ ...point, cacheHitRate: 0.4 }, metric), 40);
  assert.equal(metricValue({ ...point, cacheHitRate: 0 }, metric), 0);
  assert.equal(metricValue({ ...point, cacheHitRate: null }, metric), null);
  const points = Array.from({ length: 100 }, (_, i) => ({
    ...point,
    cacheHitRate: i / 100,
  }));
  const response: RequestTrendsResponse = {
    range: { since: 0, until: point.startedAt },
    availability: { telemetry: true, sessions: [] },
    points,
    bucketMs: 1000,
    buckets: [],
  };
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  assert.equal(
    (chartOptions(response, metric, colors, 'scatter').yAxis as { max: number })
      .max,
    100,
  );
  assert.ok(
    Math.abs(
      (
        chartOptions(response, metric, colors, 'scatter', p95).yAxis as {
          max: number;
        }
      ).max - 97,
    ) < 1e-9,
  );
});

test('percentile display keeps ties and zeros, excludes missing samples and leaves small sets intact', () => {
  const metric = resolveMetric('duration');
  const points = Array.from({ length: 100 }, (_, i) => ({
    ...point,
    durationMs: i * 1000,
  }));
  assert.deepEqual(
    scatterSummary([...points, { ...point, durationMs: null }], metric, 'p95'),
    {
      total: 101,
      drawable: 96,
      missing: 1,
      below: 2,
      above: 2,
      unplottable: 0,
      lower: 2,
      upper: 97,
      limited: true,
    },
  );
  assert.deepEqual(scatterSummary(points, metric, 'p99'), {
    total: 100,
    drawable: 100,
    missing: 0,
    below: 0,
    above: 0,
    unplottable: 0,
    lower: 0,
    upper: 99,
    limited: true,
  });
  const small = scatterSummary(points.slice(0, 19), metric, 'p95');
  assert.equal(small.lower, null);
  assert.equal(small.upper, null);
  assert.equal(small.limited, false);
  assert.deepEqual(scatterSummary(points.slice(0, 20), metric, 'p95'), {
    total: 20,
    drawable: 20,
    missing: 0,
    below: 0,
    above: 0,
    unplottable: 0,
    lower: 0,
    upper: 19,
    limited: true,
  });
  const ties = points.map((p, i) => ({
    ...p,
    durationMs: i < 3 ? 2000 : i > 96 ? 97000 : p.durationMs,
  }));
  const tied = scatterSummary(ties, metric, 'p95');
  assert.equal(tied.lower, 2);
  assert.equal(tied.upper, 97);
  assert.equal(tied.below, 0);
  assert.equal(tied.above, 0);
  assert.equal(tied.drawable, 100);
  const response: RequestTrendsResponse = {
    range: { since: 0, until: point.startedAt },
    availability: { telemetry: true, sessions: [] },
    points,
    bucketMs: 1000,
    buckets: [],
  };
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  const option = chartOptions(response, metric, colors, 'scatter', p95);
  assert.equal((option.yAxis as { max: number }).max, 97);
  const series = scatterSeries(option);
  assert.deepEqual(
    series.flatMap((s) => s.data).map((d) => d[1]),
    Array.from({ length: 96 }, (_, i) => i + 2),
  );
  assert.ok(
    series.every((s) => s.symbolSize === 2 && s.itemStyle.opacity === 0.9),
  );
  assert.deepEqual(
    chartOptions(response, metric, colors, 'bar', p95).series,
    chartOptions(response, metric, colors, 'bar').series,
  );
  assert.equal(
    (
      chartOptions(response, metric, colors, 'bar', p95).yAxis as {
        max?: number;
      }
    ).max,
    undefined,
  );
  assert.equal(points.length, 100);
});

test('automatic axis floors stay below visible values without forcing positive data to zero', () => {
  for (const [min, max] of [
    [19220, 142800],
    [12.3, 19.8],
    [0.12, 0.18],
    [100, 100],
  ]) {
    const floor = axisFloor(min!, max!);
    assert.ok(Number.isFinite(floor));
    assert.ok(floor > 0 && floor <= min!);
  }
  assert.equal(axisFloor(0, 99), 0);
  assert.equal(axisFloor(0, 0), 0);
  assert.equal(axisFloor(NaN, 100), 0);
  assert.equal(axisFloor(1, Infinity), 0);
  const response: RequestTrendsResponse = {
    range: { since: 0, until: point.startedAt },
    availability: { telemetry: true, sessions: [] },
    points: [19220, 142800].map((totalInputTokens) => ({
      ...point,
      totalInputTokens,
    })),
    bucketMs: 1000,
    buckets: [],
  };
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  const metric = resolveMetric('totalInput');
  const axis = chartOptions(response, metric, colors, 'scatter').yAxis as {
    min: number;
  };
  assert.ok(axis.min > 0 && axis.min <= 19220);
  assert.equal(
    (chartOptions(response, metric, colors, 'bar').yAxis as { min: number })
      .min,
    0,
  );
});

test('all-zero, all-100-percent and constant samples retain ties and nondegenerate axes', () => {
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  for (const [key, value] of [
    ['duration', 0],
    ['duration', 5000],
    ['cacheHitRate', 0],
    ['cacheHitRate', 1],
  ] as const) {
    const metric = resolveMetric(key);
    const points = Array.from({ length: 100 }, () => ({
      ...point,
      [metric.field]: value,
    }));
    const response: RequestTrendsResponse = {
      range: { since: 0, until: point.startedAt },
      availability: { telemetry: true, sessions: [] },
      points,
      bucketMs: 1000,
      buckets: [],
    };
    for (const range of ['all', 'p95', 'p99'] as const) {
      const summary = scatterSummary(points, metric, range);
      assert.equal(summary.drawable, 100);
      assert.equal(summary.below, 0);
      assert.equal(summary.above, 0);
      assert.equal(
        summary.lower,
        range === 'all' ? null : value / metric.divisor,
      );
      assert.equal(
        summary.upper,
        range === 'all' ? null : value / metric.divisor,
      );
      const option = chartOptions(response, metric, colors, 'scatter', {
        ...defaultScatterView,
        range,
      });
      const axis = option.yAxis as { min: number; max?: number };
      assert.ok(Number.isFinite(axis.min) && axis.min >= 0);
      assert.ok(axis.min <= value / metric.divisor);
      if (axis.max !== undefined) {
        assert.ok(Number.isFinite(axis.max) && axis.max > axis.min);
        assert.ok(axis.max >= value / metric.divisor);
        if (key === 'cacheHitRate') {
          assert.ok(axis.max <= 100);
        }
      }
      assert.equal(scatterSeries(option).flatMap((s) => s.data).length, 100);
    }
  }
});

test('two-tail log clipping separates clipped zeros from unplottable retained zeros', () => {
  const metric = resolveMetric('duration');
  const points = Array.from({ length: 100 }, (_, i) => ({
    ...point,
    durationMs: i * 1000,
  }));
  for (const range of ['p95', 'p99'] as const) {
    const summary = scatterSummary(points, metric, range, 'log');
    assert.deepEqual(
      [summary.below, summary.above, summary.unplottable, summary.drawable],
      range === 'p95' ? [2, 2, 0, 96] : [0, 0, 1, 99],
    );
    const response: RequestTrendsResponse = {
      range: { since: 0, until: point.startedAt },
      availability: { telemetry: true, sessions: [] },
      points,
      bucketMs: 1000,
      buckets: [],
    };
    const option = chartOptions(
      response,
      metric,
      { text: '#fff', muted: '#aaa', border: '#333' },
      'scatter',
      { ...defaultScatterView, range, scale: 'log' },
    );
    const axis = option.yAxis as { min: number; max: number };
    assert.equal(axis.min, range === 'p95' ? 2 : 1);
    assert.equal(axis.max, range === 'p95' ? 97 : 99);
    assert.equal(
      scatterSeries(option).flatMap((s) => s.data).length,
      summary.drawable,
    );
  }
  const zeros = points.map((p) => ({ ...p, durationMs: 0 }));
  const summary = scatterSummary(zeros, metric, 'p95', 'log');
  assert.deepEqual(
    [summary.below, summary.above, summary.unplottable, summary.drawable],
    [0, 0, 100, 0],
  );
});

test('invalid route metric resolves to duration, including arrays and inherited property names', () => {
  for (const value of [
    undefined,
    null,
    '',
    'bad',
    ['tps'],
    'constructor',
    '__proto__',
  ]) {
    assert.equal(resolveMetric(value).key, 'duration');
  }
  for (const metric of chartMetrics) {
    assert.equal(resolveMetric(metric.key), metric);
  }
});

test('options preserve all 10000 raw timestamp/value pairs and seven outcome series', () => {
  const points = Array.from({ length: 10000 }, (_, i) => ({
    ...point,
    startedAt: point.startedAt + i,
    outcome: outcomes[i % outcomes.length]!.key,
  }));
  const response: RequestTrendsResponse = {
    range: { since: point.startedAt, until: point.startedAt + 10000 },
    availability: { telemetry: true, sessions: [] },
    points,
    bucketMs: 1000,
    buckets: [],
  };
  const option = chartOptions(
    response,
    resolveMetric('duration'),
    { text: '#fff', muted: '#aaa', border: '#333' },
    'scatter',
  );
  const series = scatterSeries(option);
  assert.equal(series.length, 7);
  const coordinates = series
    .flatMap((series) => series.data)
    .sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(
    coordinates,
    points.map((point) => [point.startedAt, 1.5]),
  );
  assert.ok(
    series.every((series) => series.silent && series.emphasis.disabled),
  );
  assert.deepEqual(scatterSummary(points, resolveMetric('duration')), {
    total: 10000,
    drawable: 10000,
    missing: 0,
    below: 0,
    above: 0,
    unplottable: 0,
    lower: null,
    upper: null,
    limited: false,
  });
});

test('log scale excludes non-positive values honestly and is unavailable for percentages', () => {
  const duration = resolveMetric('duration');
  assert.equal(resolveChartScale('log', duration), 'log');
  assert.equal(resolveChartScale('bad', duration), 'linear');
  assert.equal(
    resolveChartScale('log', resolveMetric('cacheHitRate')),
    'linear',
  );
  assert.equal(resolveChartDots('bold'), 'bold');
  assert.equal(resolveChartDots('x'), 'fine');
  const points = [0, 0, 1000, 2000].map((durationMs, i) => ({
    ...point,
    startedAt: point.startedAt + i,
    outcome: 'success' as const,
    durationMs,
  }));
  assert.deepEqual(scatterSummary(points, duration, 'all', 'log'), {
    total: 4,
    drawable: 2,
    missing: 0,
    below: 0,
    above: 0,
    unplottable: 2,
    lower: null,
    upper: null,
    limited: false,
  });
  const response: RequestTrendsResponse = {
    range: { since: point.startedAt, until: point.startedAt + 10 },
    availability: { telemetry: true, sessions: [] },
    points,
    bucketMs: 10,
    buckets: [],
  };
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  const option = chartOptions(response, duration, colors, 'scatter', {
    range: 'all',
    scale: 'log',
    dots: 'bold',
  });
  assert.equal((option.yAxis as { type: string }).type, 'log');
  const series = scatterSeries(option);
  assert.deepEqual(
    series.flatMap((s) => s.data).map((d) => d[1]),
    [1, 2],
  );
  assert.ok(
    series.every((s) => s.symbolSize === 5 && s.itemStyle.opacity === 0.5),
  );
  // 少见结果最后绘制，叠在成功点之上。
  const z = Object.fromEntries(series.map((s) => [s.name, s.z]));
  assert.ok(z['失败']! > z['成功']! && z['超时']! > z['成功']!);
});

test('trend lines use a sliding window, include clipped samples and always show P95', () => {
  const metric = resolveMetric('duration');
  const range = { since: 0, until: 400 };
  // 桶宽100：每50取一个位置，窗口为前后各150。
  const points = [
    // 0..19，耗时1..20秒。
    ...Array.from({ length: 20 }, (_, i) => ({
      ...point,
      startedAt: i,
      durationMs: (i + 1) * 1000,
    })),
    // 远处只有2个样本，不足以画任何线。
    { ...point, startedAt: 390, durationMs: 1000 },
    { ...point, startedAt: 400, durationMs: 3000 },
    { ...point, startedAt: 10, durationMs: null },
  ];
  const lines = trendLines(points, range, 100, metric, 'linear');
  assert.deepEqual(
    lines.median.map(([x]) => x),
    [0, 50, 100, 150, 200, 250, 300, 350, 400],
  );
  // 0..150的窗口都覆盖全部20个早期样本。
  assert.deepEqual(
    lines.median.slice(0, 4).map(([, y]) => y),
    [10, 10, 10, 10],
  );
  assert.deepEqual(
    lines.p95.slice(0, 4).map(([, y]) => y),
    [19, 19, 19, 19],
  );
  // 200之后只剩远处2个样本，断开而不是外推。
  assert.ok(lines.median.slice(4).every(([, y]) => y === null));
  assert.ok(lines.p95.slice(4).every(([, y]) => y === null));
  const zeros = points.map((p) => ({ ...p, durationMs: 0 }));
  assert.equal(
    trendLines(zeros, range, 100, metric, 'log').median[0]![1],
    null,
  );
  assert.equal(
    trendLines(zeros, range, 100, metric, 'linear').median[0]![1],
    0,
  );
  const response: RequestTrendsResponse = {
    range,
    availability: { telemetry: true, sessions: [] },
    points,
    bucketMs: 100,
    buckets: [],
  };
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  const names = (view: typeof defaultScatterView) =>
    allSeries(chartOptions(response, metric, colors, 'scatter', view))
      .filter((s) => s.type === 'line')
      .map((s) => s.name);
  // P95线是窗口自己的百分位，任何裁剪范围下都显示。
  assert.deepEqual(names(defaultScatterView), ['中位数', 'P95']);
  assert.deepEqual(names(p95), ['中位数', 'P95']);
  // 裁剪纵轴不影响统计线。
  const line = (view: typeof defaultScatterView) =>
    allSeries(chartOptions(response, metric, colors, 'scatter', view)).find(
      (s) => s.name === 'P95',
    )!.data;
  assert.deepEqual(line(p95), line(defaultScatterView));
});
