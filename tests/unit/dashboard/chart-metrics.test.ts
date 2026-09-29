import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequestTrendPoint, RequestTrendsResponse } from '../../../src/dashboard/contracts/request-trends.js';
import { chartMetrics, metricValue, resolveMetric, scatterSummary, resolveChartRange, outcomes } from '../../../src/dashboard/web/src/components/overview/chartMetrics.js';
import { chartOptions } from '../../../src/dashboard/web/src/components/overview/chartOptions.js';

const point: RequestTrendPoint = { startedAt: 1234567890123, outcome: 'failed', durationMs: 1500, ttftMs: null, inputTokens: 0, totalInputTokens: 100, cachedInputTokens: 100, outputTokens: null, tps: null, cacheHitRate: 1 };
test('all eight metrics preserve zero and missing values; duration uses seconds and TPS is never inferred', () => {
  assert.deepEqual(chartMetrics.map(metric => metricValue(point, metric)), [1.5, 0, 100, 100, null, null, null, 100]);
  for (const metric of chartMetrics) {
    assert.equal(metricValue({ ...point, [metric.field]: null }, metric), null);
    assert.equal(metricValue({ ...point, [metric.field]: 0 }, metric), 0);
    assert.equal(metricValue({ ...point, [metric.field]: NaN }, metric), null);
  }
  assert.deepEqual(scatterSummary([point, { ...point, durationMs: null }], resolveMetric('duration')), { total: 2, drawable: 1, missing: 1, hidden: 0, upper: null, limited: false });
  assert.equal(resolveChartRange('p95'), 'p95'); assert.equal(resolveChartRange('bad'), 'all');
});
test('cache hit rates plot percentages and retain zero, missing and percentile semantics', () => {
  const metric = resolveMetric('cacheHitRate');
  assert.equal(metricValue({ ...point, cacheHitRate: .4 }, metric), 40);
  assert.equal(metricValue({ ...point, cacheHitRate: 0 }, metric), 0);
  assert.equal(metricValue({ ...point, cacheHitRate: null }, metric), null);
  const points = Array.from({ length: 100 }, (_, i) => ({ ...point, cacheHitRate: i / 100 }));
  const response: RequestTrendsResponse = { range: { since: 0, until: point.startedAt }, availability: { telemetry: true, sessions: [] }, points, bucketMs: 1000, buckets: [] };
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  assert.equal((chartOptions(response, metric, colors, 'scatter').yAxis as { max: number }).max, 100);
  assert.ok(Math.abs((chartOptions(response, metric, colors, 'scatter', 'p95').yAxis as { max: number }).max - 94) < 1e-9);
});
test('percentile display keeps ties and zeros, excludes missing samples and leaves small sets intact', () => {
  const metric = resolveMetric('duration');
  const points = Array.from({ length: 100 }, (_, i) => ({ ...point, durationMs: i * 1000 }));
  assert.deepEqual(scatterSummary([...points, { ...point, durationMs: null }], metric, 'p95'), { total: 101, drawable: 95, missing: 1, hidden: 5, upper: 94, limited: true });
  assert.equal(scatterSummary(points, metric, 'p99').upper, 98);
  assert.equal(scatterSummary(points.slice(0, 19), metric, 'p95').upper, null);
  assert.equal(scatterSummary(points.slice(0, 20), metric, 'p95').hidden, 1);
  assert.equal(scatterSummary(points.map(p => ({ ...p, durationMs: 0 })), metric, 'p95').hidden, 0);
  const response: RequestTrendsResponse = { range: { since: 0, until: point.startedAt }, availability: { telemetry: true, sessions: [] }, points, bucketMs: 1000, buckets: [] };
  const colors = { text: '#fff', muted: '#aaa', border: '#333' };
  const option = chartOptions(response, metric, colors, 'scatter', 'p95');
  assert.equal((option.yAxis as { max: number }).max, 94);
  const series = option.series as Array<{ data: number[][]; symbolSize: number; itemStyle: { opacity: number } }>;
  assert.equal(series.flatMap(s => s.data).length, 95);
  assert.ok(series.every(s => s.symbolSize === 2 && s.itemStyle.opacity === .9));
  assert.deepEqual(chartOptions(response, metric, colors, 'bar', 'p95').series, chartOptions(response, metric, colors, 'bar').series);
  assert.equal((chartOptions(response, metric, colors, 'bar', 'p95').yAxis as { max?: number }).max, undefined);
  assert.equal(points.length, 100);
});
test('invalid route metric resolves to duration, including arrays and inherited property names', () => {
  for (const value of [undefined, null, '', 'bad', ['tps'], 'constructor', '__proto__']) assert.equal(resolveMetric(value).key, 'duration');
  for (const metric of chartMetrics) assert.equal(resolveMetric(metric.key), metric);
});
test('options preserve all 10000 raw timestamp/value pairs and seven outcome series', () => {
  const points = Array.from({ length: 10000 }, (_, i) => ({ ...point, startedAt: point.startedAt + i, outcome: outcomes[i % outcomes.length]!.key }));
  const response: RequestTrendsResponse = { range: { since: point.startedAt, until: point.startedAt + 10000 }, availability: { telemetry: true, sessions: [] }, points, bucketMs: 1000, buckets: [] };
  const option = chartOptions(response, resolveMetric('duration'), { text: '#fff', muted: '#aaa', border: '#333' }, 'scatter');
  const series = option.series as Array<{ data: number[][]; silent: boolean; emphasis: { disabled: boolean } }>;
  assert.equal(series.length, 7);
  const coordinates = series.flatMap(series => series.data).sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(coordinates, points.map(point => [point.startedAt, 1.5]));
  assert.ok(series.every(series => series.silent && series.emphasis.disabled));
  assert.deepEqual(scatterSummary(points, resolveMetric('duration')), { total: 10000, drawable: 10000, missing: 0, hidden: 0, upper: null, limited: false });
});
