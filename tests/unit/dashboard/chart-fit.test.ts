import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type {
  RequestTrendPoint,
  RequestTrendSyncPoint,
} from '../../../src/dashboard/contracts/request-trends.ts';
import {
  chartMetrics,
  resolveMetric,
} from '../../../src/dashboard/web/src/components/overview/chartMetrics.ts';
import {
  FIT_WINDOW,
  FIT_MIN_SAMPLES,
  FIT_DROP_RATIO,
  FIT_DROP_TOKENS,
  FIT_GAP_MS,
  FIT_GAP_INTERVALS,
  fitLines,
  supportsFit,
} from '../../../src/dashboard/web/src/components/overview/chartFit.ts';

const epoch = 1_700_000_000_000;
const minute = 60_000;
const totalMetric = resolveMetric('totalInput');
const cachedMetric = resolveMetric('cachedInput');

function point(
  index: number,
  overrides: Partial<RequestTrendSyncPoint> = {},
): RequestTrendSyncPoint {
  return {
    key: JSON.stringify(['group-a', `request-${index}`]),
    startedAt: epoch + index * minute,
    outcome: 'success',
    durationMs: 1000,
    inputTokens: 20_000,
    totalInputTokens: 50_000 + index * 100,
    cachedInputTokens: 30_000 + index * 100,
    outputTokens: null,
    tps: null,
    ttftMs: null,
    cacheHitRate: null,
    ...overrides,
  };
}

function points(count = 15): RequestTrendSyncPoint[] {
  return Array.from({ length: count }, (_, i) => point(i));
}

function close(actual: number | null | undefined, expected: number) {
  assert.ok(actual != null && Number.isFinite(actual));
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
}

test('only totalInput/cachedInput support fitting; constants document bounded heuristics', () => {
  assert.deepEqual(
    chartMetrics.filter(supportsFit).map((m) => m.key),
    ['totalInput', 'cachedInput'],
  );
  for (const metric of chartMetrics.filter((m) => !supportsFit(m))) {
    assert.deepEqual(fitLines(points(), metric), []);
  }
  assert.equal(FIT_WINDOW, 9);
  assert.equal(FIT_MIN_SAMPLES, 5);
  assert.equal(FIT_DROP_RATIO, 0.1);
  assert.equal(FIT_DROP_TOKENS, 2048);
  assert.equal(FIT_GAP_MS, 30 * minute);
  assert.equal(FIT_GAP_INTERVALS, 5);
  assert.deepEqual(fitLines([], totalMetric), []);
});

test('strict decoded groups stay separate, sort by time and leave frozen raw points unchanged', () => {
  const ids = ['a,"b', 'a', '__proto__'];
  const raw = ids.flatMap((groupId, groupIndex) =>
    Array.from({ length: 12 }, (_, i) =>
      point(i, {
        key: JSON.stringify([groupId, `same-request-${i}`]),
        totalInputTokens: 10_000 + groupIndex * 100_000 + i * 123,
      }),
    ),
  );
  raw.reverse();
  const before = structuredClone(raw);
  raw.forEach(Object.freeze);
  Object.freeze(raw);
  const fitted = fitLines(raw, totalMetric);
  assert.equal(fitted.length, ids.length);
  for (const [index, groupId] of ids.entries()) {
    const data = fitted.find((line) => line.groupId === groupId)!.data;
    assert.equal(data.length, 12);
    data.forEach(([at, value], i) => {
      assert.equal(at, epoch + i * minute);
      close(value, 10_000 + index * 100_000 + i * 123);
    });
  }
  assert.deepEqual(raw, before);
});

test('invalid/missing keys never fall back to a shared group or contaminate valid groups', () => {
  const badKeys: unknown[] = [
    undefined,
    null,
    7,
    '',
    'group-a',
    '{',
    'null',
    '{}',
    '"group-a"',
    '[]',
    '["group-a"]',
    '["group-a","r","extra"]',
    '["group-a",7]',
    '[7,"r"]',
    '["","r"]',
    '["group-a",""]',
    '{"0":"group-a","1":"r","length":2}',
  ];
  const invalid = badKeys.flatMap((key) =>
    points(10).map((p) => ({ ...p, key, totalInputTokens: 1 })),
  ) as RequestTrendPoint[];
  const missingKey = points(10).map(({ key: _key, ...p }) => p);
  assert.deepEqual(fitLines([...invalid, ...missingKey], totalMetric), []);
  assert.deepEqual(
    fitLines([...points(), ...invalid, ...missingKey], totalMetric),
    fitLines(points(), totalMetric),
  );
});

test('minimum is five points per segment, not five points pooled across groups', () => {
  for (let count = 0; count < FIT_MIN_SAMPLES; count++) {
    assert.deepEqual(fitLines(points(count), totalMetric), []);
  }
  assert.equal(fitLines(points(5), totalMetric)[0]!.data.length, 5);
  assert.deepEqual(
    fitLines(
      points(12).map((p, i) => ({
        ...p,
        key: JSON.stringify([`group-${Math.floor(i / 4)}`, `${i}`]),
      })),
      totalMetric,
    ),
    [],
  );
});

test('linear trends remain exact at real irregular timestamps, including edges', () => {
  const offsets = [0, 1, 4, 5, 8, 15, 17, 22, 23, 31, 34, 35, 38];
  const raw = offsets.map((offset, i) =>
    point(i, {
      startedAt: epoch + offset * 10_000,
      totalInputTokens: 50_000 + offset * 120,
      cachedInputTokens: 30_000 + offset * 50,
    }),
  );
  for (const metric of [totalMetric, cachedMetric]) {
    const data = fitLines(raw, metric)[0]!.data;
    assert.equal(data.length, raw.length);
    data.forEach(([at, value], i) => {
      assert.equal(at, raw[i]!.startedAt);
      close(value, raw[i]![metric.field]!);
    });
  }
});

test('isolated cache misses are suppressed without creating compression segments', () => {
  for (const dip of [0, 7, 14]) {
    const raw = points();
    raw[dip]!.cachedInputTokens = 0;
    const data = fitLines(raw, cachedMetric)[0]!.data;
    assert.equal(data.length, raw.length);
    data.forEach(([, value], i) => close(value, 30_000 + i * 100));
  }
});

test('sustained cache and total declines are preserved, never forced monotonic upward', () => {
  const raw = points(25).map((p, i) => ({
    ...p,
    totalInputTokens: 50_000 - i * 500,
    cachedInputTokens: 30_000 - i * 900,
  }));
  for (const metric of [totalMetric, cachedMetric]) {
    const data = fitLines(raw, metric)[0]!.data;
    assert.equal(data.length, raw.length);
    data.forEach(([, value], i) => close(value, raw[i]![metric.field]!));
  }
});

test('local fit keeps a rise then sustained fall and does not become a global regression', () => {
  const raw = points(41).map((p, i) => ({
    ...p,
    cachedInputTokens: 10_000 + (i <= 20 ? i : 40 - i) * 800,
  }));
  const data = fitLines(raw, cachedMetric)[0]!.data;
  for (const i of [0, 5, 10, 15, 25, 30, 35, 40]) {
    close(data[i]![1], raw[i]!.cachedInputTokens!);
  }
  assert.ok(data[20]![1]! > data[5]![1]!);
  assert.ok(data[35]![1]! < data[25]![1]!);
  // A change outside the 9-point neighborhood cannot affect this fitted position.
  raw[40]!.cachedInputTokens = 0;
  close(fitLines(raw, cachedMetric)[0]!.data[10]![1], data[10]![1]!);
});

test('a total-input reset breaks both metrics with null at a real timestamp, no bridging', () => {
  const raw = points(14).map((p, i) => ({
    ...p,
    totalInputTokens: i < 7 ? 50_000 + i * 100 : 20_000 + (i - 7) * 100,
    // A constant cached value still splits because segmentation uses total input.
    cachedInputTokens: 10_000,
  }));
  for (const metric of [totalMetric, cachedMetric]) {
    const data = fitLines(raw, metric)[0]!.data;
    assert.equal(data.length, raw.length + 1);
    assert.deepEqual(data[7], [raw[7]!.startedAt, null]);
    assert.equal(data[8]![0], raw[7]!.startedAt);
    for (const [at, value] of data.filter(([, y]) => y !== null)) {
      close(value, raw.find((p) => p.startedAt === at)![metric.field]!);
    }
  }
});

test('drop segmentation requires BOTH thresholds, inclusive at their exact boundary', () => {
  for (const [before, after, split] of [
    [20_000, 17_953, false], // >=10%, but only 2047 tokens
    [50_000, 47_952, false], // 2048 tokens, but <10%
    [20_480, 18_432, true], // exactly 10% and 2048 tokens
  ] as const) {
    const raw = points(12).map((p, i) => ({
      ...p,
      totalInputTokens: i < 6 ? before : after,
      cachedInputTokens: 10_000,
    }));
    const data = fitLines(raw, cachedMetric)[0]!.data;
    assert.equal(data.filter(([, y]) => y === null).length, split ? 1 : 0);
  }
});

test('small segments stay null and do not borrow neighbors across resets', () => {
  const raw = points(14).map((p, i) => ({
    ...p,
    totalInputTokens: i < 6 ? 50_000 : i < 9 ? 30_000 : 10_000,
    cachedInputTokens: 5000,
  }));
  const data = fitLines(raw, cachedMetric)[0]!.data;
  for (let i = 6; i < 9; i++) {
    const atTime = data.filter(([at]) => at === raw[i]!.startedAt);
    assert.ok(atTime.length > 0 && atTime.every(([, y]) => y === null));
  }
  assert.equal(data.filter(([, y]) => y !== null).length, 11);
});

test('long gaps split only when both absolute and relative thresholds hold', () => {
  for (const [cadence, added, split] of [
    [minute, 29 * minute, true], // resulting gap exactly 30min
    [minute, 28 * minute, false], // large relative but below 30min
    [10 * minute, 30 * minute, false], // 40min, only 4x baseline
    [10 * minute, 40 * minute, true], // exactly 5x baseline
    [40 * minute, 0, false], // sparse but regular, not an outage
  ] as const) {
    const raw = points(12).map((p, i) => ({
      ...p,
      startedAt: epoch + i * cadence + (i >= 6 ? added : 0),
      totalInputTokens: 50_000,
    }));
    const data = fitLines(raw, totalMetric)[0]!.data;
    assert.equal(data.filter(([, y]) => y === null).length, split ? 1 : 0);
    assert.ok(data.every(([at]) => raw.some((p) => p.startedAt === at)));
    if (split) {
      assert.deepEqual(data[6], [raw[6]!.startedAt, null]);
    }
  }
});

test('missing/nonfinite/negative target or total values break the line rather than interpolate', () => {
  for (const field of ['totalInputTokens', 'cachedInputTokens'] as const) {
    for (const invalid of [null, undefined, NaN, Infinity, -1]) {
      const raw = points(13).map((p, i) =>
        i === 6 ? { ...p, [field]: invalid } : p,
      );
      const data = fitLines(raw, cachedMetric)[0]!.data;
      assert.deepEqual(data[6], [raw[6]!.startedAt, null]);
      assert.equal(data.length, 13);
      data.forEach(([, value], i) => {
        if (i !== 6) {
          close(value, 30_000 + i * 100);
        }
      });
    }
  }
});

test('invalid timestamps are excluded, not output as nonfinite chart coordinates', () => {
  const raw = points();
  for (const startedAt of [NaN, Infinity, -Infinity]) {
    raw.push(point(99, { startedAt }));
  }
  assert.deepEqual(fitLines(raw, totalMetric), fitLines(points(), totalMetric));
});

test('duplicate timestamps and all-equal values are finite; zero is not missing', () => {
  for (const value of [0, 12_345]) {
    const raw = points(15).map((p) => ({
      ...p,
      startedAt: epoch,
      totalInputTokens: value,
      cachedInputTokens: value,
    }));
    for (const metric of [totalMetric, cachedMetric]) {
      const data = fitLines(raw, metric)[0]!.data;
      assert.equal(data.length, raw.length);
      data.forEach(([at, y]) => {
        assert.equal(at, epoch);
        close(y, value);
      });
    }
  }
  const raw = points().map((p, i) => ({
    ...p,
    startedAt: epoch + Math.floor(i / 2) * minute,
    totalInputTokens: 50_000 + Math.floor(i / 2) * 100,
  }));
  fitLines(raw, totalMetric)[0]!.data.forEach(([, y], i) => {
    close(y, raw[i]!.totalInputTokens!);
  });
});

test('duplicate-time unequal cache values tolerate an isolated low hit', () => {
  const raw = points(9).map((p, i) => ({
    ...p,
    startedAt: epoch,
    totalInputTokens: 50_000,
    cachedInputTokens: i === 4 ? 0 : 20_000,
  }));
  fitLines(raw, cachedMetric)[0]!.data.forEach(([, y]) => close(y, 20_000));
});

test('cache fits stay nonnegative and never exceed the current total input', () => {
  const raw = points(10).map((p, i) => ({
    ...p,
    totalInputTokens: 5000 + i * 10,
    cachedInputTokens: 8000 + i * 20,
  }));
  fitLines(raw, cachedMetric)[0]!.data.forEach(([, y], i) => {
    close(y, raw[i]!.totalInputTokens!);
  });
  const noisy = points(20).map((p, i) => ({
    ...p,
    cachedInputTokens: i % 4 === 0 ? 0 : i * 30,
  }));
  assert.ok(fitLines(noisy, cachedMetric)[0]!.data.every(([, y]) => y! >= 0));
});

test('10,000 points use bounded neighborhoods and output size', (t) => {
  const raw = points(10_000).map((p, i) => ({
    ...p,
    startedAt: epoch + i * 1000,
    totalInputTokens: 50_000 + i * 100,
    cachedInputTokens: i % 37 === 0 ? 0 : 30_000 + i * 100,
  }));
  const started = performance.now();
  const lines = fitLines(raw, cachedMetric);
  const elapsed = performance.now() - started;
  t.diagnostic(`10,000-point cached fit: ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 5000, `bounded local fit took ${elapsed}ms`);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.data.length, raw.length);
  lines[0]!.data.forEach(([at, y], i) => {
    assert.equal(at, raw[i]!.startedAt);
    close(y, 30_000 + i * 100);
  });
});
