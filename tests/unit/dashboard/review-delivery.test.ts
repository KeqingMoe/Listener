import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchDeliveryReads,
  type DeliveryRead,
} from '../../../src/dashboard/server/review-delivery.ts';
import type { WakeDeliveryBatch } from '../../../src/dashboard/contracts/review.ts';

const batch = (seq = 1): WakeDeliveryBatch => ({
  messageIndex: seq - 1,
  messageSeq: seq,
  sessionId: 's',
  wakeId: 'w',
  createdAt: null,
  unreadCount: 0,
  omittedCount: 0,
  readThrough: 10,
  worldEventCount: 0,
  contentTruncated: false,
});
const read = (seq = 1): DeliveryRead => ({
  seq,
  sessionId: 's',
  wakeId: 'w',
  payload: { read_through: 10 },
  createdAt: seq * 100,
  complete: true,
});

test('legacy complete sequence pairs repeated watermarks including empty/job deliveries', () => {
  const bs = [batch(2), batch(1)];
  matchDeliveryReads(bs, [read(2), read(1)], true);
  assert.deepEqual(
    bs.map((b) => b.createdAt),
    [200, 100],
  );
});

test('explicit sequence requires unique scope and matching watermark', () => {
  const b = batch();
  matchDeliveryReads(
    [b],
    [{ ...read(), payload: { message_seq: 1, read_through: 10 } }],
    false,
  );
  assert.equal(b.createdAt, 100);
});

for (const mode of [
  'missing',
  'bad-json',
  'duplicate',
  'session',
  'wake',
  'clipped',
  'partial',
  'illegal',
  'watermark',
  'explicit-duplicate',
  'explicit-invalid',
  'explicit-watermark',
  'duplicate-message',
]) {
  test(`delivery matching refuses ${mode}`, () => {
    const bs = [batch()];
    let rs = [read()];
    if (mode === 'missing') {
      rs = [];
    }
    if (mode === 'bad-json') {
      rs[0]!.payload = '{';
    }
    if (mode === 'duplicate') {
      bs.push(batch(2));
      rs.push(read());
    }
    if (mode === 'session') {
      rs[0]!.sessionId = 'foreign';
    }
    if (mode === 'wake') {
      rs[0]!.wakeId = 'foreign';
    }
    if (mode === 'clipped') {
      rs[0]!.complete = false;
    }
    if (mode === 'illegal') {
      bs[0]!.messageSeq = null;
    }
    if (mode === 'watermark') {
      rs[0]!.payload = { read_through: 11 };
    }
    if (mode.startsWith('explicit') || mode === 'duplicate-message') {
      rs[0]!.payload = { message_seq: 1, read_through: 10 };
    }
    if (mode === 'explicit-duplicate') {
      rs.push({ ...rs[0]! });
    }
    if (mode === 'explicit-invalid') {
      rs[0]!.payload = { message_seq: '1', read_through: 10 };
    }
    if (mode === 'explicit-watermark') {
      rs[0]!.payload = { message_seq: 1, read_through: 11 };
    }
    if (mode === 'duplicate-message') {
      bs.push(batch());
    }
    matchDeliveryReads(bs, rs, mode !== 'partial');
    assert.ok(bs.every((b) => b.createdAt === null));
  });
}
