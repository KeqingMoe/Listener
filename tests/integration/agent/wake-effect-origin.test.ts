import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import type { Model, Completion } from '../../../src/contracts/model.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type {
  EventOrigin,
  MessageReceipt,
} from '../../../src/contracts/visible-effect.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';

const self = '900000001';

function tool(name: string, args: unknown = { mode: 'hard' }): Completion {
  return {
    content: null,
    tool_calls: [
      {
        id: `${name}-${Math.random()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function message(id: string, direct = true) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '12345',
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'member' },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: self } }] : []),
      { type: 'text', data: { text: id } },
    ],
  };
}

const receipt = (): MessageReceipt => ({
  receivedAt: Date.now(),
  receivedMonotonic: performance.now(),
});

function fixture(
  complete: Model['complete'],
  randomProbability = 0,
  failObserver = false,
) {
  const runtime = sessionRuntime();
  const entries: TimelineEntry[] = [];
  const memory: Memory = {
    append(entry) {
      if (entries.some((e) => e.messageId === entry.messageId)) {
        return false;
      }
      entries.push(entry);
      return true;
    },
    recent: () => entries,
    find: (id) => entries.find((e) => e.messageId === id),
    context: () => '',
    async compact() {},
    clear() {
      entries.length = 0;
    },
    close() {},
  };
  const starts: EventOrigin[] = [],
    finishes: EventOrigin[] = [],
    effects: EventOrigin[] = [];
  let sent = 0;
  const bot = new Listener(
    {
      async call(action) {
        assert.equal(action, 'send_group_msg');
        return { message_id: String(10000 + ++sent) };
      },
    },
    { complete },
    memory,
    {
      groupId: LISTENER_GROUP,
      ownerId: OWNER_ID,
      enabled: true,
      debounceMs: 15,
      delayMaxMs: 15,
      cooldownMs: 0,
      retentionDays: 7,
      randomReplyProbability: randomProbability,
      randomCooldownMs: 0,
      toolPermissions: toolPermissions(MEMBER_TOOLS),
    },
    () => 0,
    undefined,
    undefined,
    {
      ...runtime.runtime,
      effectWaits: {
        begin(origin) {
          starts.push(origin);
          if (failObserver) {
            throw new Error('observer failed');
          }
        },
        finish(origin) {
          finishes.push(origin);
          if (failObserver) {
            throw new Error('observer failed');
          }
        },
      },
      effectObserver: {
        confirm(origin) {
          effects.push(origin);
          if (failObserver) {
            throw new Error('observer failed');
          }
        },
      },
    },
  );
  bot.setConnected(true);
  return {
    bot,
    starts,
    finishes,
    effects,
    runtime,
    async close() {
      await bot.stop();
    },
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('wake did not settle');
}

test('random admission receipt survives direct upgrade and native send uses the same logical origin', async () => {
  let rounds = 0;
  const f = fixture(
    async () =>
      ++rounds === 1
        ? tool('send_message', { segments: [{ type: 'text', text: 'hello' }] })
        : tool('finish'),
    1,
  );
  const original = receipt();
  try {
    await f.bot.receive(message('1', false), self, original);
    await f.bot.receive(message('2'), self, receipt());
    await until(() => f.finishes.length === 1);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.starts[0]?.receipt, original);
    assert.deepEqual(f.effects, f.starts);
    assert.deepEqual(f.finishes, f.starts);
  } finally {
    await f.close();
  }
});

test('messages during an active wake do not restart the origin or add a sample', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  let rounds = 0;
  const f = fixture(async () => {
    if (++rounds === 1) {
      await blocked;
      return tool('send_message', {
        segments: [{ type: 'text', text: 'hello' }],
      });
    }
    return tool('finish');
  });
  const original = receipt();
  try {
    await f.bot.receive(message('11'), self, original);
    await until(() => rounds === 1);
    await f.bot.receive(message('12'), self, receipt());
    release();
    await until(() => f.finishes.length === 1);
    await delay(25);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.starts[0]?.receipt, original);
    assert.deepEqual(f.effects, f.starts);
  } finally {
    release();
    await f.close();
  }
});

test('legacy receive without trusted receipt and host-only completion create no sample', async () => {
  let rounds = 0;
  const f = fixture(async () => {
    rounds++;
    return tool('finish');
  });
  try {
    await f.bot.receive(message('21'), self);
    await until(() => rounds === 1 && !f.runtime.session.state().wakeId);
    await f.bot.receiveSandboxResult({
      selfId: self,
      groupId: LISTENER_GROUP,
      jobId: 'job_test',
      status: 'completed',
      description: 'done',
      value: '42',
      finishedAt: Date.now(),
    });
    await until(() => rounds === 2 && !f.runtime.session.state().wakeId);
    assert.deepEqual(f.starts, []);
    assert.deepEqual(f.finishes, []);
    assert.deepEqual(f.effects, []);
  } finally {
    await f.close();
  }
});

test('silent message wakes finish without an effect and observer failures are fail-open', async () => {
  const f = fixture(async () => tool('finish'), 0, true);
  try {
    await f.bot.receive(message('31'), self, receipt());
    await until(() => f.finishes.length === 1);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.effects, []);
  } finally {
    await f.close();
  }
});
