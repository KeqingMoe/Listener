import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  RequestTrendSyncPoint,
  RequestTrendsSyncResponse,
} from '../../../src/dashboard/contracts/request-trends.ts';
import { applyTrendSync } from '../../../src/dashboard/web/src/composables/requestTrendsState.ts';

const point = (key: string, startedAt = 100): RequestTrendSyncPoint => ({
  key,
  startedAt,
  outcome: 'running',
  durationMs: null,
  inputTokens: 0,
  totalInputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: null,
  tps: null,
  ttftMs: null,
  cacheHitRate: null,
});
const response = (
  overrides: Partial<RequestTrendsSyncResponse> = {},
): RequestTrendsSyncResponse => ({
  mode: 'snapshot',
  cursor: 'one',
  range: { since: 0, until: 200 },
  availability: { telemetry: true, sessions: [] },
  bucketMs: 100,
  buckets: [],
  upserts: [],
  removals: [],
  ...overrides,
});

test('snapshot replaces prior keys; delta upserts lifecycle updates and removes stable keys', () => {
  const initial = applyTrendSync(
    new Map([['old', point('old')]]),
    response({ upserts: [point('a'), point('b')] }),
  );
  assert.deepEqual([...initial.points.keys()], ['a', 'b']);
  const completed = {
    ...point('a'),
    outcome: 'success' as const,
    durationMs: 42,
  };
  const next = applyTrendSync(
    initial.points,
    response({
      mode: 'delta',
      cursor: 'two',
      upserts: [completed, point('c')],
      removals: ['b', 'unknown'],
    }),
  );
  assert.deepEqual([...next.points.keys()], ['a', 'c']);
  assert.equal(next.points.get('a')?.durationMs, 42);
  assert.equal(next.cursor, 'two');
  assert.equal(initial.points.get('a')?.outcome, 'running');
  assert.ok(initial.points.has('b'));
});

test('rolling delta prunes expired points inclusively and uses full server buckets unchanged', () => {
  const previous = new Map(
    ['expired', 'start', 'end', 'future'].map((key, i) => [
      key,
      point(key, i * 100),
    ]),
  );
  const buckets = [
    {
      bucketStart: 100,
      bucketEnd: 200,
      total: 99,
      counts: {
        running: 99,
        interrupted: 0,
        success: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        unknown: 0,
      },
    },
  ];
  const next = applyTrendSync(
    previous,
    response({ mode: 'delta', range: { since: 100, until: 200 }, buckets }),
  );
  assert.deepEqual(
    next.data.points.map((p) => p.startedAt),
    [100, 200],
  );
  assert.equal(next.data.buckets, buckets);
  assert.equal(next.data.buckets[0]?.total, 99);
  assert.equal(previous.size, 4);
});

test('full snapshot resets empty/unavailable data without retaining stale points', () => {
  const next = applyTrendSync(
    new Map([['secret', point('secret')]]),
    response({ availability: { telemetry: false, sessions: [] } }),
  );
  assert.equal(next.points.size, 0);
  assert.deepEqual(next.data.points, []);
  assert.equal(next.data.availability.telemetry, false);
});

test('stable tuple keys retain identical timestamps and all unsampled points', () => {
  const upserts = Array.from({ length: 10000 }, (_, i) =>
    point(JSON.stringify([String(i % 3), String(i)])),
  );
  const next = applyTrendSync(new Map(), response({ upserts }));
  assert.equal(next.data.points.length, 10000);
  assert.ok(
    next.data.points.every(
      (p) => p.startedAt === 100 && p.inputTokens === 0 && p.tps === null,
    ),
  );
});
