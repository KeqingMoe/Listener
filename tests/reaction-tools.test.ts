import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { ReactionTools, createReactionTool, type ReactionTurn } from '../src/reaction-tools.js';
import { LISTENER_GROUP, type Api, type Memory, type TimelineEntry, type TurnContext, type JsonObject } from '../src/contracts.js';

const group = '22';
const context: TurnContext = { groupId: group, actorId: '123', selfId: '456', messageId: '1' };
const entry = (id = '1', user = '123'): TimelineEntry => ({ messageId: id, userId: user, nickname: 'member', text: 'hello', time: 1 });
function frozenMemory(source: TimelineEntry[]): Memory {
  const data = structuredClone(source);
  return { append() { throw Error('read only'); }, recent() { return structuredClone(data); }, find(id) { return structuredClone(data.find(e => e.messageId === id)); },
    context() { return JSON.stringify(data); }, async compact() {}, clear() { throw Error('read only'); }, close() {} };
}
const args = (id = '1', action: 'add'|'remove' = 'add', emoji = '76') => ({ message_id: id, emoji_id: emoji, action });
const verified = (id = '1', user: string|number = '123', gid: string|number = group): JsonObject => ({ message_id: id, message_type: 'group', group_id: gid, sender: { user_id: user }, message: [] });
function fixture(options: { entries?: TimelineEntry[]; remote?: unknown; native?: unknown; groupId?: string; handler?: (action: string, params: JsonObject) => Promise<unknown> } = {}) {
  const calls: Array<{ action: string; params: JsonObject }> = [];
  const memory = frozenMemory(options.entries ?? [entry()]);
  const api: Api = { async call(action, params = {}) {
    calls.push({ action, params: structuredClone(params) });
    if (options.handler) return options.handler(action, params);
    if (action === 'get_msg') return Object.hasOwn(options, 'remote') ? options.remote : verified(String(params.message_id));
    assert.equal(action, 'set_msg_emoji_like'); return Object.hasOwn(options, 'native') ? options.native : { result: 0 };
  } };
  const tools = new ReactionTools(api, memory, options.groupId ?? group);
  return { tools, state: tools.createTurn(), calls, api, memory };
}
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('verifies even local messages before a native own-account reaction', async () => {
  const f = fixture();
  assert.deepEqual(await f.tools.react(args(), context, f.state), { status: 'ok', message_id: '1', emoji_id: '76', action: 'add' });
  assert.deepEqual(f.calls, [{ action: 'get_msg', params: { message_id: '1' } }, { action: 'set_msg_emoji_like', params: { message_id: '1', emoji_id: '76', set: true } }]);
  assert.equal(createReactionTool().function.name, 'react_message');
});

test('native string zero face ID and signed safe short IDs are preserved exactly', async () => {
  for (const id of ['0', '-1', '9007199254740991', '-9007199254740991']) {
    const f = fixture({ entries: [entry(id)], remote: { ...verified(id), message_id: Number(id) } });
    const result = await f.tools.react(args(id, 'add', '0'), context, f.state);
    assert.equal(result.status, 'ok'); assert.equal(f.calls[1]!.params.message_id, id); assert.equal(f.calls[1]!.params.emoji_id, '0');
  }
});

test('scope and turn ownership checks happen before every API/cache access', async () => {
  const f = fixture(), other = fixture();
  assert.equal((await f.tools.react(args(), { ...context, groupId: '33' }, f.state)).error, 'forbidden_group');
  for (const state of [other.state, { reaction_turn: true }, null, 'invalid']) {
    assert.equal((await f.tools.react(args(), context, state as ReactionTurn)).error, 'invalid_turn');
  }
  assert.equal(f.calls.length, 0); assert.equal(other.calls.length, 0);
  await f.tools.react(args(), context, f.state);
  assert.equal((await other.tools.react(args(), context, f.state)).error, 'invalid_turn');
  assert.equal(other.calls.length, 0);
  assert.throws(() => new ReactionTools(f.api, f.memory, '022'));
});

test('legacy constructor default remains bound to the original installation group', async () => {
  const f = fixture({ remote: verified('1', '123', LISTENER_GROUP) });
  const tools = new ReactionTools(f.api, f.memory), state = tools.createTurn();
  assert.equal((await tools.react(args(), { ...context, groupId: LISTENER_GROUP }, state)).status, 'ok');
  assert.equal((await tools.react(args(), context, state)).error, 'forbidden_group');
});

test('strict schema rejects malformed IDs/actions/extra keys without using the operation budget', async () => {
  const f = fixture();
  const invalid: unknown[] = [null, [], {}, { ...args(), group_id: '33' }, { ...args(), action: 'set' }, { ...args(), set: true }, { message_id: '1', emoji_id: '76' }];
  for (const id of ['01', '-0', '+1', '1e0', '1.0', ' 1', '1\n', '9007199254740992', '-9007199254740992', 1, null, '']) invalid.push({ ...args(), message_id: id });
  for (const emoji of ['076', '76\n', '9999999', '👍', 76, null]) invalid.push({ ...args(), emoji_id: emoji });
  for (let i = 0; i < 3; i++) for (const value of invalid) assert.equal((await f.tools.react(value, context, f.state)).error, 'invalid_arguments');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.tools.react(args(), context, f.state)).status, 'ok');
});

test('argument accessors and prototype tricks do not run or bypass validation', async () => {
  const f = fixture(); let reads = 0;
  const bad = { ...args(), get hidden() { reads++; return 'private'; } };
  assert.equal((await f.tools.react(bad, context, f.state)).error, 'invalid_arguments');
  assert.equal((await f.tools.react(Object.create(args()), context, f.state)).error, 'invalid_arguments');
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});

test('only frozen local IDs or structural reply provenance can reach lookup', async () => {
  const entries = [entry(), { ...entry('2'), text: 'forward claimed message_id=999; arbitrary ID 888' }];
  const f = fixture({ entries });
  entries.push(entry('999')); // Caller changes do not extend the frozen view.
  for (const id of ['999', '888', '3']) assert.equal((await f.tools.react(args(id), context, f.state)).error, 'message_not_in_context');
  assert.equal(f.calls.length, 0);
  const reply = fixture({ entries: [{ ...entry(), replyTo: '7' }], remote: verified('7', '987') });
  assert.equal((await reply.tools.react(args('7'), context, reply.state)).status, 'ok');
  assert.equal(reply.calls.length, 2);
});

test('rejects foreign/private/remapped messages and wrong local senders without a write', async () => {
  const remoteCases = [null, {}, { ...verified(), message_type: 'private' }, verified('1', '123', '33'), verified('1', '123', '022'), verified('1', '123', '22\n'),
    verified('2'), { ...verified(), message_id: '01' }, { ...verified(), message_id: '9007199254740992' },
    { ...verified(), sender: {} }, verified('1', '0'), verified('1', '123\n'), verified('1', '999')];
  for (const remote of remoteCases) {
    const f = fixture({ remote });
    const result = await f.tools.react(args(), context, f.state);
    assert.equal(result.error, 'verification_failed'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.action, 'get_msg');
  }
  const f = fixture({ remote: verified('1', 123, 22) });
  assert.equal((await f.tools.react(args(), context, f.state)).status, 'ok');
});

test('optional top-level sender identity must agree with sender metadata', async () => {
  for (const user_id of ['999', '0', '123\n', '0123', null, undefined]) {
    const f = fixture({ remote: { ...verified(), user_id } });
    assert.equal((await f.tools.react(args(), context, f.state)).error, 'verification_failed');
    assert.equal(f.calls.length, 1);
  }
  for (const user_id of ['123', 123]) {
    const f = fixture({ remote: { ...verified(), user_id } });
    assert.equal((await f.tools.react(args(), context, f.state)).status, 'ok');
  }
});

test('referenced targets still require same-group identity verification', async () => {
  const f = fixture({ entries: [{ ...entry(), replyTo: '7' }], remote: verified('7', '987', '33') });
  assert.equal((await f.tools.react(args('7'), context, f.state)).error, 'verification_failed');
  assert.equal(f.calls.length, 1);
});

test('lookup failure is non-mutating and raw private API errors never leak', async () => {
  const f = fixture({ handler: async () => { throw Error('SECRET_TOKEN private-chat-body'); } });
  const result = await f.tools.react(args(), context, f.state);
  assert.deepEqual(result, { status: 'error', error: 'api_unavailable' }); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private-chat/);
  assert.equal((await f.tools.react(args(), context, f.state)).duplicate, true); assert.equal(f.calls.length, 1);
});

test('accepts only explicit native numeric zero or boolean true success', async () => {
  for (const result of [0, true]) {
    const f = fixture({ native: { result, errMsg: 'PRIVATE_NATIVE_TEXT', hidden: { body: 'SECRET' } } });
    const response = await f.tools.react(args(), context, f.state);
    assert.deepEqual(response, { status: 'ok', message_id: '1', emoji_id: '76', action: 'add' });
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE|SECRET/);
  }
});

test('known native rejection exposes only sanitized tuple and permits an opposite action', async () => {
  for (const result of [1, -1, 120, false]) {
    const f = fixture({ native: { result, errMsg: 'PRIVATE' } });
    assert.deepEqual(await f.tools.react(args(), context, f.state), { status: 'error', error: 'reaction_rejected', message_id: '1', emoji_id: '76', action: 'add' });
    assert.equal((await f.tools.react(args('1', 'remove'), context, f.state)).error, 'reaction_rejected');
    assert.equal(f.calls.length, 4);
  }
});

test('unknown/malformed native responses block same and opposite retries', async () => {
  for (const native of [undefined, null, {}, [], true, false, 0, { result: '0' }, { result: 'true' }, { result: null }, { result: NaN }, { result: Infinity }, { status: 'ok', data: { result: 0 } }]) {
    const f = fixture({ native });
    const first = await f.tools.react(args(), context, f.state);
    assert.deepEqual(first, { status: 'unknown', error: 'reaction_result_unknown', message_id: '1', emoji_id: '76', action: 'add' });
    const duplicate = await f.tools.react(args(), context, f.state);
    assert.equal(duplicate.status, 'unknown'); assert.equal(duplicate.duplicate, true);
    const opposite = await f.tools.react(args('1', 'remove'), context, f.state);
    assert.equal(opposite.status, 'unknown'); assert.equal(opposite.duplicate, true);
    assert.equal(opposite.action, 'add'); assert.equal(opposite.requested_action, 'remove');
    assert.equal(f.calls.length, 2);
  }
});

test('a thrown dispatched write is unknown and never blindly retried', async () => {
  const f = fixture({ handler: async action => { if (action === 'get_msg') return verified(); throw Error('SECRET unknown delivery details'); } });
  const result = await f.tools.react(args(), context, f.state);
  assert.equal(result.status, 'unknown'); assert.doesNotMatch(JSON.stringify(result), /SECRET|delivery details/);
  await f.tools.react(args('1', 'remove'), context, f.state); assert.equal(f.calls.length, 2);
});

test('duplicate desired states are cached but add/remove/add is a real sequence', async () => {
  const f = fixture();
  const first = await f.tools.react(args(), context, f.state);
  first.action = 'remove'; // External mutation cannot poison the cached result.
  const second = await f.tools.react(args(), context, f.state);
  assert.equal(second.action, 'add'); assert.equal(second.duplicate, true); assert.equal(f.calls.length, 2);
  assert.equal((await f.tools.react(args('1', 'remove'), context, f.state)).status, 'ok');
  assert.equal((await f.tools.react(args(), context, f.state)).status, 'ok');
  assert.deepEqual(f.calls.filter(c => c.action === 'set_msg_emoji_like').map(c => c.params.set), [true, false, true]);
});

test('concurrent identical same-pair operations serialize and issue only one write', async () => {
  const lookup = gate<unknown>();
  const f = fixture({ handler: async action => action === 'get_msg' ? lookup.promise : { result: 0 } });
  const a = f.tools.react(args(), context, f.state), b = f.tools.react(args(), context, f.state);
  await tick(); assert.equal(f.calls.length, 1);
  lookup.resolve(verified());
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.status, 'ok'); assert.equal(second.duplicate, true); assert.equal(f.calls.length, 2);
});

test('queued opposite actions cannot overtake a native write or retry its unknown outcome', async () => {
  const write = gate<unknown>();
  const f = fixture({ handler: async action => action === 'get_msg' ? verified() : write.promise });
  const a = f.tools.react(args(), context, f.state), b = f.tools.react(args('1', 'remove'), context, f.state);
  await tick(); assert.equal(f.calls.length, 2);
  write.reject(Error('private timeout'));
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.status, 'unknown'); assert.equal(second.status, 'unknown'); assert.equal(second.duplicate, true);
  assert.equal(f.calls.length, 2);
});

test('different pairs and different owned turns do not share dedup outcomes', async () => {
  const f = fixture({ entries: [entry(), entry('2')] });
  const results = await Promise.all([f.tools.react(args(), context, f.state), f.tools.react(args('2'), context, f.state), f.tools.react(args('1', 'add', '128077'), context, f.state)]);
  assert.ok(results.every(r => r.status === 'ok')); assert.equal(f.calls.length, 6);
  await f.tools.react(args(), context, f.tools.createTurn()); assert.equal(f.calls.length, 8);
});

test('abort before lookup or while it is pending prevents mutation', async () => {
  const f = fixture(), cancelled = new AbortController(); cancelled.abort();
  assert.equal((await f.tools.react(args(), context, f.state, cancelled.signal)).error, 'cancelled'); assert.equal(f.calls.length, 0);
  const lookup = gate<unknown>(), controller = new AbortController();
  const waiting = fixture({ handler: async () => lookup.promise });
  const result = waiting.tools.react(args(), context, waiting.state, controller.signal);
  await tick(); controller.abort(); lookup.resolve(verified());
  assert.equal((await result).error, 'cancelled'); assert.equal(waiting.calls.length, 1);
});

test('already dispatched writes report success or unknown despite subsequent cancellation', async () => {
  for (const succeeds of [true, false]) {
    const write = gate<unknown>(), controller = new AbortController();
    const f = fixture({ handler: async action => action === 'get_msg' ? verified() : write.promise });
    const pending = f.tools.react(args(), context, f.state, controller.signal);
    await tick(); assert.equal(f.calls.length, 2); controller.abort();
    if (succeeds) write.resolve({ result: 0 }); else write.reject(Error('SECRET'));
    const result = await pending; assert.equal(result.status, succeeds ? 'ok' : 'unknown');
    assert.equal(result.message_id, '1'); assert.equal(result.action, 'add'); assert.notEqual(result.error, 'cancelled');
  }
});

test('32-operation budget is shared across pairs, bounds the map, and invalid input costs nothing', async () => {
  const f = fixture({ entries: Array.from({ length: 33 }, (_, i) => entry(String(i + 1))) });
  for (let i = 0; i < 100; i++) await f.tools.react({ ...args(), action: 'invalid' }, context, f.state);
  const results = await Promise.all(Array.from({ length: 33 }, (_, i) => f.tools.react(args(String(i + 1)), context, f.state)));
  assert.equal(results.filter(r => r.status === 'ok').length, 32); assert.equal(results[32]!.error, 'call_limit');
  assert.equal(f.calls.filter(c => c.action === 'get_msg').length, 32);
  assert.equal(f.calls.filter(c => c.action === 'set_msg_emoji_like').length, 32);
  assert.equal((await f.tools.react(args(), context, f.state)).duplicate, true);
});

test('alternating one pair cannot bypass budget, duplicates still return cached results at the limit', async () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) assert.equal((await f.tools.react(args('1', i % 2 ? 'remove' : 'add'), context, f.state)).status, 'ok');
  assert.equal(f.calls.length, 64);
  assert.equal((await f.tools.react(args(), context, f.state)).error, 'call_limit');
  assert.equal((await f.tools.react(args('1', 'remove'), context, f.state)).duplicate, true);
  assert.equal(f.calls.length, 64);
});
