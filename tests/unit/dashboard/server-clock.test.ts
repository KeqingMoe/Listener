import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServerClock,
  serverClock,
} from '../../../src/dashboard/web/src/composables/serverClock.ts';
import { get } from '../../../src/dashboard/web/src/api/client.ts';

const date = 'Wed, 01 Jan 2025 00:00:00 GMT';
const epoch = Date.parse(date);

test('uncalibrated clock falls back to wall time and ignores malformed headers', () => {
  let wall = epoch + 86_400_000;
  const clock = createServerClock(
    () => 0,
    () => wall,
  );
  for (const header of [
    null,
    '',
    'invalid',
    '123',
    '2025-01-01',
    'Wed, 32 Jan 2025 00:00:00 GMT',
  ]) {
    clock.calibrate(header);
    assert.equal(clock.now(), wall);
  }
  wall += 2000;
  assert.equal(clock.now(), wall);
});

test('calibration corrects device skew in either direction and advances monotonically', () => {
  for (const skew of [-86_400_000, 86_400_000]) {
    let monotonic = 100;
    let wall = epoch + skew;
    const clock = createServerClock(
      () => monotonic,
      () => wall,
    );
    clock.calibrate(date);
    assert.equal(clock.now(), epoch + 500); // Estimate the second bucket's midpoint.
    wall += 3600_000;
    monotonic += 250;
    assert.equal(clock.now(), epoch + 750);
    clock.calibrate(date); // Frequent same-second samples do not rewind.
    assert.equal(clock.now(), epoch + 750);
    monotonic += 60_000; // No ticks required while hidden.
    assert.equal(clock.now(), epoch + 60_750);
    clock.calibrate(date); // Late response does not rewind either.
    clock.calibrate('bad');
    assert.equal(clock.now(), epoch + 60_750);
    clock.calibrate(new Date(epoch + 120_000).toUTCString());
    assert.equal(clock.now(), epoch + 120_500);
  }
});

test('GET calibrates at response receipt before reading JSON without extra requests', async (t) => {
  const calls: Array<[string | null, number | undefined]> = [];
  t.mock.method(
    serverClock,
    'calibrate',
    (header: string | null, receivedAt?: number) => {
      calls.push([header, receivedAt]);
    },
  );
  const response = new Response('{}', { headers: { Date: date } });
  t.mock.method(response, 'json', async () => {
    assert.equal(calls.length, 1);
    return { ok: true };
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => response);
  assert.deepEqual(await get('example'), { ok: true });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(calls[0]?.[0], date);
  assert.equal(typeof calls[0]?.[1], 'number');
});
