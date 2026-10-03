import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewTool } from '../../../src/dashboard/contracts/review.ts';
import {
  deliveryItems,
  deliveryBlocks,
  finishReceipt,
} from '../../../src/dashboard/web/src/components/review/delivery-view.ts';
import { toolView } from '../../../src/dashboard/web/src/components/review/tool-summary.ts';

test('initial and appended context use the same parser without mutation', () => {
  const content = {
    context_update: {
      items: [
        {
          type: 'world_event',
          event: {
            type: 'message.created',
            payload: { message: { userId: '7', text: '首次消息' } },
          },
        },
      ],
    },
  };
  const before = JSON.stringify(content);
  assert.deepEqual(deliveryItems(content), deliveryItems(before));
  assert.equal(JSON.stringify(content), before);
  assert.deepEqual(deliveryItems('bad json'), []);
  assert.deepEqual(
    deliveryItems({ trigger: { messageIds: ['do-not-invent-input'] } }),
    [],
  );
});

test('event/job/event and unrecognised items keep persisted order, not event-time order', () => {
  const first = {
    type: 'message.created',
    occurred_at: 20,
    payload: { message: { userId: '7', text: '先投递' } },
  };
  const last = {
    type: 'message.created',
    occurred_at: 10,
    payload: { message: { userId: '8', text: '后投递' } },
  };
  const items = [
    { type: 'world_event', event: first },
    { type: 'job_result', result: '后台结果' },
    { type: 'world_event', event: last },
    'unknown item',
  ];
  const blocks = deliveryBlocks(items);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['events', 'job', 'events', 'other'],
  );
  assert.deepEqual(blocks[0], { kind: 'events', events: [first] });
  assert.deepEqual(blocks[2], { kind: 'events', events: [last] });
  if (blocks[0]?.kind === 'events') {
    assert.deepEqual(
      toolView('read_events', {}, { events: blocks[0].events }),
      toolView('read_events', {}, { events: [first] }),
    );
  }
});

const tool: ReviewTool = {
  ordinal: 1,
  name: 'finish',
  requestId: null,
  callId: null,
  state: 'finished',
  status: 'ok',
  outcome: 'handled',
  reasonCode: null,
  proposedAt: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  arguments: { mode: 'soft' },
  result: { status: 'ok', closed: false },
};

test('finish keeps soft continuation distinct from either mode actually closing', () => {
  assert.equal(finishReceipt(tool), '关闭回执：本轮继续（soft）');
  assert.equal(
    finishReceipt({ ...tool, result: { status: 'ok', closed: true } }),
    '关闭回执：本轮已关闭（soft）',
  );
  assert.equal(
    finishReceipt({
      ...tool,
      arguments: { mode: 'hard' },
      result: { status: 'ok', closed: true },
    }),
    '关闭回执：本轮已关闭（hard）',
  );
  assert.equal(
    finishReceipt({ ...tool, arguments: { mode: 'hard' } }),
    '关闭回执：本轮未关闭（hard）',
  );
});

test('a request, generic success, failure, pending result or non-boolean cannot confirm closure', () => {
  for (const patch of [
    { result: { status: 'executed' } },
    { result: { status: 'ok' } },
    { result: { status: 'ok', closed: 'true' } },
    { state: 'started' },
    { outcome: 'failed' as const },
    { name: 'other_tool' },
  ]) {
    assert.equal(finishReceipt({ ...tool, ...patch }), null);
  }
});
