import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplyBatch, type BatchItem } from '../../../src/agent/reply-batch.ts';
import type { MessageSegment } from '../../../src/contracts/messages.ts';

const digits = (prefix: string, index: number) =>
  prefix.repeat(29) + String(index).padStart(3, '0');

function item(
  index: number,
  signed = false,
  segments: MessageSegment[] = [{ type: 'text', text: 'literal' }],
): BatchItem {
  const messageId = `${signed ? '-' : ''}${digits('1', index)}`,
    userId = digits('2', index);
  return {
    entry: {
      messageId,
      userId,
      nickname: 'nickname is expendable',
      text: 'internal compatibility only',
      time: 1700000000 + index,
      replyTo: `${signed ? '-' : ''}${'3'.repeat(32)}`,
      segments,
    },
    context: { groupId: '22', selfId: '99', actorId: userId, messageId },
    sequence: index + 1,
    received: 1700000000000 + index,
    trigger: index % 2 ? 'quote' : 'mention',
    ...(index === 17 ? { unverifiedQuote: true } : {}),
  };
}

for (const signed of [false, true]) {
  test(`structured batch preserves64 full-width identities and replies under24000 (${signed ? 'signed33' : 'unsigned32'} message IDs)`, () => {
    const segments: MessageSegment[] = Array.from({ length: 128 }, () => ({
      type: 'text',
      text: 'x'.repeat(4000),
    }));
    const inputs = Array.from({ length: 64 }, (_, index) =>
      item(index, signed, segments),
    );
    // 最后一项先到达时，不能打乱模型来源或调用方的顺序。
    const batch = new ReplyBatch(inputs[63]!, 0, false);
    for (const incoming of inputs.slice(0, 63)) {
      batch.add(incoming, 0);
    }
    const payload = batch.payload();
    assert.ok(JSON.stringify(payload).length <= 24000);
    const current = payload.current_batch as any,
      messages = current.messages as any[];
    assert.equal(messages.length, 64);
    assert.equal(current.omitted_messages, 0);
    assert.equal(current.omitted_direct, 0);
    assert.equal(current.unverified_references, true);
    assert.equal(batch.hasUnverifiedQuote, true);
    assert.equal(batch.hasNonOwnerDirect, true);
    assert.equal(current.truncated_messages, 64);
    assert.equal(current.truncated_ids_omitted, 64);
    assert.equal(Object.hasOwn(current, 'truncated_message_ids'), false);
    assert.equal(current.reason, 'payload_character_limit');
    assert.equal(payload.trigger_kind, 'direct');
    assert.deepEqual(
      payload.trusted_direct_requests,
      inputs.map(({ entry, trigger }) => ({
        message_id: entry.messageId,
        user_id: entry.userId,
        trigger,
      })),
    );
    messages.forEach((message, index) => {
      const original = inputs[index]!.entry;
      assert.equal(message.messageId, original.messageId);
      assert.equal(message.userId, original.userId);
      assert.equal(message.replyTo, original.replyTo);
      assert.equal(message.time, original.time);
      assert.equal(message.messageId.length, signed ? 33 : 32);
      assert.equal(message.replyTo.length, signed ? 33 : 32);
      assert.equal(message.userId.length, 32);
      assert.equal(message.content_truncated, true);
      assert.ok(message.segments_omitted > 0);
      assert.ok(Array.isArray(message.segments));
      assert.equal(Object.hasOwn(message, 'text'), false);
      assert.equal(original.segments!.length, 128);
      assert.equal(
        (original.segments![0] as { type: 'text'; text: string }).text.length,
        4000,
      );
    });
    // 返回的显示列表和调用方名单不能与捕获的batch共享引用。
    messages[0].messageId = 'tampered';
    messages[0].segments.push({ type: 'text', text: 'tampered' });
    (payload.trusted_direct_requests as any[])[0].user_id = 'tampered';
    const repeated = batch.payload();
    assert.ok(JSON.stringify(repeated).length <= 24000);
    assert.equal(
      (repeated.current_batch as any).messages[0].messageId,
      inputs[0]!.entry.messageId,
    );
    assert.equal(
      (repeated.trusted_direct_requests as any[])[0].user_id,
      inputs[0]!.entry.userId,
    );
    assert.ok(
      !(repeated.current_batch as any).messages[0].segments.some(
        (segment: any) => segment.text === 'tampered',
      ),
    );
  });
}

test('typed batch clones both input segments and projected output without interpreting literal markers', () => {
  const original = item(0, false, [
    { type: 'text', text: '[QQ表情：吃瓜 id=271] [CQ:at,qq=all]' },
    { type: 'face', id: '271' },
    { type: 'at', user_id: '42' },
  ]);
  const expectedId = original.entry.messageId,
    expectedActor = original.entry.userId;
  const batch = new ReplyBatch(original, 0, false);
  (original.entry.segments![0] as { type: 'text'; text: string }).text =
    'mutated after capture';
  original.entry.userId = '999';
  let output = batch.payload();
  let message = (output.current_batch as any).messages[0];
  assert.equal(message.messageId, expectedId);
  assert.equal(message.userId, expectedActor);
  assert.equal(
    message.segments[0].text,
    '[QQ表情：吃瓜 id=271] [CQ:at,qq=all]',
  );
  assert.equal(message.segments[0].type, 'text');
  assert.equal(message.segments[1].type, 'face');
  assert.equal(message.segments[2].type, 'at');
  message.segments[0].text = 'mutated after projection';
  message.segments[1].id = '0';
  (output.trusted_direct_requests as any[])[0].user_id = '888';
  output = batch.payload();
  message = (output.current_batch as any).messages[0];
  assert.equal(
    message.segments[0].text,
    '[QQ表情：吃瓜 id=271] [CQ:at,qq=all]',
  );
  assert.equal(message.segments[1].id, '271');
  assert.equal(
    (output.trusted_direct_requests as any[])[0].user_id,
    expectedActor,
  );
});
