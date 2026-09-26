import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOneBotEvent, recordToolMessage } from '../src/world-event-ingest.js';
import { WorldEventStore } from '../src/world-events.js';
import type { TimelineEntry } from '../src/contracts.js';
const eventBase = { post_type: 'message', message_type: 'group', group_id: '123', self_id: '999', user_id: '100', message_id: 10, message: [{ type: 'text', data: { text: 'hello' } }], sender: { user_id: '100', nickname: 'Alice' }, time: 1700000000 };
const root = () => mkdtempSync(join(tmpdir(), 'qqbot-world-ingest-'));

test('normalizes a group message into typed append input and identifies self echo', () => {
  const input = normalizeOneBotEvent(eventBase, '999', 'onebot', 1700000001); assert.equal(input?.type, 'message.created'); assert.equal(input?.groupId, '123'); assert.equal(input?.actorId, '100'); assert.equal(input?.dedupKey, 'message:10'); assert.equal((input?.payload as any).message.segments[0].type, 'text');
  const self = normalizeOneBotEvent({ ...eventBase, user_id: '999', sender: { user_id: '999' }, message_id: 11 }, '999'); assert.equal((self?.payload as any).message.bot, true);
});

test('rejects private, wrong-group, malformed, and unknown events without guessing', () => {
  assert.equal(normalizeOneBotEvent({ ...eventBase, message_type: 'private' }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ ...eventBase, group_id: 'bad' }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ ...eventBase, sender: { user_id: '101' } }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ post_type: 'notice', notice_type: 'mystery', group_id: '123' }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ ...eventBase, message: [{ type: 'text', data: { get text() { throw Error(); } } }] }, '999'), undefined);
});

test('normalizes recall, poke, and dirty reaction notices conservatively', () => {
  const recall = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'group_recall', group_id: '123', message_id: '10', operator_id: '200', user_id: '100' }, '999'); assert.equal(recall?.type, 'message.recalled'); assert.equal(recall?.actorId, '200'); assert.equal((recall?.payload as any).recalled_by, '200');
  const poke = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: '123', user_id: '100', target_id: '999' }, '999'); assert.equal(poke?.type, 'poke.created'); assert.equal(poke?.subject?.id, '999');
  const reaction = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'group_msg_emoji_like', group_id: '123', message_id: '10', user_id: '100', is_add: true, likes: { count: 999 } }, '999'); assert.equal(reaction?.type, 'reaction.changed'); assert.equal((reaction?.payload as any).action, undefined); assert.equal(reaction?.actorId, undefined);
});

test('uses explicit provider event identity only for reaction/poke dedup', () => {
  const a = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: '123', user_id: '100', target_id: '999', event_id: 'n1' }, '999'); const b = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: '123', user_id: '100', target_id: '999' }, '999'); assert.match(a?.dedupKey ?? '', /^notice:/); assert.equal(b?.dedupKey, undefined);
});

test('recordToolMessage writes only validated ACK entries and store deduplicates echo', () => {
  const base = root(), path = join(base, 'world.sqlite'), store = new WorldEventStore({ path, groupId: '123' }); const entry: TimelineEntry = { messageId: '55', userId: '999', nickname: 'Bot', text: 'sent', time: 1700000000, bot: true, segments: [{ type: 'text', text: 'sent' }] };
  try { const first = recordToolMessage(store, entry, 1700000001); const echo = normalizeOneBotEvent({ ...eventBase, user_id: '999', sender: { user_id: '999' }, message_id: 55, message: [{ type: 'text', data: { text: 'sent' } }] }, '999', 'onebot', 1700000002); const second = echo ? store.append(echo) : undefined; assert.equal(second?.eventId, first.eventId); assert.equal(store.readEvents({ limit: 10 }).returned, 1); } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
});
