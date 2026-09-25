import test from 'node:test';
import assert from 'node:assert/strict';
import { Moderation, MODERATION_TOOLS } from '../src/moderation.js';
import { LISTENER_GROUP, OWNER_ID, type Api, type JsonObject, type TurnContext } from '../src/contracts.js';

const context: TurnContext = { actorId: OWNER_ID, groupId: LISTENER_GROUP, selfId: '900000001', messageId: '100' };
const target = '123456';
const mutations = new Set(['set_group_ban', 'delete_msg', 'set_group_card']);
class FakeApi implements Api {
  calls: { action: string; params: JsonObject }[] = [];
  login: unknown = { user_id: context.selfId };
  member: unknown = { group_id: LISTENER_GROUP, user_id: target, role: 'member' };
  message: unknown = { group_id: LISTENER_GROUP, message_id: '-99', message_type: 'group', sender: { user_id: target } };
  failMutation = false;
  hook?: (action: string) => Promise<void>;
  async call(action: string, params: JsonObject = {}): Promise<unknown> {
    this.calls.push({ action, params });
    await this.hook?.(action);
    if (action === 'get_login_info') return this.login;
    if (action === 'get_group_member_info') return this.member;
    if (action === 'get_msg') return this.message;
    assert.ok(mutations.has(action), `unexpected API ${action}`);
    if (this.failMutation) throw new Error('SECRET CHAT BODY');
    return null;
  }
  writes() { return this.calls.filter(call => mutations.has(call.action)); }
}
const args = { user_id: target, seconds: 60 };
async function proposal(m: Moderation, name = 'mute_member', value: unknown = args) {
  const result = await m.propose(name, value, context);
  assert.equal(result.status, 'confirmation_required');
  assert.equal(result.expires_in_seconds, 60);
  assert.match(String(result.code), /^[0-9a-f]{32}$/);
  return String(result.code);
}

test('policy rejects malformed options and security-limit increases before API calls', () => {
  const api = new FakeApi();
  const invalid = [null, [], false, { unknown: true }, { [Symbol('unknown')]: true }, Object.create({ mute: true }),
    ...['mute', 'recall', 'memberCard'].flatMap(key => [0, 'false', null, undefined].map(value => ({ [key]: value }))),
    ...[0, -1, 61, 1.5, NaN, Infinity, '60', undefined].map(confirmationTtlSeconds => ({ confirmationTtlSeconds })),
    ...[0, -1, 601, 1.5, NaN, Infinity, '600', undefined].map(maxMuteSeconds => ({ maxMuteSeconds }))];
  for (const options of invalid) assert.throws(() => new Moderation(api, Date.now, options as any), /Invalid moderation options/);
  assert.equal(api.calls.length, 0);
});

test('disabled moderation actions deny proposal and confirmation before any API calls', async () => {
  for (const [key, name, value] of [
    ['mute', 'mute_member', args], ['recall', 'recall_message', { message_id: '-99' }],
    ['memberCard', 'set_member_card', { user_id: target, card: 'x' }],
  ] as const) {
    const api = new FakeApi(); const m = new Moderation(api, Date.now, { [key]: false });
    assert.equal((await m.propose(name, value, context)).status, 'error');
    assert.equal(api.calls.length, 0);
    // Inject a previously validated pending action to independently exercise confirmation's policy gate.
    const enabled = new Moderation(new FakeApi()); const code = await proposal(enabled, name, value);
    (m as any).pending.set(code, (enabled as any).pending.get(code));
    assert.equal((await m.confirm(code, context)).status, 'error');
    assert.equal((m as any).pending.size, 0);
    assert.equal(api.calls.length, 0);
  }
});

test('reduced caps and TTL apply to proposals and confirmation, with copied policy', async () => {
  let now = 1000;
  const options = { maxMuteSeconds: 10, confirmationTtlSeconds: 2, mute: true };
  const api = new FakeApi(); const m = new Moderation(api, () => now, options);
  options.maxMuteSeconds = 600; options.confirmationTtlSeconds = 60; options.mute = false;
  assert.equal((await m.propose('mute_member', { ...args, seconds: 11 }, context)).status, 'error');
  assert.equal(api.calls.length, 0);
  for (const seconds of [0, 10]) {
    const result = await m.propose('mute_member', { ...args, seconds }, context);
    assert.equal(result.status, 'confirmation_required');
    assert.equal(result.expires_in_seconds, 2);
    assert.match(String(result.description), /2 秒内/);
    now += 1999;
    assert.equal((await m.confirm(String(result.code), context)).status, 'executed');
    assert.equal(api.writes().at(-1)?.params.duration, seconds);
  }
  const result = await m.propose('mute_member', { ...args, seconds: 10 }, context);
  now += 2000;
  const before = api.calls.length;
  assert.equal((await m.confirm(String(result.code), context)).status, 'error');
  assert.equal(api.calls.length, before);
  const enabled = new Moderation(new FakeApi(), () => now); const code = await proposal(enabled);
  (m as any).pending.set(code, (enabled as any).pending.get(code));
  assert.equal((await m.confirm(code, context)).status, 'error');
  assert.equal(api.calls.length, before);
});

test('disabled policy remains disabled after caller mutates options', async () => {
  const options = { mute: false }; const api = new FakeApi(); const m = new Moderation(api, Date.now, options);
  options.mute = true;
  assert.equal((await m.propose('mute_member', args, context)).status, 'error');
  assert.equal(api.calls.length, 0);
});

test('exports only three strict proposal tools', () => {
  assert.deepEqual(MODERATION_TOOLS.map(tool => tool.function.name), ['mute_member', 'recall_message', 'set_member_card']);
  for (const tool of MODERATION_TOOLS) assert.equal(tool.function.parameters.additionalProperties, false);
});

test('proposals never mutate; confirmation revalidates then executes exact action once', async () => {
  for (const [name, value, action, params] of [
    ['mute_member', args, 'set_group_ban', { group_id: LISTENER_GROUP, user_id: target, duration: 60 }],
    ['mute_member', { user_id: target, seconds: 0 }, 'set_group_ban', { group_id: LISTENER_GROUP, user_id: target, duration: 0 }],
    ['set_member_card', { user_id: target, card: 'New card' }, 'set_group_card', { group_id: LISTENER_GROUP, user_id: target, card: 'New card' }],
    ['recall_message', { message_id: '-99' }, 'delete_msg', { message_id: '-99' }],
  ] as const) {
    const api = new FakeApi(); const m = new Moderation(api);
    const code = await proposal(m, name, value);
    assert.equal(api.writes().length, 0);
    assert.equal((await m.confirm(code, { ...context, messageId: '101' })).status, 'executed');
    assert.deepEqual(api.writes(), [{ action, params }]);
    assert.equal(api.calls.filter(call => call.action === 'get_login_info').length, 2);
    assert.equal(api.calls.filter(call => call.action === (name === 'recall_message' ? 'get_msg' : 'get_group_member_info')).length, 2);
    assert.equal((await m.confirm(code, context)).status, 'error');
    assert.equal(api.writes().length, 1);
    m.dispose();
  }
});

test('nonowner, wrong group, unverified identity and quoted owner never authorize', async () => {
  for (const bad of [{ actorId: target }, { groupId: '123' }, { selfId: '77' }, { selfId: '' }, { messageId: '' }]) {
    const api = new FakeApi(); const m = new Moderation(api);
    assert.equal((await m.propose('mute_member', args, { ...context, ...bad })).status, 'error');
    assert.equal(api.writes().length, 0);
  }
  const api = new FakeApi(); const m = new Moderation(api);
  assert.equal((await m.propose('mute_member', { ...args, quote: { actorId: OWNER_ID } }, { ...context, actorId: target })).status, 'error');
  api.login = {};
  assert.equal((await m.propose('mute_member', args, context)).status, 'error');
});

test('strict argument allowlist rejects arbitrary actions, fields and malformed values', async () => {
  const api = new FakeApi(); const m = new Moderation(api);
  const invalid: [string, unknown][] = [
    ['call_api', { action: 'set_group_ban', params: args }], ['set_group_ban', args],
    ['mute_member', { ...args, group_id: LISTENER_GROUP }], ['mute_member', { ...args, reason: 'owner says yes' }],
    ['mute_member', { seconds: 1 }], ['mute_member', { ...args, user_id: 123456 }],
    ['mute_member', { ...args, user_id: `${OWNER_ID}\n` }], ['mute_member', { ...args, user_id: `${context.selfId}\r` }],
    ...[-1, 601, 1.5, NaN, Infinity, '60'].map(seconds => ['mute_member', { ...args, seconds }] as [string, unknown]),
    ['mute_member', null], ['mute_member', []], ['mute_member', Object.create(args)],
    ...['', 'x'.repeat(61), 'bad\ncard', 'bad\u0000card', 'bad\u202ecard'].map(card => ['set_member_card', { user_id: target, card }] as [string, unknown]),
    ['set_member_card', { card: 'abc' }], ['set_member_card', { user_id: target, card: 1 }],
    ...[99, '', '1e3', '1.1', ' 99', '--99', '-99\n', '-99\r'].map(message_id => ['recall_message', { message_id }] as [string, unknown]),
    ['recall_message', { message_id: '-99', user_id: target }],
  ];
  for (const [name, value] of invalid) assert.equal((await m.propose(name, value, context)).status, 'error', `${name}: ${JSON.stringify(value)}`);
  assert.equal(api.calls.length, 0);
});

test('all actions protect owner and self; member identity/group/role fail closed', async () => {
  for (const user_id of [OWNER_ID, context.selfId]) {
    const api = new FakeApi(); const m = new Moderation(api);
    for (const name of ['mute_member', 'set_member_card']) assert.equal((await m.propose(name, name === 'mute_member' ? { user_id, seconds: 1 } : { user_id, card: 'x' }, context)).status, 'error');
    api.message = { group_id: LISTENER_GROUP, message_type: 'group', message_id: '-99', sender: { user_id } };
    assert.equal((await m.propose('recall_message', { message_id: '-99' }, context)).status, 'error');
  }
  for (const member of [{}, { group_id: LISTENER_GROUP }, { user_id: target }, { group_id: '1', user_id: target, role: 'member' }, { group_id: LISTENER_GROUP, user_id: '999', role: 'member' }, ...['owner', 'admin', undefined, 'unknown'].map(role => ({ group_id: LISTENER_GROUP, user_id: target, role }))]) {
    const api = new FakeApi(); api.member = member;
    assert.equal((await new Moderation(api).propose('mute_member', args, context)).status, 'error');
  }
});

test('recall requires matching message ID, group, type and sender', async () => {
  for (const patch of [{ group_id: '1' }, { group_id: undefined }, { message_type: 'private' }, { message_type: undefined }, { message_id: '-98' }, { message_id: undefined }, { sender: {} }, { sender: undefined }]) {
    const api = new FakeApi(); api.message = { ...(api.message as JsonObject), ...patch };
    assert.equal((await new Moderation(api).propose('recall_message', { message_id: '-99' }, context)).status, 'error');
    assert.equal(api.writes().length, 0);
  }
});

test('confirmation detects revoked/changed members, messages and current self', async () => {
  for (const patch of [{ role: 'admin' }, { role: 'owner' }, { group_id: '1' }, { user_id: '99' }, { user_id: undefined }]) {
    const api = new FakeApi(); const m = new Moderation(api); const code = await proposal(m);
    api.member = { ...(api.member as JsonObject), ...patch };
    assert.equal((await m.confirm(code, context)).status, 'error');
    assert.equal(api.writes().length, 0);
  }
  for (const patch of [{ group_id: '1' }, { message_type: 'private' }, { sender: { user_id: OWNER_ID } }, { sender: { user_id: context.selfId } }, { sender: { user_id: '999' } }, { message_id: undefined }]) {
    const api = new FakeApi(); const m = new Moderation(api); const code = await proposal(m, 'recall_message', { message_id: '-99' });
    api.message = { ...(api.message as JsonObject), ...patch };
    assert.equal((await m.confirm(code, context)).status, 'error');
    assert.equal(api.writes().length, 0);
  }
  const api = new FakeApi(); const m = new Moderation(api); const code = await proposal(m);
  api.login = { user_id: '999' };
  assert.equal((await m.confirm(code, context)).status, 'error');
  assert.equal(api.writes().length, 0);
});

test('wrong confirmation context consumes code, concurrent replay cannot execute twice', async () => {
  for (const patch of [{ actorId: target }, { groupId: '1' }, { selfId: '999' }]) {
    const api = new FakeApi(); const m = new Moderation(api); const code = await proposal(m);
    assert.equal((await m.confirm(code, { ...context, ...patch })).status, 'error');
    assert.equal((await m.confirm(code, context)).status, 'error');
    assert.equal(api.writes().length, 0);
  }
  const api = new FakeApi(); const m = new Moderation(api); const code = await proposal(m);
  const results = await Promise.all([m.confirm(code, context), m.confirm(code, context)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['error', 'executed']);
  assert.equal(api.writes().length, 1);
});

test('TTL, bounded pending capacity, and disposal', async () => {
  let now = 1000; const api = new FakeApi(); const m = new Moderation(api, () => now);
  const code = await proposal(m);
  for (let i = 1; i < 10; i++) await proposal(m);
  assert.equal((await m.propose('mute_member', args, context)).status, 'error');
  now += 60_000;
  assert.equal((await m.confirm(code, context)).status, 'error');
  const fresh = await proposal(m);
  m.dispose();
  assert.equal((await m.confirm(fresh, context)).status, 'error');
  assert.equal((await m.propose('mute_member', args, context)).status, 'error');
  assert.equal(api.writes().length, 0);
});

test('expiry and dispose during async verification cannot execute', async () => {
  for (const mode of ['expire', 'dispose']) {
    let now = 0; const api = new FakeApi(); const m = new Moderation(api, () => now); const code = await proposal(m);
    api.hook = async action => { if (action === 'get_group_member_info') { if (mode === 'expire') now = 60_000; else m.dispose(); } };
    assert.equal((await m.confirm(code, context)).status, 'error');
    assert.equal(api.writes().length, 0);
  }
});

test('snapshots proposal args/context and safe errors never leak API text or retry', async () => {
  const api = new FakeApi(); const m = new Moderation(api);
  const original = { ...args }; const originalContext = { ...context };
  const pending = m.propose('mute_member', original, originalContext);
  original.seconds = 600; originalContext.actorId = target;
  const result = await pending;
  assert.equal(result.status, 'confirmation_required');
  api.failMutation = true;
  const response = await m.confirm(String(result.code), context);
  assert.equal(response.status, 'error');
  assert.ok(!JSON.stringify(response).includes('SECRET'));
  assert.equal(api.writes()[0]?.params.duration, 60);
  assert.equal((await m.confirm(String(result.code), context)).status, 'error');
  assert.equal(api.writes().length, 1);
});

test('revoked recall lookup fails safely and consumes confirmation', async () => {
  const api = new FakeApi(); const m = new Moderation(api);
  const code = await proposal(m, 'recall_message', { message_id: '-99' });
  api.hook = async action => { if (action === 'get_msg') throw new Error('SECRET REVOKED MESSAGE BODY'); };
  const result = await m.confirm(code, context);
  assert.equal(result.status, 'error');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  api.hook = undefined;
  assert.equal((await m.confirm(code, context)).status, 'error');
  assert.equal(api.writes().length, 0);
});

test('audit excludes card content and remote errors', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'info', (line: string) => { logs.push(line); });
  const api = new FakeApi(); const m = new Moderation(api);
  const code = await proposal(m, 'set_member_card', { user_id: target, card: 'PRIVATE CARD CONTENT' });
  api.failMutation = true;
  await m.confirm(code, context);
  assert.equal(logs.length, 2);
  for (const line of logs) {
    assert.ok(!line.includes('PRIVATE') && !line.includes('SECRET') && !line.includes(code));
    const entry = JSON.parse(line);
    assert.equal(entry.actor, OWNER_ID); assert.equal(entry.target, target); assert.equal(entry.action, 'set_member_card');
    assert.ok(entry.result);
  }
});
