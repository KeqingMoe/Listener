import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningTiming } from '../../../src/model/reasoning-timing.ts';

const expected = (
  reasoningDurationMs: number | null,
  reasoningTimingStatus: string,
) => ({ reasoningDurationMs, reasoningTimingStatus });

test('exact monotonic phase boundaries, including zero and pure reasoning', () => {
  const timing = new ReasoningTiming();
  timing.observe(12.25, true, false);
  timing.observe(15, true, false);
  timing.observe(19.75, false, true);
  timing.observe(90, false, true);
  assert.deepEqual(timing.finish(true, 100), expected(7.5, 'complete'));
  assert.deepEqual(timing.finish(false, 100), expected(7.5, 'partial'));
  const pure = new ReasoningTiming();
  pure.observe(0, true, false);
  assert.deepEqual(pure.finish(true, 3.125), expected(3.125, 'complete'));
  assert.deepEqual(pure.finish(false, 3.125), expected(null, 'partial'));
  const zero = new ReasoningTiming();
  zero.observe(42, true, true);
  assert.deepEqual(zero.finish(true, 50), expected(0, 'complete'));
});

test('unobserved, missing endpoint and illegal ordering never fabricate durations', () => {
  const absent = new ReasoningTiming();
  absent.observe(0, false, true);
  assert.deepEqual(absent.finish(false), expected(null, 'not_observed'));
  absent.observe(2, true, false);
  assert.deepEqual(absent.finish(true, 3), expected(null, 'partial'));
  const resumed = new ReasoningTiming();
  resumed.observe(1, true, false);
  resumed.observe(2, false, true);
  resumed.observe(3, true, false);
  assert.deepEqual(resumed.finish(true, 4), expected(null, 'partial'));
  const open = new ReasoningTiming();
  open.observe(10, true, false);
  assert.deepEqual(open.finish(true), expected(null, 'partial'));
  assert.deepEqual(open.finish(true, 9), expected(null, 'partial'));
});
