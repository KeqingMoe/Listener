import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupTools, GROUP_TOOLS, SEND_MESSAGE_TOOL, type GroupToolsOptions } from '../../../../src/tools/messaging/tools.js';
import { LISTENER_GROUP } from '../../../../src/contracts/identity.js';
import { type Api } from '../../../../src/contracts/onebot.js';
import { type JsonObject } from '../../../../src/contracts/json.js';
import { type Memory, type TimelineEntry } from '../../../../src/contracts/messages.js';
import { type TurnContext } from '../../../../src/contracts/tools.js';

const context: TurnContext = { groupId: LISTENER_GROUP, actorId: '123', selfId: '999', messageId: '1' };
const record = (user_id = '123', extra = {}) => ({ group_id: LISTENER_GROUP, user_id, nickname: 'Alice', card: 'team', role: 'member', ...extra });
const entry: TimelineEntry = { messageId: '1', userId: '123', nickname: 'Alice', text: 'hello', time: 42, replyTo: '2' };
const remote = (extra = {}) => ({ group_id: LISTENER_GROUP, message_type: 'group', message_id: '2', sender: { user_id: '123', nickname: 'Alice', private: 'secret' }, time: 42, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'at', data: { qq: '456' } }, { type: 'image', data: { url: 'https://secret.invalid/a', file: 'secret' } }], ...extra });
function setup(response: unknown = record(), entries: TimelineEntry[] = [entry], options?: GroupToolsOptions) {
  const calls: Array<{ action: string; params: unknown }> = [];
  const api: Api = { async call(action, params) { calls.push({ action, params }); if (response instanceof Error) throw response; return response; } };
  const memory: Memory = { append: () => true, recent: () => entries, find: id => entries.find(e => e.messageId === id), context: () => '', compact: async () => {}, clear() {}, close() {} };
  return { tools: new GroupTools(api, memory, options), calls };
}

test('options reject malformed runtime values and increased hard limits', () => {
  for (const options of [null, [], true, { unknown: true }, { [Symbol('x')]: true }, Object.create({ members: true }),
    ...['members', 'mention'].flatMap(key => [0, 'false', null, undefined].map(value => ({ [key]: value }))),
    ...[0, -1, 11, 1.5, NaN, Infinity, '3', undefined].map(maxParts => ({ maxParts }))]) {
    assert.throws(() => setup(record(), [entry], options as any), /Invalid group tool options/);
  }
});

test('members disabled denies invented member tools without disabling message reads', async () => {
  const { tools, calls } = setup(remote(), [entry], { members: false });
  for (const [name, args] of [['get_group_members', { limit: 20 }], ['get_member_info', { user_id: '123' }]] as const) {
    assert.deepEqual(await tools.execute(name, args, context), { status: 'error', error: 'tool_disabled' });
  }
  assert.equal(calls.length, 0);
  assert.equal((await tools.execute('read_message', { message_id: '1' }, context)).status, 'ok');
  assert.equal((await tools.execute('read_message', { message_id: '2' }, context)).status, 'ok');
  assert.deepEqual(calls.map(c => c.action), ['get_msg']);
});

const message=(text:string,reply_to?:string)=>({segments:[{type:'text',text}],...(reply_to?{reply_to}:{})});

test('disabled mentions reject invented at during preparation before reply lookup', async () => {
  const { tools, calls } = setup(record(), [entry], { mention: false });
  await assert.rejects(tools.prepareMessage({reply_to:'2',segments:[{type:'text',text:'reply'},{type:'at',user_id:'123'}]},context),/tool_disabled/);
  assert.equal(calls.length,0);assert.equal((await tools.prepareMessage(message('hello'),context)).text,'hello');
  assert.equal((await tools.execute('get_member_info',{user_id:'123'},context)).status,'ok');
});

test('reply targets cannot fetch arbitrary messages outside the supplied snapshot',async()=>{
 const s=setup(remote({message_id:'99'}));
 await assert.rejects(s.tools.prepareMessage(message('reply','99'),context),/forbidden_reference/);
 assert.equal(s.calls.length,0);
 const scoped=setup(remote());assert.equal((await scoped.tools.prepareMessage(message('reply','2'),context)).replyTo,'2');
 assert.deepEqual(scoped.calls.map(call=>call.action),['get_msg']);
});

test('mention verification remains allowed when member tools are disabled', async () => {
  const { tools, calls } = setup(record(), [entry], { members: false, mention: true });
  assert.equal((await tools.prepareMessage({ segments: [{ type: 'at', user_id: '123' }] }, context)).segments.length, 1);
  assert.deepEqual(calls.map(c => c.action), ['get_group_member_info']);
  const wrongGroup = setup(record('123', { group_id: '1' }), [entry], { members: false });
  await assert.rejects(wrongGroup.tools.prepareMessage({ segments: [{ type: 'at', user_id: '123' }] }, context), /verification_failed/);
});

test('removed part options are rejected and remaining options are captured by copy', async () => {
  for(const maxParts of [1,2,3,4,10])assert.throws(()=>setup(record(),[entry],{maxParts} as any),/Invalid group tool options/);
  const options={members:false,mention:false};const {tools,calls}=setup(record(),[entry],options);
  options.members=true;options.mention=true;
  assert.equal((await tools.prepareMessage(message('hello'),context)).text,'hello');
  assert.equal((await tools.execute('get_member_info',{user_id:'123'},context)).error,'tool_disabled');
  await assert.rejects(tools.prepareMessage({segments:[{type:'at',user_id:'123'}]},context),/tool_disabled/);assert.equal(calls.length,0);
});

test('schemas advertise structured segments, fixed group tools, no legacy text', () => {
  assert.deepEqual(GROUP_TOOLS.map(t => t.function.name), ['get_group_members', 'get_member_info', 'read_message']);
  const parameters = SEND_MESSAGE_TOOL.function.parameters as any;
  assert.equal(parameters.properties.parts,undefined);assert.equal(parameters.properties.text,undefined);
  assert.deepEqual(parameters.required,['segments']);assert.equal(parameters.properties.segments.minItems,1);
  assert.equal(parameters.properties.segments.maxItems,undefined);
  assert.equal(parameters.properties.segments.items.oneOf[0].properties.text.maxLength,undefined);
});

test('prepare serializes native at without sending or mutating input; nonowner allowed', async () => {
  const { tools, calls } = setup();
  const args = { segments: [{ type: 'text', text: 'Hello ' }, { type: 'at', user_id: '123' }], reply_to: '1' };
  const original = structuredClone(args);
  assert.deepEqual(await tools.prepareMessage(args, context), { segments: [{ type: 'text', data: { text: 'Hello ' } }, { type: 'at', data: { qq: '123' } }], text: 'Hello [at:123]', replyTo: '1' });
  assert.deepEqual(args, original);
  assert.deepEqual(calls, [{ action: 'get_group_member_info', params: { group_id: LISTENER_GROUP, user_id: '123', no_cache: true } }]);
});

test('legacy text and parts shapes are rejected while structured text remains literal', async () => {
  const {tools}=setup();await assert.rejects(tools.prepareMessage({text:'old style'},context));await assert.rejects(tools.prepareMessage({parts:[{segments:[{type:'text',text:'old'}]}]},context));
  assert.equal((await tools.prepareMessage({segments:[{type:'at',user_id:'123'}]},context)).text,'[at:123]');
});

test('single-message syntax validation precedes remote verification', async () => {
  const {tools,calls}=setup();await assert.rejects(tools.prepareMessage({segments:[{type:'at',user_id:'123'},{type:'text',text:42}]},context));assert.equal(calls.length,0);
});

test('reject extras, invalid structured mentions, whitespace ids, all/self, mixed representations and empty or control text', async () => {
  const { tools, calls } = setup();
  const badParts = [
    { text: 'hello', group_id: LISTENER_GROUP }, { text: 'hello', segments: [] },
    ...['', ' \n\t ', 'bad\u0000text', 'x'.repeat(1000)+'\u0001'].map(text => message(text)),
    ...['image', 'record', 'video', 'file', 'forward', 'reply'].map(type => ({ segments: [{ type, resource: 'arbitrary' }] })),
    ...['all', '0', '999', '999\n', '123\n', ' 123', '123 ', '01'].map(user_id => ({ segments: [{ type: 'at', user_id }] })),
    { segments: [{ type: 'at', user_id: '123', qq: 'all' }] }, { segments: [{ type: 'text', text: 'a', extra: true }] },
    { text: 'hello', reply_to: ' 1' }, { text: 'hello', reply_to: 1 },
  ];
  for (const part of badParts) await assert.rejects(tools.prepareMessage(part, context), /invalid_arguments/, JSON.stringify(part));
  for (const args of [{ segments: [] }, { parts: [{text:'a'}] }]) await assert.rejects(tools.prepareMessage(args,context));
  assert.equal(calls.length, 0);
});

test('unknown roles are not presented as verified member roles', async () => {
  for (const role of ['superadmin', undefined, ['admin'], { role: 'owner' }]) {
    const { tools, calls } = setup(record('123', { role }));
    const result = await tools.execute('get_member_info', { user_id: '123' }, context);
    assert.equal((result.member as any).role, 'unknown');
    assert.equal((calls[0]?.params as any).no_cache, true);
    const list = setup([record('123', { role })]);
    assert.equal(((await list.tools.execute('get_group_members', { limit: 20 }, context)).members as any[])[0].role, 'unknown');
  }
});

test('newline ids are rejected in reads, replies and remote member records', async () => {
  const { tools, calls } = setup();
  assert.equal((await tools.execute('get_member_info', { user_id: '123\n' }, context)).status, 'error');
  assert.equal((await tools.execute('read_message', { message_id: '2\n' }, context)).status, 'error');
  await assert.rejects(tools.prepareMessage({ segments: [{type:'text',text:'x'}], reply_to:'2\n' }, context));
  assert.equal(calls.length, 0);
  const list = setup([record('123\n')]);
  assert.equal((await list.tools.execute('get_group_members', { limit: 20 }, context)).status, 'error');
});

test('fixed group scope independently enforced before calls', async () => {
  const { tools, calls } = setup();
  const wrong = { ...context, groupId: '123' };
  for (const name of GROUP_TOOLS.map(t => t.function.name)) assert.equal((await tools.execute(name, {}, wrong)).error, 'forbidden_group');
  await assert.rejects(tools.prepareMessage(message('x'), wrong));
  assert.equal(calls.length, 0);
});

test('member list pagination, filtering and redaction use native fixed-group API', async () => {
  const records = Array.from({ length: 55 }, (_, i) => record(String(100 + i), { nickname: `Person ${i}`, card: i % 2 ? 'red' : 'blue', age: 22, secret: 'hidden' }));
  const { tools, calls } = setup(records);
  const first = await tools.execute('get_group_members', { limit: 20 }, context);
  assert.equal((first.members as unknown[]).length, 20);
  assert.equal(first.total, 55);
  assert.equal(first.source, 'provider_member_cache');
  assert.equal(first.freshness, 'not_guaranteed');
  assert.equal(first.total_scope, 'provider_snapshot');
  assert.equal(first.has_more, true);
  const page = await tools.execute('get_group_members', { search: 'BLUE', offset: 2, limit: 3 }, context);
  assert.equal(page.total, 28);
  assert.deepEqual((page.members as any[]).map(m => m.user_id), ['104', '106', '108']);
  assert.deepEqual(Object.keys((page.members as any[])[0]), ['user_id', 'nickname', 'card', 'role']);
  assert.equal((await tools.execute('get_group_members', { search: '154', limit: 20 }, context)).total, 1);
  assert.deepEqual(calls[0], { action: 'get_group_member_list', params: { group_id: LISTENER_GROUP } });
});

test('invalid pagination and extras do not invoke API', async () => {
  const { tools, calls } = setup([]);
  for (const args of [{ search: 'x'.repeat(101) }, { limit: 0 }, { limit: 1.5 }, { limit: '20' }, { offset: Number.MAX_SAFE_INTEGER+1 }, { offset: -1 }, { offset: 0.1 }, { group_id: LISTENER_GROUP }]) assert.equal((await tools.execute('get_group_members', args, context)).status, 'error');
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
    await assert.rejects(tools.prepareMessage({ segments: [{ type: 'at', user_id: '123' }] }, context));
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
  assert.deepEqual(result, { status: 'ok', message: { messageId: '2', userId: '123', nickname: 'Alice', representation:'segments',segments:[{type:'text',text:'hello'},{type:'at',user_id:'456'},{type:'image',content_status:'not_viewed',image_id:'img_2_2'}], time: 42, images:[{id:'img_2_2',index:2}] } });
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.deepEqual(calls, [{ action: 'get_msg', params: { message_id: '2' } }]);
});

test('remote read and reply verification reject wrong group, type and id', async () => {
  for (const extra of [{ group_id: '1' }, { message_type: 'private' }, { message_id: '3' }, { sender: { user_id: 'all' } }]) {
    const { tools } = setup(remote(extra));
    assert.equal((await tools.execute('read_message', { message_id: '2' }, context)).status, 'error');
    await assert.rejects(tools.prepareMessage(message('reply','2'), context));
  }
  const { tools } = setup(remote());
  assert.equal((await tools.prepareMessage(message('reply','2'), context)).replyTo, '2');
});

test('long messages and repeated mentions retain all segments while verification is deduplicated', async () => {
  const { tools, calls } = setup();
  const text = '字😀'.repeat(801);
  assert.equal((await tools.prepareMessage(message(text),context)).text,text);
  const segments = [...Array.from({length:13},()=>({type:'text',text})), ...Array.from({length:5},()=>({type:'at',user_id:'123'}))];
  const prepared = await tools.prepareMessage({segments},context);
  assert.equal(prepared.segments.length,18);
  assert.equal(prepared.text,text.repeat(13)+'[at:123]'.repeat(5));
  assert.equal(calls.length,1);
});

test('remote output fields stay resource bounded independently of send limits', async () => {
  const bounded = setup(remote({ sender: { user_id: '123', nickname: 'n'.repeat(1000) }, message: [{ type: 'text', data: { text: 'x'.repeat(10000) } }] }));
  const result = await bounded.tools.execute('read_message', { message_id: '2' }, context);
  const message=result.message as any;
  assert.equal(message.text,undefined);assert.equal(message.content_truncated,true);
  assert.ok(JSON.stringify(message.segments).length<=4000);assert.ok(message.segments[0].text.length>3900);
  assert.equal((result.message as any).nickname.length, 80);
});

test('explicit collection count has no small hard cap and byte-bounded pages advance actual offset', async () => {
  const s=setup(Array.from({length:1000},(_,i)=>record(String(i+1),{nickname:'字'.repeat(80),card:'字'.repeat(80)})));
  const result=await s.tools.execute('get_group_members',{limit:Number.MAX_SAFE_INTEGER},context);
  assert.equal(result.status,'ok');assert.equal(result.requested,Number.MAX_SAFE_INTEGER);assert.equal(result.truncated,true);assert.equal(result.reason,'output_limit');assert.ok((result.returned as number)>0);assert.equal(result.next_offset,result.returned);assert.ok(Buffer.byteLength(JSON.stringify(result))<=24000);
  const next=await s.tools.execute('get_group_members',{offset:result.next_offset,limit:1},context);assert.equal((next.members as JsonObject[])[0]!.user_id,String((result.returned as number)+1));
  const small=setup(Array.from({length:60},(_,i)=>record(String(i+1))));const all=await small.tools.execute('get_group_members',{limit:60},context);assert.equal(all.returned,60);assert.equal(all.truncated,false);
  for(const limit of [undefined,null,0,-1,1.1,'5',true,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal((await small.tools.execute('get_group_members',{limit},context)).error,'invalid_arguments');
});

test('safe errors never disclose API exception details', async () => {
  const { tools } = setup(new Error('token=private endpoint=secret'));
  for (const [name, args] of [['get_group_members', { limit: 20 }], ['get_member_info', { user_id: '123' }], ['read_message', { message_id: '2' }]] as const) {
    assert.deepEqual(await tools.execute(name, args, context), { status: 'error', error: 'api_unavailable' });
  }
  await assert.rejects(tools.prepareMessage({ segments: [{ type: 'at', user_id: '123' }] }, context), /^Error: api_unavailable$/);
});
