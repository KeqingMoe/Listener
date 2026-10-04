import assert from 'node:assert/strict';
import test from 'node:test';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import { ReplyBatch, type BatchItem } from '../../../src/agent/reply-batch.ts';

function item(sequence: number, direct = false): BatchItem {
  return {
    entry: {
      messageId: String(sequence),
      userId: '7',
      nickname: '',
      text: 'test',
      time: 1,
    },
    context: {
      selfId: '9',
      groupId: '8',
      actorId: '7',
      messageId: String(sequence),
    },
    sequence,
    received: sequence * 100,
    receipt: { receivedAt: sequence * 100, receivedMonotonic: sequence * 10 },
    ...(direct ? { trigger: 'mention' as const } : {}),
  };
}

test('first eligible receipt survives random promotion, primary changes, and eviction', () => {
  const first = item(1);
  const batch = new ReplyBatch(first, 0, true, OWNER_ID);
  batch.freezeOrigin(first);
  const origin = structuredClone(batch.eventOrigin);
  for (let i = 2; i < 80; i++) {
    const next = item(i, true);
    batch.add(next, 0);
    batch.freezeOrigin(next);
  }
  assert.equal(batch.kind, 'direct');
  assert.notEqual(batch.primary.sequence, 1);
  assert.ok(!batch.items.some((entry) => entry.sequence === 1));
  assert.deepEqual(batch.eventOrigin, origin);
  assert.equal(origin?.turnId, batch.turnId);
  assert.ok(Object.isFrozen(batch.eventOrigin));
  assert.ok(Object.isFrozen(batch.eventOrigin?.receipt));
  first.receipt = { receivedAt: 999, receivedMonotonic: 999 };
  assert.deepEqual(batch.eventOrigin, origin);
});

test('timer origin and missing trusted receipt remain ineligible after later messages', () => {
  for (const timer of [true, false]) {
    const first = item(1);
    delete first.receipt;
    const batch = new ReplyBatch(first, 0, false, OWNER_ID);
    batch.freezeOrigin(timer ? undefined : first);
    batch.add(item(2, true), 0);
    batch.freezeOrigin(item(2, true));
    assert.equal(batch.eventOrigin, undefined);
  }
});

test('unqualified buffered messages do not select an origin until admitted', () => {
  const first = item(1);
  const batch = new ReplyBatch(first, 0, false, OWNER_ID);
  assert.equal(Boolean(batch.eventOrigin), false);
  const direct = item(2, true);
  batch.add(direct, 0);
  batch.freezeOrigin(direct);
  assert.equal(batch.eventOrigin?.receipt.receivedAt, 200);
});
