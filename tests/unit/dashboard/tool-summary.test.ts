import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  argumentsLine,
  collectNames,
  partsText,
  resultProblem,
  segmentParts,
  toolView,
} from '../../../src/dashboard/web/src/components/review/tool-summary.ts';

test('segments become typed parts without the reply marker', () => {
  const parts = segmentParts([
    { type: 'reply', message_id: '1' },
    { type: 'at', user_id: '100000001' },
    { type: 'text', text: '你好' },
    { type: 'text', text: '' },
    { type: 'face', id: 14, name: '微笑' },
    { type: 'face', id: 15 },
    { type: 'image', content_status: 'not_viewed' },
    { type: 'unsupported', kind: 'json' },
  ]);
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['at', 'text', 'face', 'face', 'media', 'other'],
  );
  assert.equal(partsText(parts), '[@100000001]你好[微笑][表情15][图片][json]');
  assert.deepEqual(segmentParts(null), []);
});

test('at parts show the collected name and keep the id as a tooltip', () => {
  const names = new Map([['100000001', '群友甲']]);
  assert.deepEqual(
    segmentParts([{ type: 'at', user_id: '100000001' }], names),
    [{ kind: 'at', text: '@群友甲', title: '100000001' }],
  );
});

test('names come from messages, events and members, then the server fallback; card wins over nickname', () => {
  const names = collectNames(
    [
      {
        result: {
          messages: [{ userId: '1', nickname: '甲' }],
          events: [{ payload: { message: { userId: '2', nickname: '乙' } } }],
        },
      },
      { result: { members: [{ user_id: '3', nickname: '丙', card: '丙卡' }] } },
      { result: { member: { user_id: '4', nickname: '丁', card: '' } } },
      { result: { messages: [{ userId: '1', nickname: '甲后来' }] } },
      { result: 'not an object' },
    ],
    { 1: '甲旧名', 5: '戊' },
  );
  assert.deepEqual(
    [...names],
    [
      ['1', '甲'],
      ['2', '乙'],
      ['3', '丙卡'],
      ['4', '丁'],
      ['5', '戊'],
    ],
  );
});

test('send_message shows the outgoing parts and reply target', () => {
  assert.deepEqual(
    toolView(
      'send_message',
      { reply_to: '42', segments: [{ type: 'text', text: '收到' }] },
      { status: 'ok' },
    ),
    { kind: 'send', parts: [{ kind: 'text', text: '收到' }], replyTo: '42' },
  );
});

test('read_messages lists speakers with ids, marks bot and recalled, and caps length', () => {
  const message = (i: number, extra = {}) => ({
    messageId: String(i),
    userId: '100000001',
    nickname: `群友${i}`,
    time: 0,
    representation: 'segments',
    segments: [{ type: 'text', text: `第${i}条` }],
    ...extra,
  });
  const view = toolView(
    'read_messages',
    { limit: 30 },
    {
      status: 'ok',
      messages: [
        message(0, { bot: true }),
        message(1, { recalled: true }),
        message(2, { representation: 'legacy_text', text: '旧文本' }),
        ...Array.from({ length: 22 }, (_, i) => message(i + 3)),
      ],
    },
  );
  assert.equal(view?.kind, 'messages');
  if (view?.kind !== 'messages') {
    return;
  }
  assert.equal(view.lines.length, 20);
  assert.equal(view.more, 5);
  assert.deepEqual(view.lines[0], {
    who: '群友0',
    userId: '100000001',
    parts: [{ kind: 'text', text: '第0条' }],
    bot: true,
  });
  assert.equal(view.lines[1]!.recalled, true);
  assert.equal(partsText(view.lines[2]!.parts), '旧文本');
});

test('read_events shows messages inline and other events by type and actor name', () => {
  const view = toolView(
    'read_events',
    { limit: 5 },
    {
      status: 'ok',
      events: [
        {
          type: 'message.created',
          payload: {
            message: {
              userId: '100000002',
              nickname: '群友',
              representation: 'segments',
              segments: [{ type: 'text', text: 'hi' }],
            },
          },
        },
        { type: 'poke.created', actor_id: '100000002', payload: null },
      ],
    },
    new Map([['100000002', '群友']]),
  );
  assert.deepEqual(view, {
    kind: 'messages',
    lines: [
      {
        who: '群友',
        userId: '100000002',
        parts: [{ kind: 'text', text: 'hi' }],
      },
      {
        who: '群友',
        userId: '100000002',
        parts: [{ kind: 'other', text: 'poke.created' }],
      },
    ],
    more: 0,
  });
});

test('unknown tools fall back to a compact argument line', () => {
  assert.equal(toolView('get_group_info', {}, {}), null);
  assert.equal(
    argumentsLine({ user_id: '1', limit: 5, nested: { a: 1 }, flag: true }),
    'user_id=1 limit=5 nested flag=true',
  );
  assert.equal(argumentsLine({ text: 'x'.repeat(200) }, 20).length, 20);
  assert.equal(argumentsLine(null), '');
});

test('result problems surface non-ok status with the error code', () => {
  assert.equal(resultProblem({ status: 'ok' }), null);
  assert.equal(resultProblem('text'), null);
  assert.equal(
    resultProblem({ status: 'error', error: 'invalid_arguments' }),
    'error: invalid_arguments',
  );
  assert.equal(
    resultProblem({ status: 'confirmation_required' }),
    'confirmation_required',
  );
});
