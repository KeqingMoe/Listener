import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupSender } from '../../../src/agent/group-sender.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type { TurnContext } from '../../../src/contracts/tools.ts';
import type {
  ConfirmedVisibleEffect,
  EventOrigin,
} from '../../../src/contracts/visible-effect.ts';

const origin: EventOrigin = {
  selfId: '456',
  groupId: '123',
  turnId: 'original-wake',
  receipt: { receivedAt: Date.now(), receivedMonotonic: performance.now() },
};
const context: TurnContext = {
  groupId: '123',
  selfId: '456',
  actorId: '789',
  messageId: '1',
  eventOrigin: origin,
};
const part = {
  text: 'fixture',
  segments: [{ type: 'text' as const, data: { text: 'fixture' } }],
};

function fixture(write: () => Promise<unknown>, projectionFails = false) {
  const rows: TimelineEntry[] = [];
  const observed: { origin: EventOrigin; event: ConfirmedVisibleEffect }[] = [];
  const memory: Memory = {
    recent: () => rows,
    find: (id) => rows.find((row) => row.messageId === id),
    append(entry) {
      assert.equal(observed.length, 1, 'confirmation precedes projection');
      if (projectionFails) {
        throw new Error('projection failed');
      }
      rows.push(entry);
      return true;
    },
    context: () => '',
    async compact() {},
    clear() {},
    close() {},
  };
  const sender = new GroupSender({
    api: { call: write },
    groupId: '123',
    memory: () => memory,
    generation: () => 0,
    live: () => true,
    remindersEnabled: () => false,
    effectObserver: {
      confirm(origin, event) {
        observed.push({ origin, event });
        throw new Error('observation unavailable');
      },
    },
  });
  return { sender, observed };
}

test('sender observes new ACK before projection, and never observes a duplicate', async () => {
  const f = fixture(async () => ({ message_id: '22' }), true);
  const sent = await f.sender.sendPart(part, context);
  assert.equal(sent.local_projection_failed, true);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0]!.origin, origin);
  assert.equal(f.observed[0]!.event.kind, 'message_sent');
  await assert.rejects(
    f.sender.sendPart(part, context),
    /duplicate_message_ack/,
  );
  assert.equal(f.observed.length, 1);
});

test('late ACK retains original scope after cancellation while invalid ACK has no effect', async () => {
  const controller = new AbortController();
  const f = fixture(async () => {
    controller.abort();
    return { message_id: '23' };
  });
  const sent = await f.sender.sendPart(part, context, controller.signal);
  assert.equal(sent.cancelled_after_dispatch, true);
  assert.equal(f.observed[0]!.origin, origin);
  const invalid = fixture(async () => ({}));
  await assert.rejects(
    invalid.sender.sendPart(part, context),
    /delivery_unknown/,
  );
  assert.equal(invalid.observed.length, 0);
});

test('a later part failure cannot erase the first confirmed send', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls > 1) {
      throw new Error('later part failed');
    }
    return { message_id: '24' };
  });
  await f.sender.sendPart(part, context);
  await assert.rejects(f.sender.sendPart(part, context), /later part failed/);
  assert.equal(f.observed.length, 1);
});
