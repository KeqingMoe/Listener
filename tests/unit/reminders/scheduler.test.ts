import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderStore } from '../../../src/reminders/store.ts';
import {
  ReminderScheduler,
  type ReminderSchedulerOptions,
} from '../../../src/reminders/scheduler.ts';

const input = {
  selfId: '1',
  groupId: '2',
  creatorId: '3',
  sourceMessageId: '4',
  text: 'private',
  dueAt: 2000,
  timeZone: 'UTC',
};

function setup(dispatch: ReminderSchedulerOptions['dispatch']) {
  const store = new ReminderStore({ path: ':memory:' });
  let account: string | undefined = '1',
    online = true,
    now = 2000;
  const r = store.create(input, 1000);
  const scheduler = new ReminderScheduler({
    store,
    currentAccount: () => account,
    eligible: () => online,
    dispatch,
    now: () => now,
  });
  return {
    store,
    r,
    scheduler,
    account: (v: string | undefined) => {
      account = v;
    },
    online: (v: boolean) => {
      online = v;
    },
    now: (v: number) => {
      now = v;
    },
  };
}

test('offline never dispatches, preclaim throws remain pending and next tick retries', async () => {
  let calls = 0;
  const s = setup(async (_, claim) => {
    if (++calls === 1) {
      throw new Error('private provider detail');
    }
    assert.equal(claim(), true);
    return { state: 'sent', messageId: '8' };
  });
  try {
    s.online(false);
    await s.scheduler.tick();
    assert.equal(calls, 0);
    s.online(true);
    await s.scheduler.tick();
    assert.equal(s.store.get('1', '2', s.r.id)?.state, 'pending');
    await s.scheduler.tick();
    assert.equal(s.store.get('1', '2', s.r.id)?.state, 'sent');
    await s.scheduler.tick();
    assert.equal(calls, 2);
  } finally {
    await s.scheduler.stop();
    s.store.close();
  }
});

test('postclaim errors are unknown and never replayed', async () => {
  let calls = 0;
  const s = setup(async (_, claim) => {
    calls++;
    assert.equal(claim(), true);
    throw new Error('secret');
  });
  try {
    await s.scheduler.tick();
    await s.scheduler.tick();
    assert.equal(calls, 1);
    const r = s.store.get('1', '2', s.r.id)!;
    assert.equal(r.state, 'unknown');
    assert.equal(r.reason, 'dispatch_unknown');
  } finally {
    await s.scheduler.stop();
    s.store.close();
  }
});

test('claim rechecks live account and eligibility at queue head', async () => {
  let unblock!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    wait = new Promise<void>((r) => (unblock = r));
  const s = setup(async (_, claim) => {
    entered();
    await wait;
    assert.equal(claim(), false);
    return { state: 'failed', reason: 'not_dispatched' };
  });
  try {
    const pending = s.scheduler.tick();
    await ready;
    s.account('9');
    unblock();
    await pending;
    assert.equal(s.store.get('1', '2', s.r.id)?.state, 'pending');
  } finally {
    await s.scheduler.stop();
    s.store.close();
  }
});

test('confirmed ACK survives disconnect and stop; ticks never overlap', async () => {
  let unblock!: () => void,
    entered!: () => void,
    calls = 0;
  const ready = new Promise<void>((r) => (entered = r)),
    wait = new Promise<void>((r) => (unblock = r));
  const s = setup(async (_, claim) => {
    calls++;
    assert.equal(claim(), true);
    assert.equal(claim(), false);
    entered();
    await wait;
    return { state: 'sent', messageId: '9' };
  });
  try {
    const p = s.scheduler.tick();
    await ready;
    assert.equal(s.scheduler.tick(), p);
    s.online(false);
    const stopped = s.scheduler.stop();
    unblock();
    await stopped;
    assert.equal(calls, 1);
    assert.equal(s.store.get('1', '2', s.r.id)?.state, 'sent');
    await s.scheduler.tick();
    assert.equal(calls, 1);
  } finally {
    s.store.close();
  }
});

test('cancelled or changed revision at queue head cannot send stale text', async () => {
  const s = setup(async (reminder, claim) => {
    s.store.cancel(
      {
        selfId: '1',
        groupId: '2',
        id: reminder.id,
        expectedRevision: reminder.revision,
      },
      2000,
    );
    assert.equal(claim(), false);
    return { state: 'failed', reason: 'not_dispatched' };
  });
  try {
    await s.scheduler.tick();
    assert.equal(s.store.get('1', '2', s.r.id)?.state, 'cancelled');
  } finally {
    await s.scheduler.stop();
    s.store.close();
  }
});

test('expired reminders are not dispatched and failed delivery is terminal', async () => {
  let count = 0;
  const s = setup(async (_, claim) => {
    count++;
    assert.equal(claim(), true);
    return { state: 'failed', reason: 'not_dispatched' };
  });
  try {
    await s.scheduler.tick();
    assert.equal(s.store.get('1', '2', s.r.id)?.state, 'failed');
    const r = s.store.create({ ...input, dueAt: 3000 }, 2000);
    s.now(r.expiresAt);
    await s.scheduler.tick();
    assert.equal(count, 1);
    assert.equal(s.store.get('1', '2', r.id)?.state, 'expired');
  } finally {
    await s.scheduler.stop();
    s.store.close();
  }
});
