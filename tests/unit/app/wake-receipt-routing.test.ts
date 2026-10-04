import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GroupRouter,
  type GroupHandler,
} from '../../../src/app/group-router.ts';
import type { MessageReceipt } from '../../../src/contracts/visible-effect.ts';

test('lazy routing preserves ingress receipt and stable routing never invents one', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const seen: (MessageReceipt | undefined)[] = [];
  const handler: GroupHandler = {
    async receive(_event, _selfId, receipt) {
      seen.push(receipt);
    },
    setConnected() {},
    async stop() {},
  };
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [{ group_id: '8' }],
    create: async () => {
      await blocked;
      return handler;
    },
  });
  const event = {
    post_type: 'message',
    message_type: 'group',
    self_id: '9',
    group_id: '8',
    user_id: '7',
    message_id: 1,
    time: Date.now() / 1000,
    message: [{ type: 'text', data: { text: 'hello' } }],
  };
  const receipt = Object.freeze({ receivedAt: 1000, receivedMonotonic: 10 });
  try {
    await router.connect('9');
    const pending = router.receive(event, '9', receipt);
    assert.equal(seen.length, 0);
    release();
    await pending;
    assert.equal(seen[0], receipt);
    await router.receive({ ...event, message_id: 2 }, '9');
    assert.equal(seen.length, 2);
    assert.equal(seen[1], undefined);
  } finally {
    release();
    await router.stop();
  }
});
