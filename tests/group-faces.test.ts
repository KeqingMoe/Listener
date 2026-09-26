import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupTools, type GroupToolsOptions } from '../src/group-tools.js';
import { ForwardTools } from '../src/forward-tools.js';
import { faceMarker } from '../src/face-tools.js';
import { LISTENER_GROUP, type Api, type Memory, type TimelineEntry, type TurnContext } from '../src/contracts.js';

const context: TurnContext = { groupId: LISTENER_GROUP, actorId: '123', selfId: '999', messageId: '1' };
const entry: TimelineEntry = { messageId: '1', userId: '123', nickname: 'member', text: 'hello', time: 42, replyTo: '2' };
const face = (id: unknown) => ({ type: 'face', id });
const part = (segments: unknown[]) => ({ segments });
function memory(entries: TimelineEntry[]): Memory {
  return { append: () => false, recent: () => entries, find: id => entries.find(e => e.messageId === id), context: () => JSON.stringify(entries), compact: async () => {}, clear() {}, close() {} };
}
function setup(options: GroupToolsOptions = {}, response?: unknown) {
  const calls: Array<{ action: string; params: unknown }> = [];
  const api: Api = { async call(action, params) {
    calls.push({ action, params });
    return response ?? { group_id: LISTENER_GROUP, user_id: (params as any).user_id, nickname: 'member', role: 'member' };
  } };
  return { tools: new GroupTools(api, memory([entry]), options), calls };
}

test('ordinary zero and animated faces are independently visible without text', async () => {
  const s = setup();
  for (const id of ['0', '20', '375']) {
    const result = await s.tools.prepareMessage(part([face(id)]), context);
    assert.deepEqual(result.segments, [{ type: 'face', data: { id } }]);
    assert.equal(result.text, faceMarker(id));
  }
  assert.equal(s.calls.length, 0);
});

test('text at and face retain exact segment order and local reply target', async () => {
  const s = setup();
  const result = await s.tools.prepareMessage({reply_to:'1',segments:[
    { type: 'text', text: 'hello' }, { type: 'at', user_id: '456' }, face('20'), { type: 'text', text: 'bye' }, face('375'),
  ] }, context);
  assert.deepEqual(result.segments, [
    { type: 'text', data: { text: 'hello' } }, { type: 'at', data: { qq: '456' } },
    { type: 'face', data: { id: '20' } }, { type: 'text', data: { text: 'bye' } }, { type: 'face', data: { id: '375' } },
  ]);
  assert.equal(result.replyTo, '1');
  assert.equal(result.text, `hello[at:456]${faceMarker('20')}bye${faceMarker('375')}`);
  assert.deepEqual(s.calls.map(c => c.action), ['get_group_member_info']);
});

test('one message supports twelve faces without a separate face or parts quota',async()=>{
 const s=setup(),twelve=Array.from({length:12},()=>face('375'));
 assert.equal((await s.tools.prepareMessage(part(twelve),context)).segments.length,12);
 await assert.rejects(s.tools.prepareMessage(part([...twelve,face('0')]),context),/invalid_arguments/);
 await assert.rejects(s.tools.prepareMessage({parts:[part(twelve)]},context),/invalid_arguments/);
 assert.equal(s.calls.length,0);
});

test('faces do not consume mention quota and disabling mentions preserves faces', async () => {
  const s = setup();
  const ats = ['456', '457', '458'].map(user_id => ({ type: 'at', user_id }));
  const result = await s.tools.prepareMessage(part([...ats, ...Array.from({ length: 9 }, () => face('20'))]), context);
  assert.equal(result.segments.length, 12);
  assert.equal(s.calls.length, 3);
  const denied = setup();
  await assert.rejects(denied.tools.prepareMessage(part([...ats, { type: 'at', user_id: '459' }, face('0')]), context));
  assert.equal(denied.calls.length, 0);
  const noMention = setup({ mention: false });
  assert.equal((await noMention.tools.prepareMessage(part([face('375')]), context)).segments.length, 1);
  await assert.rejects(noMention.tools.prepareMessage(part([face('20'), ats[0]]), context), /tool_disabled/);
  assert.equal(noMention.calls.length, 0);
});

test('all invalid face IDs and extra animation fields fail before earlier member or reply lookups', async () => {
  const invalid = [
    ...[undefined, null, 0, 20, -1, '00', '020', '-1', '+20', ' 20', '20 ', '20\n', '1.0', '999999', {}, []].map(id => face(id)),
    { ...face('375'), chainCount: 3 }, { ...face('375'), resultId: '1' }, { ...face('20'), raw: 'SECRET' },
  ];
  for (const segment of invalid) {
    const s = setup();
    await assert.rejects(s.tools.prepareMessage({segments:[{type:'at',user_id:'456'},segment],reply_to:'2'}, context), /invalid_arguments/);
    assert.equal(s.calls.length, 0, JSON.stringify(segment));
  }
});

test('remote read_message renders face names and IDs without raw transport metadata', async () => {
  const s = setup({}, { message_type: 'group', group_id: LISTENER_GROUP, message_id: '2', sender: { user_id: '123' }, time: 42,
    message: [{ type: 'text', data: { text: 'before' } }, { type: 'face', data: { id: '20', raw: { token: 'SECRET_RAW' }, chainCount: 50 } },
      { type: 'face', data: { id: 375 } }, { type: 'face', data: { id: '999999' } }, { type: 'face', data: { id: 'SECRET_BAD_ID' } }],
  });
  const result = await s.tools.execute('read_message', { message_id: '2' }, context);
  assert.equal(result.status, 'ok');
  const message=result.message as any;assert.equal(message.text,undefined);
  assert.deepEqual(message.segments,[{type:'text',text:'before'},{type:'face',id:'20',name:'偷笑'},{type:'face',id:'375',name:'超级鼓掌'},{type:'face',id:'999999'},{type:'unsupported',kind:'face'}]);
  assert.equal(message.content_truncated,true);
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.ok(!JSON.stringify(result).includes('chainCount'));
});

test('forward read node faces use the same typed segments and never expose raw face data', async () => {
  const entries: TimelineEntry[] = [{ ...entry, forwards: [{ id: 'fwd_1_0', index: 0 }] }];
  const calls: string[] = [];
  const api: Api = { async call(action) {
    calls.push(action);
    assert.equal(action, 'get_msg');
    return { message_type: 'group', group_id: LISTENER_GROUP, message_id: '1', sender: { user_id: '123' }, message: [{ type: 'forward', data: { id: 'RESOURCE_SECRET', content: [
      { sender: { user_id: '456', nickname: 'claimed' }, time: 42, message: [
        { type: 'face', data: { id: '20', raw: { token: 'RAW_SECRET' }, resultId: 'SECRET_RESULT' } },
        { type: 'face', data: { id: '375' } }, { type: 'face', data: { id: 'BAD_SECRET' } },
      ] },
    ] } }] };
  } };
  const tools = new ForwardTools(api, memory(entries), { enabled: true, maxPerRead: 20 });
  const result = await tools.read({ forward_id: 'fwd_1_0', start: 1, end: 1 }, context, tools.createTurn());
  assert.equal(result.status, 'ok');
  const row=(result.messages as any[])[0]!;assert.equal(row.text,undefined);
  assert.deepEqual(row.segments,[{type:'face',id:'20',name:'偷笑'},{type:'face',id:'375',name:'超级鼓掌'},{type:'unsupported',kind:'face'}]);
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.deepEqual(calls, ['get_msg']);
});
