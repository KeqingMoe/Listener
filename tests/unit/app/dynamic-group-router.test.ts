import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GroupRouter,
  type GroupHandler,
} from '../../../src/app/group-router.ts';
import type { Reminder } from '../../../src/reminders/store.ts';

const reminder = (groupId = '1', selfId = '99'): Reminder => ({
  id: 'rem_test',
  selfId,
  groupId,
  creatorId: '7',
  sourceMessageId: '1',
  text: 'reminder',
  dueAt: 1,
  expiresAt: 2,
  timeZone: 'Asia/Shanghai',
  state: 'pending',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});
const message = (groupId: string) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: '99',
  group_id: groupId,
  user_id: '7',
  message_id: 1,
  time: Date.now() / 1000,
  message: [{ type: 'text', data: { text: 'hello' } }],
});
const leave = (groupId: string, user = '99') => ({
  post_type: 'notice',
  notice_type: 'group_decrease',
  sub_type: 'leave',
  self_id: '99',
  group_id: groupId,
  user_id: user,
  time: Date.now() / 1000,
});
const join = (groupId: string) => ({
  ...leave(groupId),
  notice_type: 'group_increase',
  sub_type: 'approve',
});

function service() {
  const state = { received: 0, closed: 0, connected: false };
  const handler: GroupHandler = {
    async receive() {
      state.received++;
    },
    setConnected(value) {
      state.connected = value;
    },
    async stop() {
      state.closed++;
      state.connected = false;
    },
  };
  return { state, handler };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('reminder opens a silent member without fabricated receive and rejects unauthorized targets', async () => {
  const s = service();
  let created = 0,
    claims = 0,
    sends = 0,
    enabled = true;
  s.handler.sendReminder = async (_task, claim) => {
    assert.equal(claim(), true);
    sends++;
    return { state: 'sent', messageId: '8' };
  };
  const router = new GroupRouter({
    enabled: (id) => enabled && id !== '2',
    listGroups: async () => [{ group_id: '1' }, { group_id: '2' }],
    create: async () => {
      created++;
      return s.handler;
    },
  });
  assert.equal(router.reminderAccount, undefined);
  await router.connect('99');
  assert.equal(router.reminderAccount, '99');
  assert.equal(router.residentSize, 0);
  for (const task of [
    reminder('2'),
    reminder('3'),
    reminder('01'),
    reminder('1', '98'),
  ]) {
    await assert.rejects(
      router.dispatchReminder(task, () => {
        claims++;
        return true;
      }),
      /reminder_unavailable/,
    );
  }
  assert.equal(created, 0);
  assert.deepEqual(
    await router.dispatchReminder(reminder(), () => {
      claims++;
      return true;
    }),
    { state: 'sent', messageId: '8' },
  );
  assert.equal(created, 1);
  assert.equal(claims, 1);
  assert.equal(sends, 1);
  assert.equal(s.state.received, 0);
  enabled = false;
  await assert.rejects(router.dispatchReminder(reminder(), () => true));
  router.setConnected(false);
  assert.equal(router.reminderAccount, undefined);
  await router.stop();
});

test('failed and invalid reconnect snapshots fence reminders but preserve ordinary receive', async () => {
  const s = service();
  let response: unknown = [{ group_id: '1' }],
    fail = false,
    sends = 0;
  s.handler.sendReminder = async () => {
    sends++;
    return { state: 'sent', messageId: '8' };
  };
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => {
      if (fail) {
        throw Error('offline');
      }
      return response;
    },
    create: async () => s.handler,
  });
  await router.connect('99');
  await router.receive(message('1'), '99');
  for (const invalid of [true, false]) {
    fail = invalid;
    response = {};
    await router.connect('99');
    assert.equal(router.reminderAccount, undefined);
    await assert.rejects(router.dispatchReminder(reminder(), () => true));
    await router.receive(message('1'), '99');
  }
  assert.equal(sends, 0);
  assert.equal(s.state.received, 3);
  response = [{ group_id: '1' }];
  await router.connect('99');
  assert.equal(router.reminderAccount, '99');
  await router.stop();
});

test('reminder factory is fenced by disconnect, leave, identity replacement and shutdown', async () => {
  for (const change of ['disconnect', 'leave', 'identity', 'stop']) {
    const s = service(),
      gate = deferred<GroupHandler>(),
      started = deferred<void>();
    let claims = 0,
      sends = 0;
    s.handler.sendReminder = async () => {
      sends++;
      return { state: 'sent', messageId: '8' };
    };
    const router = new GroupRouter({
      enabled: () => true,
      listGroups: async () => [{ group_id: '1' }],
      create: async () => {
        started.resolve();
        return gate.promise;
      },
    });
    await router.connect('99');
    const dispatch = assert.rejects(
      router.dispatchReminder(reminder(), () => {
        claims++;
        return true;
      }),
      /reminder_unavailable/,
    );
    await started.promise;
    let transition: Promise<void> = Promise.resolve();
    if (change === 'disconnect') {
      router.setConnected(false);
    } else if (change === 'leave') {
      transition = router.receive(leave('1'), '99');
    } else if (change === 'identity') {
      transition = router.connect('98');
    } else {
      transition = router.stop();
    }
    gate.resolve(s.handler);
    await Promise.all([dispatch, transition]);
    assert.equal(s.state.closed, 1);
    assert.equal(sends, 0);
    assert.equal(claims, 0);
    assert.equal(router.residentSize, 0);
    await router.stop();
  }
});

test('queued reminder claim rechecks membership and sending does not hold structural queue', async () => {
  const s = service(),
    started = deferred<void>(),
    gate = deferred<void>();
  let claims = 0;
  s.handler.sendReminder = async (_task, claim) => {
    started.resolve();
    await gate.promise;
    assert.equal(claim(), false);
    throw Error('reminder_unavailable');
  };
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [{ group_id: '1' }],
    create: async () => s.handler,
  });
  await router.connect('99');
  const dispatch = assert.rejects(
    router.dispatchReminder(reminder(), () => {
      claims++;
      return true;
    }),
  );
  await started.promise;
  await router.receive(leave('1'), '99');
  assert.equal(s.state.closed, 1);
  gate.resolve();
  await dispatch;
  assert.equal(claims, 0);
  await router.stop();
});

test('static handlers become reminder ready only after authenticated connect', async () => {
  const s = service();
  s.handler.sendReminder = async (_task, claim) => {
    assert.equal(claim(), true);
    return { state: 'sent', messageId: '8' };
  };
  const router = new GroupRouter([['1', s.handler]]);
  router.setConnected(true);
  await assert.rejects(router.dispatchReminder(reminder(), () => true));
  await router.connect('99');
  assert.equal(router.reminderAccount, '99');
  await router.dispatchReminder(reminder(), () => true);
  await router.stop();
  assert.equal(router.reminderAccount, undefined);
});

test('all mode discovers beyond 32, allocates lazily and rejects explicit exclusions before create', async () => {
  const opened: string[] = [];
  const router = new GroupRouter({
    enabled: (id) => id !== '4',
    listGroups: async () =>
      Array.from({ length: 70 }, (_, i) => ({ group_id: String(i + 1) })),
    create: async (id) => {
      opened.push(id);
      return service().handler;
    },
  });
  await router.connect('99');
  assert.equal(router.size, 69);
  assert.equal(router.residentSize, 0);
  await router.receive(message('4'), '99');
  assert.deepEqual(opened, []);
  await router.receive(message('70'), '99');
  await router.receive(message('71'), '99');
  assert.deepEqual(opened, ['70', '71']);
  assert.equal(router.size, 70);
  await router.stop();
});

test('private, wrong-self, absent-self and malformed events cannot allocate unknown groups', async () => {
  let created = 0;
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [],
    create: async () => {
      created++;
      return service().handler;
    },
  });
  await router.connect('99');
  for (const packet of [
    { ...message('1'), self_id: '98' },
    { ...message('1'), self_id: undefined },
    { ...message('1'), message_type: 'private' },
    { ...message('1'), message: undefined },
    { ...message('1'), user_id: undefined },
    { ...message('1'), group_id: '01' },
    {
      post_type: 'notice',
      notice_type: 'group_increase',
      group_id: '1',
      self_id: '99',
      user_id: '99',
      sub_type: 'invalid',
    },
  ]) {
    await router.receive(packet, '99');
  }
  assert.equal(created, 0);
  assert.equal(router.size, 0);
  await router.stop();
});

test('own exit closes once, ordinary exits do not, and delayed old messages cannot resurrect a departed group', async () => {
  const opened: ReturnType<typeof service>[] = [];
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [{ group_id: '1' }],
    create: async () => {
      const s = service();
      opened.push(s);
      return s.handler;
    },
  });
  await router.connect('99');
  await router.receive(message('1'), '99');
  await router.receive(leave('1', '7'), '99');
  assert.equal(opened[0]!.state.closed, 0);
  await router.receive(leave('1'), '99');
  assert.equal(opened[0]!.state.closed, 1);
  assert.equal(router.size, 0);
  await router.receive(message('1'), '99');
  assert.equal(opened.length, 1);
  await router.receive(join('1'), '99');
  assert.equal(opened.length, 2);
  assert.equal(router.size, 1);
  await router.stop();
  assert.equal(opened[1]!.state.closed, 1);
});

test('a late membership snapshot cannot undo newer joins or exits; failed reconnect is not an empty group list', async () => {
  const snapshot = deferred<unknown>();
  let count = 0;
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: () =>
      ++count === 1 ? snapshot.promise : Promise.reject(Error('offline')),
    create: async () => service().handler,
  });
  const ready = router.connect('99');
  await router.receive(join('2'), '99');
  await router.receive(leave('1'), '99');
  snapshot.resolve([{ group_id: '1' }]);
  await ready;
  assert.deepEqual(router.groupIds, ['2']);
  router.setConnected(false);
  await router.connect('99');
  assert.deepEqual(router.groupIds, ['2']);
  await router.stop();
});

test('exit during pending allocation closes uninstalled resource without delivering; no overlapping rejoin instances', async () => {
  const created = service(),
    gate = deferred<GroupHandler>(),
    started = deferred<void>();
  let calls = 0;
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [],
    create: async () => {
      calls++;
      started.resolve();
      return gate.promise;
    },
  });
  await router.connect('99');
  const receiving = router.receive(message('1'), '99');
  await started.promise;
  const leaving = router.receive(leave('1'), '99');
  gate.resolve(created.handler);
  await Promise.all([receiving, leaving]);
  assert.equal(calls, 1);
  assert.equal(created.state.closed, 1);
  assert.equal(created.state.received, 0);
  assert.equal(router.residentSize, 0);
  assert.equal(router.size, 0);
  await router.stop();
});

test('successful snapshot removal tombstones both resident and unopened groups until proven rejoin', async () => {
  for (const allocate of [false, true]) {
    let listed = [{ group_id: '1' }];
    const opened: ReturnType<typeof service>[] = [];
    const router = new GroupRouter({
      enabled: () => true,
      listGroups: async () => listed,
      create: async () => {
        const s = service();
        opened.push(s);
        return s.handler;
      },
    });
    await router.connect('99');
    if (allocate) {
      await router.receive(message('1'), '99');
    }
    router.setConnected(false);
    listed = [];
    await router.connect('99');
    await router.receive(message('1'), '99');
    assert.equal(router.size, 0);
    assert.equal(opened.length, allocate ? 1 : 0);
    if (allocate) {
      assert.equal(opened[0]!.state.closed, 1);
    }
    if (allocate) {
      listed = [{ group_id: '1' }];
      await router.connect('99');
      await router.receive(message('1'), '99');
    } else {
      await router.receive(join('1'), '99');
    }
    assert.equal(router.size, 1);
    assert.equal(opened.length, allocate ? 2 : 1);
    await router.stop();
  }
});

test('ordinary traffic during discovery cannot defeat an authoritative removal snapshot', async () => {
  const snapshot = deferred<unknown>(),
    s = service();
  let calls = 0,
    created = 0;
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () =>
      ++calls === 1 ? [{ group_id: '1' }] : snapshot.promise,
    create: async () => {
      created++;
      return s.handler;
    },
  });
  await router.connect('99');
  await router.receive(message('1'), '99');
  router.setConnected(false);
  const discovery = router.connect('99');
  await router.receive(message('1'), '99');
  snapshot.resolve([]);
  await discovery;
  await router.receive(message('1'), '99');
  assert.equal(router.size, 0);
  assert.equal(created, 1);
  assert.equal(s.state.closed, 1);
  await router.stop();
});

test('snapshot revocation fences a pending factory and late events before the structural queue drains', async () => {
  const started = deferred<void>(),
    gate = deferred<GroupHandler>(),
    responded = deferred<void>(),
    old = service();
  let listed = [{ group_id: '1' }],
    calls = 0,
    created = 0;
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => {
      if (++calls > 1) {
        responded.resolve();
      }
      return listed;
    },
    create: async () => {
      created++;
      started.resolve();
      return gate.promise;
    },
  });
  await router.connect('99');
  const pending = router.receive(message('1'), '99');
  await started.promise;
  router.setConnected(false);
  listed = [];
  const reconnect = router.connect('99');
  await responded.promise;
  await Promise.resolve();
  const late = router.receive(message('1'), '99');
  gate.resolve(old.handler);
  await Promise.all([pending, reconnect, late]);
  assert.equal(created, 1);
  assert.equal(old.state.closed, 1);
  assert.equal(old.state.received, 0);
  assert.equal(router.size, 0);
  await router.stop();
});

test('a closing group cannot block stable peers or overlap its own rejoin', async () => {
  const gate = deferred<void>(),
    started = deferred<void>(),
    opened: Array<{ id: string; s: ReturnType<typeof service> }> = [];
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [{ group_id: '1' }, { group_id: '2' }],
    create: async (id) => {
      const s = service();
      if (id === '1' && !opened.some((row) => row.id === '1')) {
        s.handler.stop = async () => {
          started.resolve();
          await gate.promise;
          s.state.closed++;
        };
      }
      opened.push({ id, s });
      return s.handler;
    },
  });
  await router.connect('99');
  await router.receive(message('1'), '99');
  await router.receive(message('2'), '99');
  const leaving = router.receive(leave('1'), '99');
  await started.promise;
  await router.receive(message('2'), '99');
  assert.equal(opened[1]!.s.state.received, 2);
  const rejoin = router.receive(join('1'), '99');
  assert.equal(opened.length, 2);
  gate.resolve();
  await Promise.all([leaving, rejoin]);
  assert.equal(opened.length, 3);
  assert.equal(opened[0]!.s.state.closed, 1);
  await router.stop();
});

test('identity change attempts every close and revokes metadata even if one handler rejects', async () => {
  const a = service(),
    b = service(),
    published: string[][] = [];
  let attempts = 0;
  a.handler.stop = async () => {
    attempts++;
    throw Error('close failed');
  };
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [{ group_id: '1' }, { group_id: '2' }],
    create: async (id) => (id === '1' ? a.handler : b.handler),
    membershipChanged: (ids) => published.push([...ids]),
  });
  await router.connect('99');
  await router.receive(message('1'), '99');
  await router.receive(message('2'), '99');
  await assert.rejects(router.connect('98'));
  assert.equal(attempts, 1);
  assert.equal(b.state.closed, 1);
  assert.equal(router.size, 0);
  assert.deepEqual(published.at(-1), []);
  await router.receive({ ...message('2'), self_id: '98' }, '98');
  assert.equal(b.state.received, 1);
  await assert.rejects(router.stop());
});

test('invalid snapshots cannot empty membership and do not invoke accessor fields', async () => {
  let response: unknown = [{ group_id: '1' }],
    touched = false;
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => response,
    create: async () => service().handler,
  });
  await router.connect('99');
  for (const bad of [
    null,
    {},
    [{ group_id: '1' }, {}],
    [
      {
        get group_id() {
          touched = true;
          return '1';
        },
      },
    ],
  ]) {
    response = bad;
    await router.connect('99');
    assert.deepEqual(router.groupIds, ['1']);
  }
  assert.equal(touched, false);
  await router.stop();
});

test('a new group policy failure cannot prevent authoritative retirement of an old group', async () => {
  const s = service();
  let listed = [{ group_id: '1' }];
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => listed,
    create: async () => s.handler,
    membershipChanged: (ids) => {
      if (ids.includes('2')) {
        throw Error('path conflict');
      }
    },
  });
  await router.connect('99');
  await router.receive(message('1'), '99');
  listed = [{ group_id: '2' }];
  await assert.rejects(router.connect('99'));
  assert.equal(s.state.closed, 1);
  assert.equal(router.size, 0);
  assert.equal(router.residentSize, 0);
  await router.stop();
});

test('an exit still closes resources if publishing metadata throws', async () => {
  const s = service();
  let fail = false;
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [],
    create: async () => s.handler,
    membershipChanged: () => {
      if (fail) {
        throw Error('storage');
      }
    },
  });
  await router.connect('99');
  await router.receive(message('1'), '99');
  fail = true;
  await assert.rejects(router.receive(leave('1'), '99'));
  assert.equal(s.state.closed, 1);
  assert.equal(router.residentSize, 0);
  assert.equal(router.size, 0);
  fail = false;
  await router.stop();
});

test('disconnect and stop fence pending allocation and repeated stop waits for the same cleanup', async () => {
  const s = service(),
    gate = deferred<GroupHandler>(),
    started = deferred<void>();
  const router = new GroupRouter({
    enabled: () => true,
    listGroups: async () => [],
    create: async () => {
      started.resolve();
      return gate.promise;
    },
  });
  await router.connect('99');
  const receive = router.receive(message('1'), '99');
  await started.promise;
  router.setConnected(false);
  const first = router.stop(),
    second = router.stop();
  gate.resolve(s.handler);
  await Promise.all([receive, first, second]);
  assert.equal(s.state.closed, 1);
  assert.equal(s.state.received, 0);
});
