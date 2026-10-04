import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequestTrendPoint } from '../../../src/dashboard/contracts/request-trends.ts';
import type { WakeEffectTrendPoint } from '../../../src/dashboard/contracts/wake-effect-trends.ts';
import {
  requestSamples,
  sampleSummary,
  sampleTrendLines,
  resolveMetric,
  defaultScatterView,
  outcomes,
} from '../../../src/dashboard/web/src/components/overview/chartMetrics.ts';
import {
  reasoningCounts,
  wakeSamples,
  wakeCategories,
} from '../../../src/dashboard/web/src/components/overview/chartSources.ts';
import {
  barOptions,
  scatterOptions,
} from '../../../src/dashboard/web/src/components/overview/chartOptions.ts';

test('request count bars consume only bucket counts, never scatter samples or metrics', () => {
  const option = barOptions(
    {
      range: { since: 0, until: 1000 },
      buckets: [
        {
          bucketStart: 0,
          bucketEnd: 1000,
          total: 3,
          counts: {
            running: 1,
            interrupted: 0,
            success: 2,
            failed: 0,
            timeout: 0,
            cancelled: 0,
            unknown: 0,
          },
        },
      ],
    },
    { text: '#222', muted: '#888', border: '#aaa' },
  );
  const series = option.series as Array<{
    name: string;
    type: string;
    data: number[][];
  }>;
  assert.equal(series.length, 7);
  assert.ok(series.every((s) => s.type === 'bar'));
  assert.deepEqual(series.find((s) => s.name === '成功')!.data, [[500, 2]]);
});

const point: RequestTrendPoint = {
  startedAt: 1000,
  outcome: 'success',
  durationMs: 500,
  reasoningDurationMs: null,
  reasoningTimingStatus: null,
  ttftMs: null,
  inputTokens: null,
  totalInputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  tps: null,
  cacheHitRate: null,
};
const colors = { text: '#222', muted: '#888', border: '#aaa' };

test('reasoning admits complete finite nonnegative observations only; partial and legacy never become zeros', () => {
  const points: RequestTrendPoint[] = [
    { ...point, reasoningTimingStatus: 'complete', reasoningDurationMs: 0 },
    { ...point, reasoningTimingStatus: 'complete', reasoningDurationMs: 2000 },
    { ...point, reasoningTimingStatus: 'partial', reasoningDurationMs: 9000 },
    {
      ...point,
      reasoningTimingStatus: 'not_observed',
      reasoningDurationMs: 1000,
    },
    point,
    { ...point, reasoningTimingStatus: 'complete', reasoningDurationMs: NaN },
    { ...point, reasoningTimingStatus: 'complete', reasoningDurationMs: -1 },
    { ...point, reasoningTimingStatus: 'complete', reasoningDurationMs: null },
  ];
  const samples = requestSamples(points, resolveMetric('reasoning'));
  assert.deepEqual(
    samples.map((p) => p.value),
    [0, 2],
  );
  assert.deepEqual(reasoningCounts(points), {
    partial: 1,
    notObserved: 1,
    unknown: 1,
  });
  assert.equal(
    sampleSummary(samples, 'all', 'linear', points.length).missing,
    6,
  );
  assert.equal(
    sampleSummary(samples, 'all', 'log', points.length).unplottable,
    1,
  );
  assert.equal(requestSamples(points, resolveMetric('duration')).length, 8);
});

test('wake samples use message times and only confirmed valid waits, independent of request states', () => {
  const points: WakeEffectTrendPoint[] = [
    'confirmed',
    'pending',
    'unconfirmed',
    'interrupted',
  ].map((outcome, i) => ({
    key: `wake-${i}`,
    receivedAt: 1000 + i,
    outcome: outcome as WakeEffectTrendPoint['outcome'],
    firstEffectWaitMs: 0,
  }));
  points.push(
    { ...points[0]!, key: 'null', firstEffectWaitMs: null },
    { ...points[0]!, key: 'negative', firstEffectWaitMs: -1 },
  );
  assert.deepEqual(wakeSamples(points), [
    { time: 1000, value: 0, category: 'confirmed' },
  ]);
  assert.equal(
    sampleSummary(wakeSamples(points), 'all', 'linear', points.length).missing,
    5,
  );
  assert.deepEqual(requestSamples([point], resolveMetric('firstEffect')), []);
});

test('pure numeric quantiles keep seconds separate and ignore incomplete/legacy observations', () => {
  const points = Array.from({ length: 20 }, (_, i): RequestTrendPoint => ({
    ...point,
    reasoningTimingStatus: 'complete',
    reasoningDurationMs: i * 1000,
  }));
  points.push(
    ...Array.from({ length: 50 }, (): RequestTrendPoint => ({
      ...point,
      reasoningTimingStatus: 'partial',
      reasoningDurationMs: 9999999,
    })),
    point,
  );
  const lines = sampleTrendLines(
    requestSamples(points, resolveMetric('reasoning')),
    { since: 1000, until: 2000 },
    1000,
    'linear',
  );
  assert.equal(lines.median[0]![1], 9);
  assert.equal(lines.p5[0]![1], 0);
  assert.equal(lines.p95[0]![1], 18);
  assert.equal(
    sampleTrendLines(
      requestSamples([point], resolveMetric('reasoning')),
      { since: 1000, until: 2000 },
      1000,
      'linear',
    ).median[0]![1],
    null,
  );
});

test('new scatter sources preserve every real point and disable all point-level interaction at 10000', () => {
  for (const count of [3000, 10000]) {
    const samples = Array.from({ length: count }, (_, i) => ({
      time: i,
      value: i / 1000,
      category: 'confirmed',
    }));
    const option = scatterOptions(
      {
        range: { since: 0, until: count },
        bucketMs: 1000,
        samples,
        categories: wakeCategories,
      },
      resolveMetric('firstEffect'),
      colors,
      defaultScatterView,
    );
    const series = option.series as Array<{
      type: string;
      silent: boolean;
      emphasis: { disabled: boolean };
      data: unknown[];
      progressive?: number;
    }>;
    assert.equal(
      series
        .filter((s) => s.type === 'scatter')
        .reduce((sum, s) => sum + s.data.length, 0),
      count,
    );
    assert.ok(series.every((s) => s.silent && s.emphasis.disabled));
    assert.ok(
      series
        .filter((s) => s.type === 'scatter')
        .every((s) => s.progressive === 0),
    );
    assert.equal((option.tooltip as { show: boolean }).show, false);
    assert.equal(series.filter((s) => s.type === 'line').length, 3);
    assert.deepEqual(
      outcomes.map((s) => s.key),
      [
        'running',
        'interrupted',
        'success',
        'failed',
        'timeout',
        'cancelled',
        'unknown',
      ],
    );
  }
});
