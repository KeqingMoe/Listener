import test from 'node:test';
import assert from 'node:assert/strict';
import { Moderation, MODERATION_TOOLS, buildModerationTools } from '../src/tools/management/moderation.js';
import type { ModerationPolicy } from '../src/config/listener.js';
import { configureLogging } from '../src/observability/logger.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LISTENER_GROUP, OWNER_ID } from '../src/contracts/identity.js';
import { type Api } from '../src/contracts/onebot.js';
import { type JsonObject } from '../src/contracts/json.js';
import { type TurnContext } from '../src/contracts/tools.js';

const context: TurnContext = { actorId: OWNER_ID, groupId: LISTENER_GROUP, selfId: '900000001', messageId: '100' };
const target = '123456';
const CONFIRM = { mute: 'confirm', unmute: 'confirm', recall: 'confirm', memberCard: 'confirm' } as const;
const mutations = new Set(['set_group_ban', 'delete_msg', 'set_group_card']);
class FakeApi implements Api {
  calls: { action: string; params: JsonObject }[] = [];
  login: unknown = { user_id: context.selfId };
  botMember: unknown = { group_id: LISTENER_GROUP, user_id: context.selfId, role: 'admin' };
  member: unknown = { group_id: LISTENER_GROUP, user_id: target, role: 'member' };
  message: unknown = { group_id: LISTENER_GROUP, message_id: '-99', message_type: 'group', sender: { user_id: target } };
  failMutation = false;
  hook?: (action: string, params: JsonObject) => Promise<void>;
  async call(action: string, params: JsonObject = {}): Promise<unknown> {
    this.calls.push({ action, params }); await this.hook?.(action, params);
    if (action === 'get_login_info') return this.login;
    if (action === 'get_group_member_info') return params.user_id === context.selfId ? this.botMember : this.member;
    if (action === 'get_msg') return this.message;
    assert.ok(mutations.has(action), `unexpected API ${action}`);
    if (this.failMutation) throw new Error('SECRET CHAT BODY');
    return null;
  }
  writes() { return this.calls.filter(call => mutations.has(call.action)); }
}
const args = { user_id: target, seconds: 60 };
async function proposal(m: Moderation, name = 'mute_member', value: unknown = args, requester = context) {
  const result = await m.request(name, value, requester);
  assert.equal(result.status, 'confirmation_required'); assert.equal(result.expires_in_seconds, 60);
  assert.match(String(result.code), /^[0-9a-f]{32}$/); assert.ok(typeof result.description === 'string');
  assert.equal((result.action as JsonObject).name, name);
  return String(result.code);
}

test('policy rejects legacy booleans, malformed options and security-limit increases before API calls', () => {
  const api = new FakeApi();
  const invalid = [null, [], false, { unknown: true }, { [Symbol('unknown')]: true }, Object.create({ mute: 'direct' }),
    ...['mute', 'unmute', 'recall', 'memberCard'].flatMap(key => [true, false, 0, 'false', 'true', 'DIRECT', null, undefined].map(value => ({ [key]: value }))),
    ...[0, -1, 61, 1.5, NaN, Infinity, '60', undefined].map(confirmationTtlSeconds => ({ confirmationTtlSeconds })),
    ...[0, -1, 601, 1.5, NaN, Infinity, '600', undefined].map(maxMuteSeconds => ({ maxMuteSeconds }))];
  for (const options of invalid) {
    assert.throws(() => new Moderation(api, Date.now, options as any), /Invalid moderation options/);
    assert.throws(() => buildModerationTools(options as any), /Invalid moderation options/);
  }
  assert.equal(api.calls.length, 0);
});

test('off policy denies requests and confirmation before any API calls', async () => {
  for (const [key, name, value] of [
    ['mute', 'mute_member', args], ['unmute', 'unmute_member', { user_id: target }],
    ['recall', 'recall_message', { message_id: '-99' }], ['memberCard', 'set_member_card', { user_id: target, card: 'x' }],
  ] as const) {
    const api = new FakeApi(), m = new Moderation(api, Date.now, { [key]: 'off' });
    assert.equal((await m.request(name, value, context)).error, 'tool_disabled'); assert.equal(api.calls.length, 0);
    const enabled = new Moderation(new FakeApi(), Date.now, CONFIRM), code = await proposal(enabled, name, value);
    (m as any).pending.set(code, (enabled as any).pending.get(code));
    assert.equal((await m.confirm(code, context)).error, 'tool_disabled');
    assert.equal((m as any).pending.size, 0); assert.equal(api.calls.length, 0);
  }
});

test('reduced caps and TTL apply to requests and confirmation with copied policy', async () => {
  let now = 1000;
  const options: Partial<ModerationPolicy> = { maxMuteSeconds: 10, confirmationTtlSeconds: 2, mute: 'confirm' };
  const api = new FakeApi(), m = new Moderation(api, () => now, options);
  options.maxMuteSeconds = 600; options.confirmationTtlSeconds = 60; options.mute = 'off';
  for (const seconds of [0, 11]) assert.equal((await m.request('mute_member', { ...args, seconds }, context)).error, 'invalid_arguments');
  assert.equal(api.calls.length, 0);
  for (const seconds of [1, 10]) {
    const result = await m.request('mute_member', { ...args, seconds }, context);
    assert.equal(result.status, 'confirmation_required'); assert.equal(result.expires_in_seconds, 2);
    assert.ok(String(result.description).includes(String(seconds))); now += 1999;
    assert.equal((await m.confirm(String(result.code), context)).status, 'executed'); assert.equal(api.writes().at(-1)?.params.duration, seconds);
  }
  const expired = await m.request('mute_member', { ...args, seconds: 10 }, context); now += 2000;
  const before = api.calls.length;
  assert.equal((await m.confirm(String(expired.code), context)).error, 'confirmation_expired'); assert.equal(api.calls.length, before);
  const enabled = new Moderation(new FakeApi(), () => now, CONFIRM), code = await proposal(enabled);
  (m as any).pending.set(code, (enabled as any).pending.get(code));
  assert.equal((await m.confirm(code, context)).error, 'invalid_arguments'); assert.equal(api.calls.length, before);
});

test('disabled policy remains disabled after caller mutates options', async () => {
  const options: Partial<ModerationPolicy> = { mute: 'off' }, api = new FakeApi(), m = new Moderation(api, Date.now, options);
  options.mute = 'direct'; assert.equal((await m.request('mute_member', args, context)).error, 'tool_disabled'); assert.equal(api.calls.length, 0);
});

test('exports four strict independent tools without legacy mute-zero', () => {
  assert.deepEqual(MODERATION_TOOLS.map(tool => tool.function.name), ['mute_member', 'unmute_member', 'recall_message', 'set_member_card']);
  for (const tool of MODERATION_TOOLS) assert.equal(tool.function.parameters.additionalProperties, false);
  assert.equal(((MODERATION_TOOLS[0]!.function.parameters.properties as JsonObject).seconds as JsonObject).minimum, 1);
  assert.deepEqual(MODERATION_TOOLS[1]!.function.parameters.required, ['user_id']);
});

test('confirm requests never mutate; owner revalidates and executes exact action once', async () => {
  for (const [name, value, action, params] of [
    ['mute_member', args, 'set_group_ban', { group_id: LISTENER_GROUP, user_id: target, duration: 60 }],
    ['unmute_member', { user_id: target }, 'set_group_ban', { group_id: LISTENER_GROUP, user_id: target, duration: 0 }],
    ['set_member_card', { user_id: target, card: 'New card' }, 'set_group_card', { group_id: LISTENER_GROUP, user_id: target, card: 'New card' }],
    ['recall_message', { message_id: '-99' }, 'delete_msg', { message_id: '-99' }],
  ] as const) {
    const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM);
    const code = await proposal(m, name, value, { ...context, actorId: '456' });
    assert.equal(api.writes().length, 0);
    assert.equal((await m.confirm(code, { ...context, messageId: '101' })).status, 'executed');
    assert.deepEqual(api.writes(), [{ action, params }]); assert.equal(api.calls.filter(call => call.action === 'get_login_info').length, 2);
    assert.equal(api.calls.filter(call => call.action === 'get_group_member_info').length, 4);
    assert.ok(api.calls.filter(call => call.action === 'get_group_member_info').every(call => call.params.no_cache === true));
    if (name === 'recall_message') assert.equal(api.calls.filter(call => call.action === 'get_msg').length, 2);
    assert.equal((await m.confirm(code, context)).status, 'error'); assert.equal(api.writes().length, 1); m.dispose();
  }
});

test('wrong group, malformed actor and unverified bot identity fail; names and quotes do not authorize', async () => {
  for (const patch of [{ actorId: '' }, { actorId: '0123' }, { groupId: '123' }, { selfId: '77' }, { selfId: OWNER_ID }, { selfId: '' }, { messageId: '' }]) {
    const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM);
    assert.equal((await m.request('mute_member', args, { ...context, ...patch })).status, 'error'); assert.equal(api.writes().length, 0);
  }
  const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM);
  assert.equal((await m.request('mute_member', { ...args, quote: { actorId: OWNER_ID } }, { ...context, actorId: target })).error, 'invalid_arguments');
  api.login = {}; assert.equal((await m.request('mute_member', args, context)).error, 'identity_mismatch');
});

test('strict argument allowlist rejects arbitrary actions, fields and malformed values', async () => {
  const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM);
  const invalid: [string, unknown][] = [
    ['call_api', { action: 'set_group_ban', params: args }], ['set_group_ban', args], ['toString', {}],
    ['mute_member', { ...args, group_id: LISTENER_GROUP }], ['mute_member', { ...args, reason: 'owner says yes' }],
    ['mute_member', { seconds: 1 }], ['mute_member', { ...args, user_id: 123456 }],
    ...[`${OWNER_ID}\n`, `${context.selfId}\r`, '0123', '0', '1'.repeat(33)].map(user_id => ['mute_member', { ...args, user_id }] as [string, unknown]),
    ...[0, -1, 601, 1.5, NaN, Infinity, '60'].map(seconds => ['mute_member', { ...args, seconds }] as [string, unknown]),
    ['mute_member', null], ['mute_member', []], ['mute_member', Object.create(args)],
    ['mute_member', Object.defineProperty({ seconds: 2 }, 'user_id', { enumerable: true, get() { throw Error('must not access'); } })],
    ['unmute_member', { user_id: target, seconds: 0 }], ['unmute_member', {}], ['unmute_member', { user_id: 123 }],
    ...['', 'x'.repeat(61), 'bad\ncard', 'bad\u0000card', 'bad\u202ecard'].map(card => ['set_member_card', { user_id: target, card }] as [string, unknown]),
    ['set_member_card', { card: 'abc' }], ['set_member_card', { user_id: target, card: 1 }],
    ...[99, '', '1e3', '1.1', ' 99', '--99', '-99\n', '-99\r', '-0', '01', '9007199254740992'].map(message_id => ['recall_message', { message_id }] as [string, unknown]),
    ['recall_message', { message_id: '-99', user_id: target }],
  ];
  for (const [name, value] of invalid) assert.equal((await m.request(name, value, context)).error, 'invalid_arguments', name);
  assert.equal(api.calls.length, 0);
});

test('target member identity, group and actual QQ role still fail closed', async () => {
  for (const member of [{}, { group_id: LISTENER_GROUP }, { user_id: target }, { group_id: '1', user_id: target, role: 'member' }, { group_id: LISTENER_GROUP, user_id: '999', role: 'member' }, ...['owner', 'admin', undefined, 'unknown'].map(role => ({ group_id: LISTENER_GROUP, user_id: target, role }))]) {
    const api = new FakeApi(); api.member = member;
    assert.equal((await new Moderation(api, Date.now, CONFIRM).request('mute_member', args, context)).status, 'error'); assert.equal(api.writes().length, 0);
  }
});

test('recall requires matching message ID, group, type, sender and any redundant sender ID', async () => {
  for (const patch of [{ group_id: '1' }, { group_id: undefined }, { message_type: 'private' }, { message_type: undefined }, { message_id: '-98' }, { message_id: undefined }, { sender: {} }, { sender: undefined }, { user_id: '77' }, { user_id: undefined }]) {
    const api = new FakeApi(); api.message = { ...(api.message as JsonObject), ...patch };
    assert.equal((await new Moderation(api, Date.now, CONFIRM).request('recall_message', { message_id: '-99' }, context)).status, 'error'); assert.equal(api.writes().length, 0);
  }
});

test('confirmation detects changed target members, messages, current self and revoked bot role', async () => {
  for (const patch of [{ role: 'admin' }, { role: 'owner' }, { group_id: '1' }, { user_id: '99' }, { user_id: undefined }]) {
    const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM), code = await proposal(m);
    api.member = { ...(api.member as JsonObject), ...patch };
    assert.equal((await m.confirm(code, context)).status, 'error'); assert.equal(api.writes().length, 0);
  }
  for (const patch of [{ group_id: '1' }, { message_type: 'private' }, { sender: { user_id: OWNER_ID } }, { sender: { user_id: context.selfId } }, { sender: { user_id: '999' } }, { message_id: undefined }]) {
    const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM), code = await proposal(m, 'recall_message', { message_id: '-99' });
    api.message = { ...(api.message as JsonObject), ...patch };
    assert.equal((await m.confirm(code, context)).status, 'error'); assert.equal(api.writes().length, 0);
  }
  for (const revoke of [(api: FakeApi) => { api.login = { user_id: '999' }; }, (api: FakeApi) => { (api.botMember as JsonObject).role = 'member'; }]) {
    const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM), code = await proposal(m); revoke(api);
    assert.equal((await m.confirm(code, context)).status, 'error'); assert.equal(api.writes().length, 0);
  }
});

test('unauthorized or foreign confirmation cannot burn codes; concurrent owner confirmations execute once', async () => {
  for (const patch of [{ actorId: target }, { groupId: '1' }, { selfId: '999' }]) {
    const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM), code = await proposal(m);
    const before = api.calls.length;
    assert.equal((await m.confirm(code, { ...context, ...patch })).status, 'error'); assert.equal(api.calls.length, before);
    assert.equal((await m.confirm(code, context)).status, 'executed'); assert.equal(api.writes().length, 1);
  }
  const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM), code = await proposal(m);
  assert.deepEqual((await Promise.all([m.confirm(code, context), m.confirm(code, context)])).map(result => result.status).sort(), ['error', 'executed']); assert.equal(api.writes().length, 1);
});

test('TTL, bounded pending capacity, and disposal', async () => {
  let now = 1000; const api = new FakeApi(), m = new Moderation(api, () => now, CONFIRM), code = await proposal(m);
  for (let i = 1; i < 10; i++) await proposal(m);
  assert.equal((await m.request('mute_member', args, context)).error, 'confirmation_limit'); now += 60_000;
  assert.equal((await m.confirm(code, context)).error, 'confirmation_expired'); const fresh = await proposal(m); m.dispose();
  assert.equal((await m.confirm(fresh, context)).error, 'cancelled'); assert.equal((await m.request('mute_member', args, context)).error, 'cancelled'); assert.equal(api.writes().length, 0);
});

test('expiry and disposal during async verification stop further reads and prevent execution', async () => {
  for (const mode of ['expire', 'dispose']) {
    let now = 0; const api = new FakeApi(), m = new Moderation(api, () => now, CONFIRM), code = await proposal(m);
    const before = api.calls.length;
    api.hook = async action => { if (action === 'get_login_info') { if (mode === 'expire') now = 60_000; else m.dispose(); } };
    assert.equal((await m.confirm(code, context)).status, 'error'); assert.equal(api.calls.length, before + 1); assert.equal(api.writes().length, 0);
  }
});

test('snapshots request args/context and returned action; uncertain dispatch consumes code without leaking or retrying', async () => {
  const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM), original = { ...args }, originalContext = { ...context };
  const pending = m.request('mute_member', original, originalContext); original.seconds = 600; originalContext.groupId = '77'; originalContext.selfId = target;
  const result = await pending; assert.equal(result.status, 'confirmation_required'); (result.action as JsonObject).seconds = 599;
  api.failMutation = true; const response = await m.confirm(String(result.code), context);
  assert.deepEqual(response, { status: 'unknown', error: 'delivery_unknown', effect_unknown:true, retry_allowed:false }); assert.ok(!JSON.stringify(response).includes('SECRET'));
  assert.equal(api.writes()[0]?.params.duration, 60); assert.equal((await m.confirm(String(result.code), context)).status, 'error'); assert.equal(api.writes().length, 1);
});

test('revoked recall lookup fails safely and consumes owner confirmation', async () => {
  const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM), code = await proposal(m, 'recall_message', { message_id: '-99' });
  api.hook = async action => { if (action === 'get_msg') throw new Error('SECRET REVOKED MESSAGE BODY'); };
  const result = await m.confirm(code, context); assert.equal(result.error, 'verification_unavailable'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  api.hook = undefined; assert.equal((await m.confirm(code, context)).status, 'error'); assert.equal(api.writes().length, 0);
});

test('audit distinguishes request, confirmed and autonomous phases without card content, codes or remote errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'listener-audit-'));
  const logger = configureLogging({ level: 'debug', console: false, file: true, directory, retentionDays: 1, maxFileMb: 1, maxTotalMb: 2 });
  try {
    const api = new FakeApi(), m = new Moderation(api, Date.now, CONFIRM);
    const code = await proposal(m, 'set_member_card', { user_id: target, card: 'PRIVATE CARD CONTENT' }, { ...context, actorId: '987' });
    api.failMutation = true; await m.confirm(code, context);
    const direct = new Moderation(new FakeApi(), Date.now, { unmute: 'direct' }); await direct.request('unmute_member', { user_id: target }, { ...context, actorId: '987' });
    await logger.flush();
    const text = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')))).join('');
    const logs = text.trim().split('\n'); assert.equal(logs.length, 3);
    const parsed = logs.map(line => { assert.ok(!line.includes('PRIVATE') && !line.includes('SECRET') && !line.includes(code)); return JSON.parse(line); });
    assert.deepEqual(parsed.map(entry => entry.phase), ['request', 'confirm', 'direct']);
    assert.deepEqual(parsed.map(entry => entry.actor_id), ['987', OWNER_ID, '987']);
    assert.deepEqual(parsed.map(entry => entry.action), ['set_member_card', 'set_member_card', 'unmute_member']);
    for (const entry of parsed) { assert.equal(entry.event, 'moderation.audit'); assert.equal(entry.target_id, target); assert.ok(entry.outcome); }
  } finally { await logger.close(); await rm(directory, { recursive: true, force: true }); }
});
