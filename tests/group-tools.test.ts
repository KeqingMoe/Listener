import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupTools, GROUP_TOOLS, SEND_MESSAGE_TOOL } from '../src/group-tools.js';
import { LISTENER_GROUP, type Api, type Memory, type TimelineEntry, type TurnContext } from '../src/contracts.js';

const context: TurnContext = { groupId: LISTENER_GROUP, actorId: '123', selfId: '999', messageId: '1' };
const record = (user_id = '123', extra = {}) => ({ group_id: LISTENER_GROUP, user_id, nickname: 'Alice', card: 'team', role: 'member', ...extra });
const entry: TimelineEntry = { messageId: '1', userId: '123', nickname: 'Alice', text: 'hello', time: 42, replyTo: '2' };
const remote = (extra = {}) => ({ group_id: LISTENER_GROUP, message_type: 'group', message_id: '2', sender: { user_id: '123', nickname: 'Alice', private: 'secret' }, time: 42, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'at', data: { qq: '456' } }, { type: 'image', data: { url: 'https://secret.invalid/a', file: 'secret' } }], ...extra });
function setup(response: unknown = record(), entries: TimelineEntry[] = [entry]) {
  const calls: Array<{ action: string; params: unknown }> = [];
  const api: Api = { async call(action, params) { calls.push({ action, params }); if (response instanceof Error) throw response; return response; } };
  const memory: Memory = { append: () => true, recent: () => entries, find: id => entries.find(e => e.messageId === id), context: () => '', compact: async () => {}, clear() {}, close() {} };
  return { tools: new GroupTools(api, memory), calls };
}

test('schemas advertise structured segments, fixed group tools, no legacy text', () => {
  assert.deepEqual(GROUP_TOOLS.map(t => t.function.name), ['get_group_members', 'get_member_info', 'read_message']);
  const parameters = SEND_MESSAGE_TOOL.function.parameters as any;
  assert.equal(parameters.properties.parts.maxItems, 3);
  assert.deepEqual(parameters.properties.parts.items.required, ['segments']);
  assert.equal(parameters.properties.parts.items.properties.text, undefined);
});

test('prepare serializes native at without sending or mutating input; nonowner allowed', async () => {
  const { tools, calls } = setup();
  const args = { parts: [{ segments: [{ type: 'text', text: 'Hello ' }, { type: 'at', user_id: '123' }], reply_to: '1' }] };
  const original = structuredClone(args);
  assert.deepEqual(await tools.prepareMessage(args, context), [{ segments: [{ type: 'text', data: { text: 'Hello ' } }, { type: 'at', data: { qq: '123' } }], text: 'Hello [at:123]', replyTo: '1' }]);
  assert.deepEqual(args, original);
  assert.deepEqual(calls, [{ action: 'get_group_member_info', params: { group_id: LISTENER_GROUP, user_id: '123', no_cache: true } }]);
});

test('legacy text and at-only parts accepted internally', async () => {
  const { tools } = setup();
  assert.equal((await tools.prepareMessage({ parts: [{ text: 'old style', reply_to: '1' }] }, context))[0]?.text, 'old style');
  assert.equal((await tools.prepareMessage({ parts: [{ segments: [{ type: 'at', user_id: '123' }] }] }, context))[0]?.text, '[at:123]');
});

test('entire batch syntax validation precedes any remote verification', async () => {
  const { tools, calls } = setup();
  await assert.rejects(tools.prepareMessage({ parts: [{ segments: [{ type: 'at', user_id: '123' }] }, { text: '' }] }, context));
  assert.equal(calls.length, 0);
});

test('reject extras, spoofed mentions, whitespace ids, all/self, mixed representations and limits', async () => {
  const { tools, calls } = setup();
  const badParts = [
    { text: 'hello', group_id: LISTENER_GROUP }, { text: 'hello', segments: [] },
    { text: 'hello [at:123]' }, { text: '[CQ:at,qq=123]' }, { text: '  ' }, { text: 'a'.repeat(801) },
    { segments: [{ type: 'text', text: 'a'.repeat(500) }, { type: 'text', text: 'b'.repeat(301) }] },
    { segments: [{ type: 'text', text: '[a' }, { type: 'text', text: 't:123]' }] },
    { segments: Array.from({ length: 13 }, () => ({ type: 'text', text: 'x' })) },
    ...['all', '0', '999', '999\n', '123\n', ' 123', '123 ', '01'].map(user_id => ({ segments: [{ type: 'at', user_id }] })),
    { segments: [{ type: 'at', user_id: '123', qq: 'all' }] }, { segments: [{ type: 'text', text: 'a', extra: true }] },
    { text: 'hello', reply_to: ' 1' }, { text: 'hello', reply_to: 1 },
  ];
  for (const part of badParts) await assert.rejects(tools.prepareMessage({ parts: [part] }, context), undefined, JSON.stringify(part));
  for (const args of [{ parts: [], group_id: LISTENER_GROUP }, { parts: Array(4).fill({ text: 'a' }) }, { parts: [{ segments: Array(4).fill({ type: 'at', user_id: '123' }) }] }]) await assert.rejects(tools.prepareMessage(args, context));
  assert.equal(calls.length, 0);
});

test('unknown roles are not presented as verified member roles', async () => {
  for (const role of ['superadmin', undefined, ['admin'], { role: 'owner' }]) {
    const { tools, calls } = setup(record('123', { role }));
    const result = await tools.execute('get_member_info', { user_id: '123' }, context);
    assert.equal((result.member as any).role, 'unknown');
    assert.equal((calls[0]?.params as any).no_cache, true);
    const list = setup([record('123', { role })]);
    assert.equal(((await list.tools.execute('get_group_members', {}, context)).members as any[])[0].role, 'unknown');
  }
});

test('newline ids are rejected in reads, replies and remote member records', async () => {
  const { tools, calls } = setup();
  assert.equal((await tools.execute('get_member_info', { user_id: '123\n' }, context)).status, 'error');
  assert.equal((await tools.execute('read_message', { message_id: '2\n' }, context)).status, 'error');
  await assert.rejects(tools.prepareMessage({ parts: [{ text: 'x', reply_to: '2\n' }] }, context));
  assert.equal(calls.length, 0);
  const list = setup([record('123\n')]);
  assert.equal((await list.tools.execute('get_group_members', {}, context)).status, 'error');
});

test('fixed group scope independently enforced before calls', async () => {
  const { tools, calls } = setup();
  const wrong = { ...context, groupId: '123' };
  for (const name of GROUP_TOOLS.map(t => t.function.name)) assert.equal((await tools.execute(name, {}, wrong)).error, 'forbidden_group');
  await assert.rejects(tools.prepareMessage({ parts: [{ text: 'x' }] }, wrong));
  assert.equal(calls.length, 0);
});

test('member list pagination, filtering and redaction use native fixed-group API', async () => {
  const records = Array.from({ length: 55 }, (_, i) => record(String(100 + i), { nickname: `Person ${i}`, card: i % 2 ? 'red' : 'blue', age: 22, secret: 'hidden' }));
  const { tools, calls } = setup(records);
  const first = await tools.execute('get_group_members', {}, context);
  assert.equal((first.members as unknown[]).length, 20);
  assert.equal(first.total, 55);
  assert.equal(first.has_more, true);
  const page = await tools.execute('get_group_members', { search: 'BLUE', offset: 2, limit: 3 }, context);
  assert.equal(page.total, 28);
  assert.deepEqual((page.members as any[]).map(m => m.user_id), ['104', '106', '108']);
  assert.deepEqual(Object.keys((page.members as any[])[0]), ['user_id', 'nickname', 'card', 'role']);
  assert.equal((await tools.execute('get_group_members', { search: '154' }, context)).total, 1);
  assert.deepEqual(calls[0], { action: 'get_group_member_list', params: { group_id: LISTENER_GROUP } });
});

test('invalid pagination and extras do not invoke API', async () => {
  const { tools, calls } = setup([]);
  for (const args of [{ search: 'x'.repeat(101) }, { limit: 51 }, { limit: 0 }, { offset: 100001 }, { offset: -1 }, { offset: 0.1 }, { group_id: LISTENER_GROUP }]) assert.equal((await tools.execute('get_group_members', args, context)).status, 'error');
  for (const args of [{ user_id: '123 ', group_id: LISTENER_GROUP }, { user_id: 123 }, { user_id: 'all' }]) assert.equal((await tools.execute('get_member_info', args, context)).status, 'error');
  assert.equal(calls.length, 0);
});

test('list validates every record fail closed and caps source size', async () => {
  for (const raw of [[record(), record('456', { group_id: 'other' })], [record('')], [record('123', { group_id: undefined })], Array(100001).fill(record())]) {
    const { tools } = setup(raw);
    assert.equal((await tools.execute('get_group_members', { limit: 1 }, context)).status, 'error');
  }
});

test('member and at verification require exact group and user', async () => {
  for (const raw of [record('456'), record('123', { group_id: '1' }), { user_id: '123' }]) {
    const { tools, calls } = setup(raw);
    assert.equal((await tools.execute('get_member_info', { user_id: '123' }, context)).status, 'error');
    await assert.rejects(tools.prepareMessage({ parts: [{ segments: [{ type: 'at', user_id: '123' }] }] }, context));
    assert.ok(calls.every(c => c.action === 'get_group_member_info'));
  }
});

test('read uses local memory first, remote only for local reference; normalized remote hides media', async () => {
  const { tools, calls } = setup(remote());
  assert.equal((await tools.execute('read_message', { message_id: '1' }, context)).status, 'ok');
  assert.equal(calls.length, 0);
  assert.equal((await tools.execute('read_message', { message_id: '500' }, context)).error, 'message_not_in_context');
  assert.equal(calls.length, 0);
  const result = await tools.execute('read_message', { message_id: '2' }, context);
  assert.deepEqual(result, { status: 'ok', message: { messageId: '2', userId: '123', nickname: 'Alice', text: 'hello[at:456][图片：未分析]', time: 42 } });
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.deepEqual(calls, [{ action: 'get_msg', params: { message_id: '2' } }]);
});

test('remote read and reply verification reject wrong group, type and id', async () => {
  for (const extra of [{ group_id: '1' }, { message_type: 'private' }, { message_id: '3' }, { sender: { user_id: 'all' } }]) {
    const { tools } = setup(remote(extra));
    assert.equal((await tools.execute('read_message', { message_id: '2' }, context)).status, 'error');
    await assert.rejects(tools.prepareMessage({ parts: [{ text: 'reply', reply_to: '2' }] }, context));
  }
  const { tools } = setup(remote());
  assert.equal((await tools.prepareMessage({ parts: [{ text: 'reply', reply_to: '2' }] }, context))[0]?.replyTo, '2');
});

test('mention limit spans all parts and remote output fields stay bounded', async () => {
  const { tools, calls } = setup();
  await assert.rejects(tools.prepareMessage({ parts: [
    { segments: [{ type: 'at', user_id: '123' }, { type: 'at', user_id: '123' }] },
    { segments: [{ type: 'at', user_id: '123' }, { type: 'at', user_id: '123' }] },
  ] }, context));
  assert.equal(calls.length, 0);
  const bounded = setup(remote({ sender: { user_id: '123', nickname: 'n'.repeat(1000) }, message: [{ type: 'text', data: { text: 'x'.repeat(10000) } }] }));
  const result = await bounded.tools.execute('read_message', { message_id: '2' }, context);
  assert.equal((result.message as any).text.length, 4000);
  assert.equal((result.message as any).nickname.length, 80);
});

test('safe errors never disclose API exception details', async () => {
  const { tools } = setup(new Error('token=private endpoint=secret'));
  for (const [name, args] of [['get_group_members', {}], ['get_member_info', { user_id: '123' }], ['read_message', { message_id: '2' }]] as const) {
    assert.deepEqual(await tools.execute(name, args, context), { status: 'error', error: 'api_unavailable' });
  }
  await assert.rejects(tools.prepareMessage({ parts: [{ segments: [{ type: 'at', user_id: '123' }] }] }, context), /^Error: api_unavailable$/);
});
