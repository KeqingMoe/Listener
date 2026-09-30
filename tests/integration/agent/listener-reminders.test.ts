import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Listener } from '../../../src/agent/listener.ts';
import { GroupRouter } from '../../../src/app/group-router.ts';
import { ReminderStore } from '../../../src/reminders/store.ts';
import { ReminderScheduler } from '../../../src/reminders/scheduler.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type { Api } from '../../../src/contracts/onebot.ts';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const group = '123456789',
  self = '900000001',
  actor = '12345';
const config: ListenerConfig = {
  ownerId: OWNER_ID,
  groupId: group,
  enabled: true,
  debounceMs: 1,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  toolPermissions: toolPermissions({
    ...MEMBER_TOOLS,
    create_reminder: 'direct',
  }),
};

class Mem implements Memory {
  entries: TimelineEntry[] = [];
  append(e: TimelineEntry) {
    this.entries.push(e);
    return true;
  }

  recent() {
    return this.entries;
  }

  find(id: string) {
    return this.entries.find((e) => e.messageId === id);
  }

  context() {
    return JSON.stringify(this.entries);
  }

  async compact() {}
  clear() {
    this.entries = [];
  }

  close() {}
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(
  options: {
    off?: boolean;
    send?: () => Promise<unknown>;
    login?: () => Promise<unknown>;
    projectionFailure?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'reminder-chain-')),
    path = join(directory, 'reminders.sqlite');
  let store = new ReminderStore({ path }),
    now = Date.now();
  let created = 0,
    received = 0,
    modelCalls = 0;
  const sends: any[] = [],
    memory = new Mem();
  const api: Api = {
    async call(action, params) {
      if (action === 'get_login_info') {
        return options.login ? options.login() : { user_id: self };
      }
      if (action === 'send_group_msg') {
        sends.push(structuredClone(params));
        return options.send
          ? options.send()
          : { message_id: String(100 + sends.length) };
      }
      throw new Error('unexpected RPC ' + action);
    },
  };
  const router = new GroupRouter({
    enabled: (g) => g === group,
    listGroups: async () => [{ group_id: group }],
    create: async () => {
      created++;
      const bot = new Listener(
        api,
        {
          async complete() {
            modelCalls++;
            throw new Error('reminder must not call model');
          },
        },
        memory,
        {
          ...config,
          toolPermissions: toolPermissions({
            ...MEMBER_TOOLS,
            create_reminder: options.off ? 'off' : 'direct',
          }),
        },
        () => 1,
        undefined,
        undefined,
        {
          ...sessionRuntime(
            {
              ...config,
              toolPermissions: toolPermissions({
                ...MEMBER_TOOLS,
                create_reminder: options.off ? 'off' : 'direct',
              }),
            }.groupId,
          ).runtime,
          ...(options.projectionFailure
            ? {
                world: {
                  groupId: group,
                  getState: () => ({ latestSequence: 0 }),
                  findMessage: () => undefined,
                  close() {},
                  append() {
                    throw new Error('projection unavailable');
                  },
                } as any,
              }
            : {}),
        },
      );
      const receive = bot.receive.bind(bot);
      bot.receive = async (...args) => {
        received++;
        return receive(...args);
      };
      return bot;
    },
  });
  let scheduler = new ReminderScheduler({
    store,
    currentAccount: () => router.reminderAccount,
    eligible: () => true,
    dispatch: (r, claim) => router.dispatchReminder(r, claim),
    now: () => now,
  });
  const create = (text = '交材料 [CQ:at,qq=all]') =>
    store.create(
      {
        selfId: self,
        groupId: group,
        creatorId: actor,
        sourceMessageId: '1',
        text,
        dueAt: now + 1000,
        timeZone: 'Asia/Shanghai',
      },
      now,
    );
  return {
    router,
    memory,
    sends,
    create,
    get store() {
      return store;
    },
    get scheduler() {
      return scheduler;
    },
    advance(ms = 1000) {
      now += ms;
    },
    get counters() {
      return { created, received, modelCalls };
    },
    async reopen() {
      await scheduler.stop();
      store.close();
      store = new ReminderStore({ path });
      scheduler = new ReminderScheduler({
        store,
        currentAccount: () => router.reminderAccount,
        eligible: () => true,
        dispatch: (r, claim) => router.dispatchReminder(r, claim),
        now: () => now,
      });
    },
    async close() {
      await scheduler.stop();
      await router.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('cold silent group restores persisted pending reminder and sends once without receive or model', async () => {
  const s = setup();
  try {
    const r = s.create();
    await s.reopen();
    await s.router.connect(self);
    assert.equal(s.router.residentSize, 0);
    s.advance();
    await s.scheduler.tick();
    assert.equal(s.store.get(self, group, r.id)?.state, 'sent');
    assert.deepEqual(s.sends, [
      {
        group_id: group,
        message: [{ type: 'text', data: { text: '【提醒】\n' + r.text } }],
      },
    ]);
    assert.deepEqual(s.counters, { created: 1, received: 0, modelCalls: 0 });
    await s.scheduler.tick();
    await s.reopen();
    await s.scheduler.tick();
    assert.equal(s.sends.length, 1);
  } finally {
    await s.close();
  }
});

test('offline pending catches up after authenticated reconnect without new group messages', async () => {
  const s = setup();
  try {
    await s.router.connect(self);
    const r = s.create();
    s.router.setConnected(false);
    s.advance(5000);
    await s.scheduler.tick();
    assert.equal(s.sends.length, 0);
    assert.equal(s.store.get(self, group, r.id)?.state, 'pending');
    await s.router.connect(self);
    await s.scheduler.tick();
    assert.equal(s.sends.length, 1);
    assert.equal(s.store.get(self, group, r.id)?.state, 'sent');
    assert.equal(s.counters.received, 0);
  } finally {
    await s.close();
  }
});

for (const mutation of ['cancel', 'update'] as const) {
  test(`queue-head claim rejects stale task after ${mutation}`, async () => {
    const started = deferred<void>(),
      gate = deferred<unknown>();
    let first = true;
    const s = setup({
      login: async () => {
        if (first) {
          first = false;
          started.resolve();
          return gate.promise;
        }
        return { user_id: self };
      },
    });
    try {
      await s.router.connect(self);
      const r = s.create();
      s.advance();
      const tick = s.scheduler.tick();
      await started.promise;
      const scope = {
        selfId: self,
        groupId: group,
        id: r.id,
        expectedRevision: r.revision,
      };
      if (mutation === 'cancel') {
        s.store.cancel(scope);
      } else {
        s.store.update(scope, { text: '已修改' });
      }
      gate.resolve({ user_id: self });
      await tick;
      assert.equal(s.sends.length, 0);
      if (mutation === 'update') {
        await s.scheduler.tick();
        assert.equal(s.sends.length, 1);
        assert.match(s.sends[0].message[0].data.text, /已修改/);
      } else {
        await s.scheduler.tick();
        assert.equal(s.sends.length, 0);
      }
    } finally {
      gate.resolve({ user_id: self });
      await s.close();
    }
  });
}

test('uncertain native delivery is never replayed, including after store reopen', async () => {
  const s = setup({
    send: async () => {
      throw new Error('network lost');
    },
  });
  try {
    await s.router.connect(self);
    const r = s.create();
    s.advance();
    await s.scheduler.tick();
    assert.equal(s.store.get(self, group, r.id)?.state, 'unknown');
    await s.scheduler.tick();
    await s.reopen();
    await s.scheduler.tick();
    assert.equal(s.sends.length, 1);
  } finally {
    await s.close();
  }
});

test('listener off permission prevents claim and delivery even when scheduler eligibility is permissive', async () => {
  const s = setup({ off: true });
  try {
    await s.router.connect(self);
    const r = s.create();
    s.advance();
    await s.scheduler.tick();
    assert.equal(s.sends.length, 0);
    assert.equal(s.store.get(self, group, r.id)?.state, 'pending');
  } finally {
    await s.close();
  }
});

test('late ACK after disconnect is persisted sent rather than replayed', async () => {
  const started = deferred<void>(),
    gate = deferred<unknown>();
  const s = setup({
    send: async () => {
      started.resolve();
      return gate.promise;
    },
  });
  try {
    await s.router.connect(self);
    const r = s.create();
    s.advance();
    const tick = s.scheduler.tick();
    await started.promise;
    assert.equal(s.store.get(self, group, r.id)?.state, 'sending');
    s.router.setConnected(false);
    gate.resolve({ message_id: '900' });
    await tick;
    assert.equal(s.store.get(self, group, r.id)?.state, 'sent');
    await s.router.connect(self);
    await s.scheduler.tick();
    assert.equal(s.sends.length, 1);
  } finally {
    gate.resolve({ message_id: '900' });
    await s.close();
  }
});

test('local message projection failure cannot erase an acknowledged reminder send', async () => {
  const s = setup({ projectionFailure: true });
  try {
    await s.router.connect(self);
    const r = s.create();
    s.advance();
    await s.scheduler.tick();
    assert.equal(s.sends.length, 1);
    assert.equal(s.store.get(self, group, r.id)?.state, 'sent');
    await s.scheduler.tick();
    assert.equal(s.sends.length, 1);
  } finally {
    await s.close();
  }
});
