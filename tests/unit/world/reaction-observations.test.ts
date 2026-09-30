import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { ReactionObservations } from '../../../src/world/reaction-observations.ts';
import type { Api } from '../../../src/contracts/onebot.ts';
import type { JsonObject } from '../../../src/contracts/json.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';

const group = '22';
const entry = (id: string, replyTo?: string): TimelineEntry => ({
  messageId: id,
  userId: '123',
  nickname: 'member',
  text: 'not a trusted ID: 888',
  time: Number(id),
  ...(replyTo ? { replyTo } : {}),
});

function memory(ids: string[] = ['1'], quoted?: string): Memory {
  const entries = ids.map((id) => entry(id, quoted));
  return {
    append() {
      throw new Error('frozen');
    },
    recent() {
      return structuredClone(entries);
    },
    find(id) {
      return structuredClone(entries.find((e) => e.messageId === id));
    },
    context() {
      return '';
    },
    async compact() {},
    clear() {},
    close() {},
  };
}

const row = (
  emoji_id: unknown = '76',
  emoji_type: unknown = '1',
  likes_cnt: unknown = '3',
): JsonObject => ({ emoji_id, emoji_type, likes_cnt });
const raw = (id = '1', list: unknown = [row()]): JsonObject => ({
  message_type: 'group',
  group_id: group,
  message_id: id,
  sender: { user_id: '123' },
  emoji_likes_list: list,
  private: 'SECRET never echo',
});
const notice = (id: unknown = '1'): JsonObject => ({
  post_type: 'notice',
  notice_type: 'group_msg_emoji_like',
  group_id: group,
  message_id: id,
  likes: [{ emoji_id: '76', count: '12345' }],
  is_add: true,
});

function fixture(handler?: (id: string) => Promise<unknown>, groupId = group) {
  const calls: string[] = [];
  const api: Api = {
    async call(action, params = {}) {
      assert.equal(action, 'get_msg');
      assert.deepEqual(Object.keys(params), ['message_id']);
      const id = String(params.message_id);
      calls.push(id);
      return handler ? handler(id) : raw(id);
    },
  };
  return { calls, observer: new ReactionObservations(api, groupId, 7), api };
}

function gate<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
}

const items = (annotation: JsonObject | undefined) =>
  annotation?.items as JsonObject[] | undefined;

test('verified counters are minimal cloned annotations with matching catalog labels only', () => {
  const f = fixture(),
    m = memory();
  f.observer.ingest(
    '1',
    raw('1', [
      row(),
      row('128077', '2', 4),
      row('987654', '1', '0'),
      row('76', '2', '5'),
      row('76', '9', '6'),
    ]),
    m,
  );
  const result = f.observer.get('1')!;
  assert.equal(result.status, 'observed');
  assert.equal(result.message_id, '1');
  assert.equal(typeof result.observed_at, 'number');
  assert.equal(items(result)![0]!.name, '赞');
  assert.equal(items(result)![1]!.emoji, '👍');
  assert.equal(items(result)![1]!.count, 4);
  assert.equal(items(result)![2]!.count, 0);
  for (const item of items(result)!.slice(2)) {
    assert.equal(item.name, undefined);
  }
  assert.doesNotMatch(
    JSON.stringify(result),
    /SECRET|private|user_id|self|own|member|people/,
  );
  items(result)![0]!.count = 999;
  items(result)!.push({ private: true });
  assert.equal(items(f.observer.get('1'))![0]!.count, 3);
  assert.equal(items(f.observer.get('1'))!.length, 5);
  assert.equal(f.calls.length, 0);
});

test('empty snapshot is not a zero claim; missing/malformed metadata remains unknown or stale', () => {
  const f = fixture(),
    m = memory();
  f.observer.ingest('1', raw('1', []), m);
  assert.equal(f.observer.get('1')!.status, 'empty_snapshot');
  assert.deepEqual(items(f.observer.get('1')), []);
  const { emoji_likes_list: _discard, ...missing } = raw();
  for (const bad of [
    missing,
    raw('1', null),
    raw('1', {}),
    raw('1', 'SECRET'),
  ]) {
    const other = fixture();
    other.observer.ingest('1', bad, m);
    assert.equal(other.observer.get('1'), undefined);
    f.observer.ingest('1', bad, m);
    assert.equal(f.observer.get('1')!.status, 'stale');
  }
  f.observer.ingest('1', raw('1', [row('76', '1', 'bad')]), m);
  assert.equal(f.observer.get('1')!.status, 'partial');
  assert.equal(f.observer.get('1')!.omitted, 1);
});

test('count and ID normalization is unsigned, canonical and safe; bad rows are omitted', () => {
  const f = fixture(),
    m = memory();
  const bad = [
    '01',
    '-0',
    '-1',
    '1.5',
    '1e2',
    '1\n',
    '1\r',
    '1\u2028',
    '9007199254740992',
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    null,
    true,
    {},
    -0,
  ];
  for (const value of bad) {
    for (const record of [
      row('76', '1', value),
      row(value, '1', '1'),
      row('76', value, '1'),
    ]) {
      f.observer.ingest('1', raw('1', [record]), m);
      assert.equal(f.observer.get('1')!.status, 'partial');
      assert.deepEqual(items(f.observer.get('1')), []);
    }
  }
  f.observer.ingest(
    '1',
    raw('1', [row(0, 1, 0), row('76', '1', String(Number.MAX_SAFE_INTEGER))]),
    m,
  );
  assert.equal(items(f.observer.get('1'))![0]!.emoji_id, '0');
  assert.equal(items(f.observer.get('1'))![0]!.count, 0);
  assert.equal(items(f.observer.get('1'))![1]!.count, Number.MAX_SAFE_INTEGER);
});

test('caps items at eight, counts omissions, does not sum duplicate rows, and bounds scanning', () => {
  const f = fixture(),
    m = memory();
  f.observer.ingest(
    '1',
    raw(
      '1',
      Array.from({ length: 12 }, (_, i) => row(String(10000 + i))),
    ),
    m,
  );
  assert.equal(items(f.observer.get('1'))!.length, 8);
  assert.equal(f.observer.get('1')!.omitted, 4);
  assert.equal(f.observer.get('1')!.status, 'partial');
  f.observer.ingest('1', raw('1', [row(), row('76', '1', '100')]), m);
  assert.equal(items(f.observer.get('1'))![0]!.count, 3);
  assert.equal(f.observer.get('1')!.omitted, 1);
  const sparse = new Array(100_000);
  sparse[99_999] = row();
  f.observer.ingest('1', raw('1', sparse), m);
  assert.deepEqual(items(f.observer.get('1')), []);
  assert.equal(f.observer.get('1')!.omitted, 100_000);
  let reads = 0;
  const accessor = [row()];
  Object.defineProperty(accessor, '0', {
    get() {
      reads++;
      return row();
    },
  });
  f.observer.ingest('1', raw('1', accessor), m);
  assert.equal(reads, 0);
});

test('foreign/private/remapped or contradictory sender metadata never enters observations', () => {
  const m = memory();
  for (const bad of [
    null,
    {},
    { ...raw(), group_id: '33' },
    { ...raw(), group_id: '022' },
    { ...raw(), message_type: 'private' },
    { ...raw(), message_id: '2' },
    { ...raw(), message_id: '01' },
    { ...raw(), sender: { user_id: '999' } },
    { ...raw(), sender: {} },
    { ...raw(), user_id: '999' },
    { ...raw(), user_id: '123\n' },
    { ...raw(), user_id: undefined },
  ]) {
    const f = fixture();
    f.observer.ingest('1', raw(), m);
    f.observer.ingest('1', bad, m);
    assert.equal(f.observer.get('1'), undefined);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.observer.ingest(
    '1',
    {
      ...raw(),
      group_id: 22,
      message_id: 1,
      sender: { user_id: 123 },
      user_id: 123,
    },
    m,
  );
  assert.equal(f.observer.get('1')!.status, 'observed');
});

test('only known local or structurally quoted messages can be ingested/refreshed', async () => {
  const f = fixture(),
    m = memory(['1'], '7');
  f.observer.ingest('888', raw('888'), m);
  assert.equal(f.observer.get('888'), undefined);
  await f.observer.refresh(m, ['888'], undefined, true);
  assert.equal(f.calls.length, 0);
  f.observer.ingest('7', { ...raw('7'), sender: { user_id: '987' } }, m);
  assert.equal(f.observer.get('7')!.status, 'observed');
  f.observer.ingest('7', { ...raw('7'), group_id: '33' }, m);
  assert.equal(f.observer.get('7'), undefined);
  const other = fixture();
  await other.observer.refresh(m, ['7'], undefined, true);
  assert.deepEqual(other.calls, ['7']);
});

test('notice is a group-scoped dirty hint only; absent actor and untrusted counts do not fabricate state', () => {
  const f = fixture(),
    m = memory(['1'], '7');
  f.observer.ingest('1', raw(), m);
  assert.equal(f.observer.notice(notice(), m), true);
  assert.equal(f.observer.get('1')!.status, 'stale');
  assert.equal(items(f.observer.get('1'))![0]!.count, 3);
  assert.equal(
    f.observer.notice(
      {
        ...notice(),
        is_add: false,
        likes: [{ count: '-999999' }],
        user_id: undefined,
      },
      m,
    ),
    true,
  );
  assert.equal(items(f.observer.get('1'))![0]!.count, 3);
  assert.equal(f.observer.notice(notice('7'), m), true);
  assert.equal(f.observer.get('7'), undefined);
  for (const bad of [
    { ...notice(), group_id: '33' },
    { ...notice(), group_id: '022' },
    { ...notice(), post_type: 'message' },
    { ...notice(), notice_type: 'other' },
    notice('888'),
    notice('01'),
    notice('-0'),
    notice('9007199254740992'),
  ]) {
    assert.equal(f.observer.notice(bad, m), false);
  }
  assert.equal(f.calls.length, 0);
});

test('revision tokens prevent notice/read races, eviction/reset resurrection and invalid aliases', () => {
  const f = fixture(),
    m = memory();
  const first = f.observer.revision('1');
  assert.ok(first > 0);
  f.observer.markDirty('1');
  f.observer.ingest('1', raw(), m, first);
  assert.equal(f.observer.get('1'), undefined);
  const next = f.observer.revision('1');
  assert.ok(next > first);
  f.observer.ingest('1', raw(), m, next);
  assert.equal(f.observer.get('1')!.status, 'observed');
  const old = f.observer.revision('1');
  f.observer.clear();
  const fresh = f.observer.revision('1');
  assert.ok(fresh > old);
  f.observer.ingest('1', raw(), m, old);
  assert.equal(f.observer.get('1'), undefined);
  for (let i = 2; i <= 514; i++) {
    f.observer.revision(String(i));
  }
  const recreated = f.observer.revision('1');
  assert.ok(recreated > fresh);
  f.observer.ingest('1', raw(), m, fresh);
  assert.equal(f.observer.get('1'), undefined);
  for (const id of ['01', '-0', '1\n', '9007199254740992']) {
    assert.equal(f.observer.revision(id), 0);
  }
  f.observer.ingest('1', raw(), m, 0);
  assert.equal(f.observer.get('1'), undefined);
});

test('notice race cannot replace an existing snapshot with apparently fresh counts', async () => {
  const response = gate(),
    f = fixture(() => response.promise),
    m = memory();
  f.observer.ingest('1', raw(), m);
  f.observer.markDirty('1');
  const pending = f.observer.refresh(m, ['1']);
  await tick();
  f.observer.notice(notice(), m);
  response.resolve(raw('1', [row('76', '1', '999')]));
  await pending;
  assert.equal(f.observer.get('1')!.status, 'stale');
  assert.equal(items(f.observer.get('1'))![0]!.count, 3);
});

test('newer direct evidence wins over an earlier outstanding refresh', async () => {
  const response = gate(),
    f = fixture(() => response.promise),
    m = memory();
  const pending = f.observer.refresh(m, ['1']);
  await tick();
  f.observer.ingest('1', raw('1', [row('76', '1', '9')]), m);
  response.resolve(raw('1', [row('76', '1', '1')]));
  await pending;
  assert.equal(items(f.observer.get('1'))![0]!.count, 9);
  assert.equal(f.observer.get('1')!.status, 'observed');
});

test('refresh budget prioritizes four dirty visible, then preferred, then newest recent', async () => {
  const f = fixture(),
    ids = Array.from({ length: 15 }, (_, i) => String(i + 1)),
    m = memory(ids);
  for (const id of ['1', '2', '3', '4', '5']) {
    f.observer.markDirty(id);
  }
  f.observer.markDirty('888');
  await f.observer.refresh(m, ['6', '6', '888', '7']);
  assert.deepEqual(f.calls, ['1', '2', '3', '4', '6', '7', '15', '14']);
});

test('refresh materializes rich recent memory once despite 512 off-scope dirty IDs', async () => {
  const f = fixture(),
    base = memory(Array.from({ length: 300 }, (_, i) => String(i + 1)));
  let reads = 0;
  const m: Memory = {
    ...base,
    recent() {
      reads++;
      return base.recent();
    },
  };
  for (let i = 1000; i < 1512; i++) {
    f.observer.markDirty(String(i));
  }
  await f.observer.refresh(m, ['1']);
  assert.equal(reads, 1);
  assert.equal(f.calls.length, 8);
  assert.equal(f.calls[0], '1');
});

test('targeted refresh considers only preferred and fresh metadata avoids duplicate get_msg', async () => {
  const f = fixture(),
    m = memory(['1', '2', '3'], '7');
  f.observer.markDirty('2');
  await f.observer.refresh(m, ['7', '7'], undefined, true);
  assert.deepEqual(f.calls, ['7']);
  await f.observer.refresh(m, ['7'], undefined, true);
  assert.deepEqual(f.calls, ['7']);
  f.observer.ingest('1', raw(), m);
  await f.observer.refresh(m, ['1'], undefined, true);
  assert.deepEqual(f.calls, ['7']);
});

test('non-dirty fresh TTL is fifteen seconds, then counts become stale and refreshable', async (t) => {
  clock(t);
  const f = fixture(),
    m = memory();
  await f.observer.refresh(m, ['1']);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(14_999);
  await f.observer.refresh(m, ['1']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.observer.get('1')!.status, 'observed');
  t.mock.timers.tick(1);
  assert.equal(f.observer.get('1')!.status, 'stale');
  await f.observer.refresh(m, ['1']);
  assert.equal(f.calls.length, 2);
  assert.equal(f.observer.get('1')!.status, 'observed');
});

test('failed reads have a short cooldown which notice spam cannot reset', async (t) => {
  clock(t);
  const f = fixture(async () => {
      throw new Error('SECRET private upstream error');
    }),
    m = memory();
  await f.observer.refresh(m, ['1']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.observer.get('1'), undefined);
  for (let i = 0; i < 20; i++) {
    f.observer.notice(notice(), m);
  }
  await f.observer.refresh(m, ['1']);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(5_000);
  await f.observer.refresh(m, ['1']);
  assert.equal(f.calls.length, 2);
});

test('no more than two physical RPCs are concurrent and concurrent refreshes share work', async () => {
  const responses = Array.from({ length: 4 }, () => gate());
  let live = 0,
    peak = 0;
  const f = fixture(async (id) => {
    live++;
    peak = Math.max(peak, live);
    try {
      return await responses[Number(id) - 1]!.promise;
    } finally {
      live--;
    }
  });
  const m = memory(['1', '2', '3', '4']);
  const a = f.observer.refresh(m, ['1', '2', '3', '4']),
    b = f.observer.refresh(m, ['1', '2', '3', '4']);
  await tick();
  assert.deepEqual(f.calls, ['1', '2']);
  responses[0]!.resolve(raw('1'));
  await tick();
  assert.deepEqual(f.calls, ['1', '2', '3']);
  responses[1]!.resolve(raw('2'));
  await tick();
  assert.deepEqual(f.calls, ['1', '2', '3', '4']);
  responses[2]!.resolve(raw('3'));
  responses[3]!.resolve(raw('4'));
  await Promise.all([a, b]);
  assert.equal(peak, 2);
  assert.equal(live, 0);
});

test('abort before/during refresh stops waiting and suppresses late observations', async () => {
  const response = gate(),
    f = fixture(() => response.promise),
    m = memory(['1', '2', '3']);
  const cancelled = new AbortController();
  cancelled.abort();
  await f.observer.refresh(m, ['1'], cancelled.signal);
  assert.equal(f.calls.length, 0);
  const controller = new AbortController(),
    pending = f.observer.refresh(m, ['1', '2', '3'], controller.signal);
  await tick();
  assert.equal(f.calls.length, 2);
  controller.abort();
  await pending;
  response.resolve(raw());
  await tick();
  assert.equal(f.observer.get('1'), undefined);
  assert.equal(f.calls.length, 2);
});

test('deadline returns after 1.5 seconds without freeing physical RPC slots or accepting late data', async (t) => {
  clock(t);
  const responses = [gate(), gate()];
  const f = fixture((id) => responses[Number(id) - 1]!.promise),
    m = memory(['1', '2', '3']);
  const pending = f.observer.refresh(m, ['1', '2', '3']);
  await tick();
  assert.equal(f.calls.length, 2);
  t.mock.timers.tick(1_500);
  await pending;
  await f.observer.refresh(m, ['1', '2', '3']);
  assert.equal(f.calls.length, 2);
  responses[0]!.resolve(raw('1'));
  responses[1]!.reject(Error('SECRET late failure'));
  await tick();
  assert.equal(f.observer.get('1'), undefined);
  assert.equal(f.observer.get('2'), undefined);
  assert.equal(f.calls.length, 2);
});

test('clear invalidates old work but preserves outstanding physical concurrency leases', async () => {
  const responses = [gate(), gate()],
    f = fixture((id) => responses[Number(id) - 1]!.promise),
    m = memory(['1', '2', '3']);
  const pending = f.observer.refresh(m, ['1', '2', '3']);
  await tick();
  assert.equal(f.calls.length, 2);
  f.observer.clear();
  await pending;
  await f.observer.refresh(m, ['3']);
  assert.equal(f.calls.length, 2);
  responses[0]!.resolve(raw('1'));
  responses[1]!.resolve(raw('2'));
  await tick();
  assert.equal(f.observer.get('1'), undefined);
  assert.equal(f.observer.get('2'), undefined);
});

test('a remaining old RPC consumes one slot, and its late response cannot overwrite a later refresh', async (t) => {
  clock(t);
  const slow = gate();
  let index = 0,
    live = 0,
    peak = 0;
  const f = fixture(async (id) => {
    live++;
    peak = Math.max(peak, live);
    try {
      if (index++ === 0) {
        return await slow.promise;
      }
      return raw(id);
    } finally {
      live--;
    }
  });
  const m = memory(['1', '2', '3']);
  const pending = f.observer.refresh(m, ['1'], undefined, true);
  await tick();
  t.mock.timers.tick(1_500);
  await pending;
  await f.observer.refresh(m, ['2', '3'], undefined, true);
  assert.deepEqual(f.calls, ['1', '2', '3']);
  assert.equal(peak, 2);
  slow.resolve(raw());
  await tick();
  assert.equal(f.observer.get('1'), undefined);
  assert.equal(f.observer.get('2')!.status, 'observed');
});

test('cache and dirty/revision entries are capped at 512 and retention removes old counters', (t) => {
  clock(t);
  const f = fixture(),
    ids = Array.from({ length: 514 }, (_, i) => String(i + 1)),
    m = memory(ids);
  for (const id of ids) {
    f.observer.ingest(id, raw(id), m);
  }
  assert.equal(ids.filter((id) => f.observer.get(id)).length, 512);
  assert.equal(f.observer.get('1'), undefined);
  f.observer.clear();
  f.observer.ingest('1', raw(), m);
  t.mock.timers.tick(7 * 86_400_000 - 1);
  f.observer.markDirty('1');
  t.mock.timers.tick(2);
  assert.equal(f.observer.get('1'), undefined);
  for (const id of ids) {
    f.observer.markDirty(id);
  }
  for (const id of ids) {
    f.observer.revision(id);
  }
  assert.equal(f.calls.length, 0);
});

test('collectors are independent per group and invalid construction fails', () => {
  const a = fixture(),
    b = fixture(undefined, '33'),
    m = memory();
  a.observer.ingest('1', raw(), m);
  b.observer.ingest('1', raw(), m);
  assert.equal(a.observer.get('1')!.status, 'observed');
  assert.equal(b.observer.get('1'), undefined);
  b.observer.ingest('1', { ...raw(), group_id: '33' }, m);
  b.observer.clear();
  assert.equal(a.observer.get('1')!.status, 'observed');
  assert.throws(() => new ReactionObservations(a.api, '022', 7));
  for (const days of [0, -1, NaN, Infinity, 31]) {
    assert.throws(() => new ReactionObservations(a.api, group, days));
  }
});
