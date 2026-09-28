import assert from 'node:assert/strict';
import test from 'node:test';
import { OWNER_ID, type Memory, type Model, type TimelineEntry } from '../src/contracts/index.js';
import { ReplyBatch, snapshotMemory, type BatchItem } from '../src/reply-batch.js';

function item(sequence: number, trigger?: 'mention' | 'quote', received = sequence * 10): BatchItem {
  const id = String(sequence);
  return {
    entry: { messageId: id, userId: `user${id}`, nickname: `name${id}`, text: `body${id}`, time: 1000 - sequence,
      images: [{ id: `img_${id}_0`, index: 0 }] },
    context: { groupId: 'group', actorId: `user${id}`, messageId: id, selfId: 'bot' },
    sequence, received, ...(trigger ? { trigger } : {}),
  };
}

test('late classified earlier caller displaces newest direct when the roster is full',()=>{
 const batch=new ReplyBatch(item(2,'mention'),20);for(let seq=3;seq<=65;seq++)batch.add(item(seq,'mention'),20);
 batch.add(item(1,'quote'),20);
 assert.deepEqual(batch.direct.map(x=>x.sequence),Array.from({length:64},(_,i)=>i+1));
 assert.equal(batch.omittedDirect,1);assert.equal(batch.omittedMessages,1);
});

test('1000 ordinary arrivals retain 64, sort by arrival sequence rather than timestamp', () => {
  const batch = new ReplyBatch(item(0), 20);
  for (let i = 1; i < 1000; i++) batch.add(item(i), 20);
  assert.equal(batch.items.length, 64);
  assert.equal(batch.omittedMessages, 936);
  assert.equal(batch.omittedDirect, 0);
  assert.deepEqual(batch.items.map(x => x.sequence), Array.from({ length: 64 }, (_, i) => i + 936));
  assert.equal(batch.primary.sequence, 999);
  assert.equal(batch.readyAt, 20);
  assert.equal(batch.openedAt, 0);
  assert.equal(batch.randomSelected, false);
  assert.ok((batch as unknown as { seen: Set<string> }).seen.size <= 256);
});

test('direct requests evict ordinary entries and the first 64 direct requests stay pinned', () => {
  const batch = new ReplyBatch(item(0, 'mention'), 20);
  for (let i = 1; i <= 63; i++) batch.add(item(i), 20);
  batch.add(item(64, 'quote'), 20);
  assert.equal(batch.items.some(x => x.sequence === 1), false);
  for (let i = 65; i <= 126; i++) batch.add(item(i, 'mention'), 20);
  assert.equal(batch.direct.length, 64);
  const pinned = batch.items.map(x => x.entry.messageId);
  batch.add(item(127), 20);
  batch.add(item(128, 'quote'), 20);
  assert.deepEqual(batch.items.map(x => x.entry.messageId), pinned);
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
  const batch = new ReplyBatch(owned(0), 0);
  for (let i = 1; i < 64; i++) batch.add(owned(i), 0);
  assert.equal(batch.hasNonOwnerDirect, false);
  batch.add(item(64, 'quote'), 0);
  assert.equal(batch.hasNonOwnerDirect, true);
  assert.equal(batch.omittedDirect, 1);
  assert.equal(batch.items.every(value => value.entry.userId === OWNER_ID), true);
  batch.add(owned(65), 0);
  assert.equal(batch.hasNonOwnerDirect, true);
});

test('duplicate IDs do not grow counts, even after eviction or omission', () => {
  const batch = new ReplyBatch(item(0), 1);
  for (let i = 1; i < 70; i++) batch.add(item(i, 'mention'), 1);
  const before = [batch.omittedMessages, batch.omittedDirect, batch.readyAt, batch.openedAt];
  batch.add(item(0, 'quote', -100), 1000);
  batch.add(item(69, 'quote', -100), 1000);
  batch.add(item(1, 'quote', -100), 1000);
  assert.deepEqual([batch.omittedMessages, batch.omittedDirect, batch.readyAt, batch.openedAt], before);
  assert.equal(batch.items.length, 64);
});

test('promotion anchors first direct; older resolved quotes only move deadline earlier', () => {
  const batch = new ReplyBatch(item(10), 500, true);
  batch.add(item(20, 'mention', 200), 50);
  assert.equal(batch.readyAt, 250);
  batch.add(item(30, 'mention', 300), 1000);
  assert.equal(batch.readyAt, 250);
  batch.add(item(15, 'quote', 150), 500);
  assert.equal(batch.readyAt, 250);
  batch.add(item(5, 'quote', 50), 50);
  assert.equal(batch.readyAt, 100);
  assert.equal(batch.openedAt, 50);
  assert.deepEqual(batch.items.map(x => x.sequence), [5, 10, 15, 20, 30]);
  assert.equal(batch.randomSelected, true);
  assert.equal(batch.primary.sequence, 5);
  const next = new ReplyBatch(item(100), 50);
  assert.notEqual(next.turnId, batch.turnId);
  assert.equal(next.omittedMessages, 0);
  assert.equal(next.randomSelected, false);
});

test('batches deep-copy inputs and payload results do not mutate the batch', () => {
  const first = item(1, 'mention');
  const second = item(2, 'quote');
  const batch = new ReplyBatch(first, 0);
  batch.add(second, 0);
  first.entry.text = 'mutated';
  first.entry.images![0]!.id = 'mutated';
  first.context.actorId = 'mutated';
  second.entry.nickname = 'mutated';
  assert.equal(batch.primary.entry.text, 'body1');
  assert.equal(batch.primary.entry.images![0]!.id, 'img_1_0');
  assert.equal(batch.primary.context.actorId, 'user1');
  assert.equal(batch.items[1]!.entry.nickname, 'name2');
  const payload = batch.payload() as any;
  payload.current_batch.messages[0].text = 'mutated';
  payload.trusted_direct_requests[0].user_id = 'mutated';
  assert.equal((batch.payload() as any).current_batch.messages[0].text, 'body1');
  assert.equal((batch.payload() as any).trusted_direct_requests[0].user_id, 'user1');
});

test('payload retains full text when it fits, sanitizes names, and omits attachment duplication', () => {
  const first = item(1, 'quote');
  first.entry.text = 'x'.repeat(5000);
  first.entry.nickname = '\u0000\n' + 'a'.repeat(40) + '\u007f';
  first.entry.replyTo = '42';
  const payload = new ReplyBatch(first, 0).payload() as any;
  const message = payload.current_batch.messages[0];
  assert.equal(message.text.length, 5000);
  assert.equal(message.nickname, 'a'.repeat(24));
  assert.equal(message.replyTo, '42');
  assert.equal(message.images, undefined);
  assert.deepEqual(payload.current_batch.truncated_message_ids, []);
  assert.deepEqual(payload.trusted_direct_requests, [{ message_id: '1', user_id: 'user1', trigger: 'quote' }]);
});

test('worst escaped bodies, names, and 32-digit provenance remain within 24000 serialized characters', () => {
  const inputs = Array.from({ length: 64 }, (_, i) => {
    const value = item(i, i % 2 ? 'quote' : 'mention');
    value.entry.messageId = String(i).padStart(32, '9');
    value.entry.userId = '8'.repeat(32);
    value.entry.replyTo = '7'.repeat(32);
    value.entry.text = '\u0000\n"\\'.repeat(5000);
    value.entry.nickname = '"\\'.repeat(100);
    return value;
  });
  const batch = new ReplyBatch(inputs[0]!, 0);
  for (const value of inputs.slice(1)) batch.add(value, 0);
  const payload = batch.payload() as any;
  assert.ok(JSON.stringify(payload).length <= 24_000);
  assert.equal(payload.current_batch.messages.length, 64);
  assert.equal(payload.trusted_direct_requests.length, 64);
  assert.equal(payload.current_batch.truncated_message_ids.length, 64);
  for (let i = 0; i < 64; i++) {
    const message = payload.current_batch.messages[i];
    assert.equal(message.messageId, inputs[i]!.entry.messageId);
    assert.equal(message.userId, inputs[i]!.entry.userId);
    assert.equal(message.time, inputs[i]!.entry.time);
    assert.equal(message.replyTo, inputs[i]!.entry.replyTo);
    assert.equal(message.text_truncated, true);
    assert.ok(message.text.length > 0);
  }
});

function source(entries: TimelineEntry[], context?: string): Memory & { writes: number } {
  return {
    writes: 0,
    recent: () => entries,
    find: id => entries.find(x => x.messageId === id),
    context: () => context ?? JSON.stringify({ messages: entries, summary: 'old summary' }),
    append(entry) { this.writes++; entries.push(entry); return true; },
    async compact() { this.writes++; entries.splice(0); },
    clear() { this.writes++; entries.splice(0); },
    close() { this.writes++; },
  };
}

test('snapshot freezes old context and arrivals, pins compacted batch and overrides stale records', async () => {
  const entries = Array.from({ length: 350 }, (_, i) => item(i).entry);
  const memory = source(entries);
  const pinned = item(1, 'mention').entry;
  const override = { ...item(349).entry, text: 'trusted replacement' };
  const snapshot = snapshotMemory(memory, [pinned, override], new Set(['348']));
  assert.equal(snapshot.recent().length, 300);
  assert.equal(snapshot.find('49'), undefined);
  assert.equal(snapshot.find('348'), undefined);
  assert.equal(snapshot.find('1')!.text, 'body1');
  assert.equal(snapshot.find('349')!.text, 'trusted replacement');
  const frozenContext = snapshot.context();
  assert.equal(JSON.parse(frozenContext).messages.some((x: TimelineEntry) => x.messageId === '348'), false);
  assert.equal(JSON.parse(frozenContext).messages.at(-1).text, 'body349');
  memory.append(item(1000).entry);
  await memory.compact({} as Model);
  memory.clear();
  pinned.text = 'mutated';
  override.text = 'mutated';
  assert.equal(snapshot.context(), frozenContext);
  assert.equal(snapshot.find('1000'), undefined);
  assert.equal(snapshot.find('1')!.text, 'body1');
  const returned = snapshot.recent();
  returned[0]!.text = 'mutated';
  returned.splice(0);
  snapshot.find('1')!.images![0]!.id = 'mutated';
  assert.equal(snapshot.recent().length, 300);
  assert.equal(snapshot.find('1')!.images![0]!.id, 'img_1_0');
  const writes = memory.writes;
  assert.equal(snapshot.append(item(2000).entry), false);
  await snapshot.compact({} as Model);
  snapshot.clear();
  snapshot.close();
  assert.equal(memory.writes, writes);
  assert.equal(snapshot.find('1')!.text, 'body1');
});

test('snapshot filters array contexts and preserves legacy and other JSON context shapes', () => {
  const entries = [item(1).entry, item(2).entry];
  const snapshot = snapshotMemory(source(entries, JSON.stringify(entries)), [], new Set(['2']));
  assert.deepEqual(JSON.parse(snapshot.context()).map((x: TimelineEntry) => x.messageId), ['1']);
  for (const context of ['legacy text', '{ "summary": "unchanged" }', '"legacy JSON string"']) {
    assert.equal(snapshotMemory(source(entries, context), []).context(), context);
  }
});

test('snapshot trusts batch records despite exclusion and bounds history and batch pins', () => {
  const entries = Array.from({ length: 400 }, (_, i) => item(i + 100).entry);
  const pins = Array.from({ length: 70 }, (_, i) => item(i).entry);
  const snapshot = snapshotMemory(source(entries), pins, new Set(['1']));
  assert.equal(snapshot.recent().length, 364);
  assert.equal(snapshot.find('1')!.messageId, '1');
  assert.equal(snapshot.find('64'), undefined);
  assert.equal(snapshot.find('199'), undefined);
  assert.equal(snapshot.find('200')!.messageId, '200');
});
