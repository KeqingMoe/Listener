import assert from 'node:assert/strict';
import test from 'node:test';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import { ReplyBatch, type BatchItem } from '../../../src/agent/reply-batch.ts';

function item(
  sequence: number,
  trigger?: 'mention' | 'quote',
  received = sequence * 10,
): BatchItem {
  const id = String(sequence);
  return {
    entry: {
      messageId: id,
      userId: `user${id}`,
      nickname: `name${id}`,
      text: `body${id}`,
      time: 1000 - sequence,
      images: [{ id: `img_${id}_0`, index: 0 }],
    },
    context: {
      groupId: 'group',
      actorId: `user${id}`,
      messageId: id,
      selfId: 'bot',
    },
    sequence,
    received,
    ...(trigger ? { trigger } : {}),
  };
}

test('late classified earlier caller displaces newest direct when the roster is full', () => {
  const batch = new ReplyBatch(item(2, 'mention'), 20, false, OWNER_ID);
  for (let seq = 3; seq <= 65; seq++) {
    batch.add(item(seq, 'mention'), 20);
  }
  batch.add(item(1, 'quote'), 20);
  assert.deepEqual(
    batch.direct.map((x) => x.sequence),
    Array.from({ length: 64 }, (_, i) => i + 1),
  );
  assert.equal(batch.omittedDirect, 1);
  assert.equal(batch.omittedMessages, 1);
});

test('1000 ordinary arrivals retain 64, sort by arrival sequence rather than timestamp', () => {
  const batch = new ReplyBatch(item(0), 20, false, OWNER_ID);
  for (let i = 1; i < 1000; i++) {
    batch.add(item(i), 20);
  }
  assert.equal(batch.items.length, 64);
  assert.equal(batch.omittedMessages, 936);
  assert.equal(batch.omittedDirect, 0);
  assert.deepEqual(
    batch.items.map((x) => x.sequence),
    Array.from({ length: 64 }, (_, i) => i + 936),
  );
  assert.equal(batch.primary.sequence, 999);
  assert.equal(batch.readyAt, 20);
  assert.equal(batch.openedAt, 0);
  assert.equal(batch.randomSelected, false);
  assert.ok((batch as unknown as { seen: Set<string> }).seen.size <= 256);
});

test('direct requests evict ordinary entries and the first 64 direct requests stay pinned', () => {
  const batch = new ReplyBatch(item(0, 'mention'), 20, false, OWNER_ID);
  for (let i = 1; i <= 63; i++) {
    batch.add(item(i), 20);
  }
  batch.add(item(64, 'quote'), 20);
  assert.equal(
    batch.items.some((x) => x.sequence === 1),
    false,
  );
  for (let i = 65; i <= 126; i++) {
    batch.add(item(i, 'mention'), 20);
  }
  assert.equal(batch.direct.length, 64);
  const pinned = batch.items.map((x) => x.entry.messageId);
  batch.add(item(127), 20);
  batch.add(item(128, 'quote'), 20);
  assert.deepEqual(
    batch.items.map((x) => x.entry.messageId),
    pinned,
  );
  assert.equal(batch.omittedMessages, 65);
  assert.equal(batch.omittedDirect, 1);
  assert.equal(batch.kind, 'direct');
  assert.equal(batch.primary.sequence, 0);
});

test('omitted non-owner caller provenance remains recorded independently of capability policy', () => {
  const owned = (sequence: number) => {
    const value = item(sequence, 'mention');
    value.entry.userId = OWNER_ID;
    value.context.actorId = OWNER_ID;
    return value;
  };
  const batch = new ReplyBatch(owned(0), 0, false, OWNER_ID);
  for (let i = 1; i < 64; i++) {
    batch.add(owned(i), 0);
  }
  assert.equal(batch.hasNonOwnerDirect, false);
  batch.add(item(64, 'quote'), 0);
  assert.equal(batch.hasNonOwnerDirect, true);
  assert.equal(batch.omittedDirect, 1);
  assert.equal(
    batch.items.every((value) => value.entry.userId === OWNER_ID),
    true,
  );
  batch.add(owned(65), 0);
  assert.equal(batch.hasNonOwnerDirect, true);
});

test('duplicate IDs do not grow counts, even after eviction or omission', () => {
  const batch = new ReplyBatch(item(0), 1, false, OWNER_ID);
  for (let i = 1; i < 70; i++) {
    batch.add(item(i, 'mention'), 1);
  }
  const before = [
    batch.omittedMessages,
    batch.omittedDirect,
    batch.readyAt,
    batch.openedAt,
  ];
  batch.add(item(0, 'quote', -100), 1000);
  batch.add(item(69, 'quote', -100), 1000);
  batch.add(item(1, 'quote', -100), 1000);
  assert.deepEqual(
    [batch.omittedMessages, batch.omittedDirect, batch.readyAt, batch.openedAt],
    before,
  );
  assert.equal(batch.items.length, 64);
});

test('promotion anchors first direct; older resolved quotes only move deadline earlier', () => {
  const batch = new ReplyBatch(item(10), 500, true, OWNER_ID);
  batch.add(item(20, 'mention', 200), 50);
  assert.equal(batch.readyAt, 250);
  batch.add(item(30, 'mention', 300), 1000);
  assert.equal(batch.readyAt, 250);
  batch.add(item(15, 'quote', 150), 500);
  assert.equal(batch.readyAt, 250);
  batch.add(item(5, 'quote', 50), 50);
  assert.equal(batch.readyAt, 100);
  assert.equal(batch.openedAt, 50);
  assert.deepEqual(
    batch.items.map((x) => x.sequence),
    [5, 10, 15, 20, 30],
  );
  assert.equal(batch.randomSelected, true);
  assert.equal(batch.primary.sequence, 5);
  const next = new ReplyBatch(item(100), 50, false, OWNER_ID);
  assert.notEqual(next.turnId, batch.turnId);
  assert.equal(next.omittedMessages, 0);
  assert.equal(next.randomSelected, false);
});
