import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  argumentsLine,
  resultProblem,
  segmentsText,
  toolView,
} from '../../../src/dashboard/web/src/components/review/tool-summary.ts';

test('segments render as readable text without the reply marker', () => {
  assert.equal(
    segmentsText([
      { type: 'reply', message_id: '1' },
      { type: 'at', user_id: '100000001' },
      { type: 'text', text: '你好' },
      { type: 'face', id: 14, name: '微笑' },
      { type: 'face', id: 15 },
      { type: 'image', content_status: 'not_viewed' },
      { type: 'unsupported', kind: 'json' },
    ]),
    '@100000001 你好[微笑][表情15][图片][json]',
  );
  assert.equal(segmentsText(null), '');
});

test('send_message shows the outgoing text and reply target', () => {
  assert.deepEqual(
    toolView(
      'send_message',
      { reply_to: '42', segments: [{ type: 'text', text: '收到' }] },
      { status: 'ok' },
    ),
    { kind: 'send', text: '收到', replyTo: '42' },
  );
});

test('read_messages lists speakers, marks bot and recalled, and caps length', () => {
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
  assert.deepEqual(view.lines[0], { who: '群友0', text: '第0条', bot: true });
  assert.deepEqual(view.lines[1], {
    who: '群友1',
    text: '第1条',
    recalled: true,
  });
  assert.equal(view.lines[2]!.text, '旧文本');
});

test('read_events shows messages inline and other events by type', () => {
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
              nickname: '群友',
              representation: 'segments',
              segments: [{ type: 'text', text: 'hi' }],
            },
          },
        },
        { type: 'poke.created', actor_id: '100000001', payload: null },
      ],
    },
  );
  assert.deepEqual(view, {
    kind: 'messages',
    lines: [
      { who: '群友', text: 'hi' },
      { who: '100000001', text: '〈poke.created〉' },
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
