import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateReactionReadResult,
  type ReactionLookup,
} from '../../../src/agent/reaction-presentation.ts';
import type { JsonObject } from '../../../src/contracts/json.ts';
import type { TimelineEntry } from '../../../src/contracts/messages.ts';

const row = (messageId: string): TimelineEntry => ({
  messageId,
  userId: '111',
  nickname: 'fixture',
  time: 42,
  text: `body-${messageId}`,
});
const observed = (extra: JsonObject = {}): JsonObject => ({
  status: 'observed',
  observed_at: 123456789,
  items: [
    { emoji_id: '76', emoji_type: '1', name: '赞', count: 3 },
    { emoji_id: '128077', emoji_type: 2, emoji: '👍', count: 2 },
  ],
  ...extra,
});
const expected = () => ({
  ...observed(),
  items: [
    { emoji_id: '76', emoji_type: '1', name: '赞', count: 3 },
    { emoji_id: '128077', emoji_type: '2', emoji: '👍', count: 2 },
  ],
});
const large = (status = 'observed'): JsonObject =>
  observed({
    status,
    omitted: 3,
    items: Array.from({ length: 30 }, (_, i) => ({
      emoji_id: String(128512 + i),
      emoji_type: '2',
      name: '名称'.repeat(50),
      emoji: '👍'.repeat(20),
      count: 1000,
    })),
  });

function strip(message: JsonObject) {
  const { reactions: _, ...rest } = message;
  return rest;
}

test('absence, invalid snapshots and throwing lookup never pretend a known zero count', () => {
  for (const lookup of [
    () => undefined,
    () => null,
    () => ({ status: 'observed', items: [] }),
    () => ({ status: 'none', observed_at: 1, items: [] }),
    () => {
      throw new Error('cache unavailable');
    },
  ] as ReactionLookup[]) {
    const result = { status: 'ok', message: row('1') };
    assert.deepEqual(annotateReactionReadResult(result, lookup), result);
  }
  const empty = annotateReactionReadResult(
    { status: 'ok', message: row('1') },
    () => observed({ status: 'empty_snapshot', items: [] }),
  );
  assert.deepEqual((empty.message as any).reactions, {
    status: 'empty_snapshot',
    observed_at: 123456789,
    items: [],
  });
  assert.ok(!JSON.stringify(empty).includes('contains_bot'));
});

test('read results annotate only the successful actual local or verified remote message', () => {
  for (const source of ['local', 'remote']) {
    const message = {
        ...row('12'),
        replyTo: '13',
        images: [{ id: 'img_12_1', index: 1 }],
        source,
      },
      result = {
        status: 'ok',
        message,
        message_id: 'ignored',
        nested: { messageId: '999' },
      },
      before = structuredClone(result),
      calls: string[] = [];
    const output = annotateReactionReadResult(result, (id) => {
      calls.push(id);
      return observed();
    });
    assert.deepEqual(calls, ['12']);
    assert.deepEqual(result, before);
    assert.deepEqual(strip(output.message as JsonObject), message);
    assert.deepEqual((output.message as any).reactions, expected());
    assert.notEqual(output.message, result.message);
  }
  for (const result of [
    { status: 'error', error: 'verification_failed', message: row('1') },
    { status: 'ok', members: [row('1')] },
    { status: 'ok', message: { message_id: '1' } },
    { status: 'ok', message: { messageId: 1 } },
  ]) {
    assert.deepEqual(
      annotateReactionReadResult(result, () => {
        assert.fail('not a readable message');
      }),
      result,
    );
  }
});

test('snapshots are bounded, trimmed with honest omissions, and never acquire own-membership or authority claims', () => {
  for (const status of ['observed', 'stale', 'partial']) {
    const input = large(status);
    Object.assign(input, {
      contains_bot: true,
      messageId: 'evil',
      text: 'overwrite',
      summary: 'overwrite',
      trusted_moderation_allowed: true,
      moderation_capabilities: { mute: 'direct' },
    });
    const result = { status: 'ok', message: row('1') },
      output = annotateReactionReadResult(result, () => input),
      annotation = (output.message as any).reactions;
    assert.ok(
      JSON.stringify(output).length - JSON.stringify(result).length <= 1000,
    );
    assert.ok(annotation.items.length <= 8);
    assert.ok(annotation.items.length > 0);
    assert.equal(annotation.omitted, 33 - annotation.items.length);
    assert.equal(annotation.status, status === 'stale' ? 'stale' : 'partial');
    assert.deepEqual(strip(output.message as JsonObject), row('1'));
    assert.ok(!JSON.stringify(annotation).includes('contains_bot'));
    assert.ok(!JSON.stringify(annotation).includes('overwrite'));
    assert.ok(
      !JSON.stringify(annotation).includes('trusted_moderation_allowed'),
    );
    assert.ok(!JSON.stringify(annotation).includes('moderation_capabilities'));
    assert.ok(
      annotation.items.every(
        (i: any) =>
          i.emoji_type === '2' &&
          [...i.name].length <= 64 &&
          [...i.emoji].length <= 16,
      ),
    );
  }
});

test('existing message fields are not overwritten by annotation or trusted lookup extras', () => {
  const entry = { ...row('1'), reactions: { status: 'original-field' } },
    result = { status: 'ok', message: entry };
  let calls = 0;
  const output = annotateReactionReadResult(result, () => {
    calls++;
    return observed();
  });
  assert.deepEqual(output, result);
  assert.equal(calls, 0);
  const safe = annotateReactionReadResult(
    { status: 'ok', message: row('1') },
    () =>
      observed({
        contains_bot: true,
        items: [
          {
            emoji_id: '76',
            emoji_type: 1,
            count: 0,
            contains_bot: true,
            user_ids: ['111'],
          },
        ],
      }),
  );
  assert.deepEqual((safe.message as any).reactions.items, [
    { emoji_id: '76', emoji_type: '1', count: 0 },
  ]);
});
