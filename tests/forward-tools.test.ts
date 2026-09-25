import test from 'node:test';
import assert from 'node:assert/strict';
import { ForwardTools, READ_FORWARD_TOOL, type ForwardConfig } from '../src/forward-tools.js';
import { extractForward, forwardMarker, forwardReferences, sanitizeForwardReferences } from '../src/forward-references.js';
import { LISTENER_GROUP, type Api, type Memory, type TimelineEntry, type TurnContext } from '../src/contracts.js';

const ctx: TurnContext = { groupId: LISTENER_GROUP, actorId: '123', messageId: '1', selfId: '999' };
const native = (id = 'opaque+/=secret', content?: unknown[]) => ({ type: 'forward', data: { id, ...(content ? { content } : {}) } });
const card = (extra: unknown = { tsum: 99 }, detail = { resid: 'card-resource' }) => ({ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail }, extra }) } });
const text = (s: string) => ({ type: 'text', data: { text: s } });
const node = (message: unknown[] = [text('hello')]) => ({ sender: { user_id: '100000001', nickname: 'claimed owner' }, time: 42, message });
const local = (): TimelineEntry => ({ messageId: '1', userId: '123', nickname: 'local', time: 1, text: '[非文本消息]', ...{ forwards: forwardReferences('1', [native()]) } });
const remote = (segment: unknown = native(), extra = {}) => ({ message_type: 'group', group_id: LISTENER_GROUP, message_id: '1', sender: { user_id: '123' }, message: [segment], ...extra });
function setup({ origin = remote(), response = { messages: [node()] }, entries = [local()], options = { enabled: true, maxPerRead: 20 }, onCall }: { origin?: unknown; response?: unknown; entries?: TimelineEntry[]; options?: ForwardConfig; onCall?: (action: string, params: unknown) => unknown } = {}) {
  const calls: Array<{ action: string; params: unknown }> = [];
  const api: Api = { async call(action, params) { calls.push({ action, params }); return onCall ? onCall(action, params) : action === 'get_msg' ? origin : response; } };
  const memory: Memory = { recent: () => entries, find() { throw new Error('recent only'); }, append: () => true, context: () => '', compact: async () => {}, clear: () => { entries.length = 0; }, close() {} };
  const tools = new ForwardTools(api, memory, options), state = tools.createTurn();
  return { tools, state, calls, memory, read: (start = 1, end = start, id = 'fwd_1_0', signal?: AbortSignal) => tools.read({ forward_id: id, start, end }, ctx, state, signal) };
}
const rows = (r: Record<string, unknown>) => r.messages as Array<Record<string, any>>;

test('references preserve indices, bounded counts and no resource IDs; card hints only tsum', () => {
  const refs = forwardReferences('-123', [text('x'), native(), card(), native('id', []), native()]);
  assert.deepEqual(refs, [{ id: 'fwd_-123_1', index: 1 }, { id: 'fwd_-123_2', index: 2, count: 99, countSource: 'hint' }, { id: 'fwd_-123_3', index: 3, count: 0, countSource: 'verified' }]);
  assert.match(forwardMarker(refs[0]!), /条数未知/); assert.match(forwardMarker(refs[1]!), /未核实/); assert.match(forwardMarker(refs[2]!), /0条.*已核实/);
  assert.equal(JSON.stringify(refs).includes('secret'), false);
  assert.deepEqual(forwardReferences('1\n', [native()]), []);
  assert.deepEqual(forwardReferences('1', [...Array(128).fill(null), native()]), []);
  for (const value of [0, -1, 1001, '9', 1.2]) assert.equal(extractForward(card({ tsum: value }))?.count, undefined);
  assert.equal(extractForward(card(JSON.stringify({ tsum: 4 })))?.count, 4);
  assert.equal(extractForward(card({ summary: ['a', 'b'], news: [{}, {}] }))?.count, undefined);
  assert.equal(extractForward(native('00000012345678901234567890'))?.resourceId, '00000012345678901234567890');
  for (const id of ['', ' ', 'x\n', 'x'.repeat(513)]) { assert.equal(extractForward(native(id)), undefined); assert.equal(extractForward(card({}, { resid: id })), undefined); }
  assert.equal(extractForward({ type: 'json', data: { data: { app: 'other', meta: { detail: { resid: 'x' } } } } }), undefined);
});

test('persisted reference sanitizer strips secrets and invalid counts, enforces exact indices', () => {
  assert.deepEqual(sanitizeForwardReferences('1', [
    { id: 'fwd_1_0', index: 0, count: 0, countSource: 'hint', resourceId: 'secret' },
    { id: 'fwd_1_0', index: 0 }, { id: 'fwd_1_1', index: 1, count: 0, countSource: 'verified', url: 'secret' },
    { id: 'fwd_2_2', index: 2 }, { id: 'fwd_1_2', index: 2, count: 1001, countSource: 'verified' }, { id: 'fwd_1_3', index: 3 },
  ]), [{ id: 'fwd_1_0', index: 0 }, { id: 'fwd_1_1', index: 1, count: 0, countSource: 'verified' }, { id: 'fwd_1_2', index: 2 }]);
  assert.deepEqual(sanitizeForwardReferences('1\n', [{ id: 'fwd_1_0', index: 0 }]), []);
});

test('inline ancestor identity blocks a resource-only child cycle without fetching ancestor',async()=>{
 const id='9876543210123456789';const s=setup({origin:remote(native(id,[node([native(id)])]))});
 const result=await s.read();assert.equal(result.status,'ok');assert.match(rows(result)[0]!.text,/循环引用/);
 assert.equal(rows(result)[0]!.forwards,undefined);assert.equal(s.state.children.size,0);assert.deepEqual(s.calls.map(x=>x.action),['get_msg']);
});
test('serialized CQ compatibility strings never expose transport URLs or file identifiers',async()=>{
 for(const field of ['message','content']){
  const s=setup({response:{messages:[{[field]:'before [CQ:image,url=https://secret.invalid/token,file=SECRET_FILE] after'}]}});
  const result=await s.read();assert.equal(result.truncated,true);assert.deepEqual(result.partial_message_indices,[1]);
  assert.match(rows(result)[0]!.text,/无法安全展开/);assert.ok(!JSON.stringify(result).includes('secret.invalid'));assert.ok(!JSON.stringify(result).includes('SECRET_FILE'));
 }
});

test('strict exact argument schema, invalid ranges never fetch', async () => {
  assert.equal(READ_FORWARD_TOOL.function.name, 'read_forward');
  assert.equal(READ_FORWARD_TOOL.function.parameters.additionalProperties, false);
  assert.deepEqual(READ_FORWARD_TOOL.function.parameters.required, ['forward_id', 'start', 'end']);
  const s = setup();
  for (const args of [null, [], {}, { forward_id: 'fwd_1_0', start: 1, end: 1, extra: true }, ...['secret', 'fwd_1_128', 'fwd_1_00', 'fwd_1_0\n', 'fwdn_000'].map(forward_id => ({ forward_id, start: 1, end: 1 })), ...[[0, 1], [2, 1], [1, 21], [1.5, 2], [1, Infinity], ['1', 2]].map(([start, end]) => ({ forward_id: 'fwd_1_0', start, end }))]) assert.equal((await s.tools.read(args, ctx, s.state)).status, 'error');
  assert.equal(s.calls.length, 0);
});

test('options immutable, disabled and forbidden group do nothing', async () => {
  for (const maxPerRead of [0, 21, 1.2, NaN]) assert.throws(() => setup({ options: { enabled: true, maxPerRead } }));
  const options = { enabled: false, maxPerRead: 20 }, s = setup({ options }); options.enabled = true;
  assert.equal((await s.read()).error, 'tool_disabled'); assert.equal(s.calls.length, 0); assert.equal(s.state.roots.size, 0);
  const t = setup(); assert.equal((await t.tools.read({ forward_id: 'fwd_1_0', start: 1, end: 1 }, { ...ctx, groupId: '9' }, t.state)).error, 'forbidden_group'); assert.equal(t.calls.length, 0);
  const defaults = setup({ options: { enabled: true } as ForwardConfig }); assert.equal((await defaults.read()).status, 'ok');
});

test('only local validated refs, legacy placeholder, or direct reply target authorize origins', async () => {
  for (const entries of [[], [{ ...local(), ...{ forwards: [] } }], [{ ...local(), ...{ forwards: undefined }, text: 'hello' }], [{ ...local(), userId: '0' }]]) {
    const s = setup({ entries }); assert.equal((await s.read()).error, 'forbidden_reference'); assert.equal(s.calls.length, 0);
  }
  const legacy = setup({ entries: [{ ...local(), ...{ forwards: undefined } }] }); assert.equal((await legacy.read()).status, 'ok');
  const reply = setup({ entries: [{ ...local(), messageId: '2', replyTo: '1' }] }); assert.equal((await reply.read()).status, 'ok');
  const forged = setup(); assert.equal((await forged.read(1, 1, 'fwd_1_1')).error, 'forbidden_reference'); assert.equal(forged.calls.length, 0);
});

test('get_msg verifies group, identity and real selected segment before resource retrieval', async () => {
  for (const extra of [{ message_type: 'private' }, { group_id: '9' }, { message_id: '2' }, { sender: { user_id: '456' } }, { sender: { user_id: '0' } }, { user_id: '456' }, { message: [text('not forward')] }]) {
    const s = setup({ origin: remote(native(), extra) }); assert.equal((await s.read()).status, 'error'); assert.equal(s.calls.length, 1); assert.equal(s.state.roots.size, 0);
  }
  const s = setup(); const r = await s.read(); assert.equal(r.status, 'ok');
  assert.deepEqual(s.calls, [{ action: 'get_msg', params: { message_id: '1' } }, { action: 'get_forward_msg', params: { message_id: 'opaque+/=secret' } }]);
  assert.deepEqual(rows(r)[0]!.claimed_sender, { user_id: '100000001', nickname: 'claimed owner' });
  assert.equal(r.untrusted, true); assert.equal(JSON.stringify(r).includes('secret'), false);
});

test('native inline expanded content is preferred to uncallable native internal id', async () => {
  const s = setup({ origin: remote(native('12345678901234567890', [node([text('inline')])])) });
  const r = await s.read(); assert.equal(rows(r)[0]!.text, 'inline'); assert.equal(s.calls.length, 1);
  assert.equal(JSON.stringify(r).includes('12345678901234567890'), false);
});

test('true total overrides card hint; clipping, empty and out of bounds report honest pagination', async () => {
  const s = setup({ origin: remote(card()), response: { messages: [node(), node()] } });
  const r = await s.read(1, 20); assert.equal(r.total, 2); assert.equal(r.requested_end, 20); assert.equal(r.returned_end, 2); assert.equal(r.truncated, true); assert.equal(r.has_more, false); assert.equal(r.next_start, null);
  const bad = await s.read(3, 4); assert.equal(bad.error, 'range_out_of_bounds'); assert.equal(bad.total, 2); assert.equal(s.calls.length, 2);
  const empty = setup({ response: { messages: [] } }); const e = await empty.read(); assert.equal(e.status, 'ok'); assert.equal(e.total, 0); assert.deepEqual(e.messages, []); assert.equal(e.returned_start, null); assert.equal(e.has_more, false);
});

test('99 short nodes fully paginated in five calls, sixth allowed then turn call budget', async () => {
  const s = setup({ response: { messages: Array.from({ length: 99 }, (_, i) => node([text(`node ${i + 1}`)])) } });
  const indices: number[] = [];
  for (let start = 1; start <= 99; start += 20) { const r = await s.read(start, start + 19); assert.equal(r.status, 'ok'); indices.push(...rows(r).map(n => n.index)); assert.equal(r.has_more, start < 81); }
  assert.deepEqual(indices, Array.from({ length: 99 }, (_, i) => i + 1)); assert.equal(s.state.returned, 99); assert.equal(s.calls.length, 2);
  assert.equal((await s.read(1, 20)).status, 'ok'); assert.equal((await s.read()).error, 'budget_exhausted');
  assert.equal(s.state.returned, 119); assert.ok(s.state.outputChars <= 30000);
});

test('only selected and actually returned nodes register opaque nested refs; repeats reuse refs/cache', async () => {
  const s = setup({ response: { messages: [node([native('nested1')]), node([native('nested2')])] } });
  const r = await s.read(); assert.equal(s.state.children.size, 1);
  const child = rows(r)[0]!.forwards[0].id; assert.match(child, /^fwdn_[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(r).includes('nested1'), false);
  const repeat = await s.read(); assert.equal(rows(repeat)[0]!.forwards[0].id, child); assert.equal(s.calls.length, 2);
  assert.equal((await s.read(1, 1, 'fwdn_0000000000000000')).error, 'forbidden_reference');
  await s.read(2, 2); assert.equal(s.state.children.size, 2);
});

test('nested native inline preserves verified child count; depth three prevents further registration', async () => {
  const leaf = node([native('internal', [node()])]);
  const middle = node([native('internal', [leaf])]);
  const s = setup({ origin: remote(native('internal', [node([native('internal', [middle])])])) });
  const r1 = await s.read(), ref1 = rows(r1)[0]!.forwards[0]; assert.equal(ref1.count, 1); assert.equal(ref1.countSource, 'verified');
  const r2 = await s.read(1, 1, ref1.id), ref2 = rows(r2)[0]!.forwards[0];
  const r3 = await s.read(1, 1, ref2.id); assert.match(rows(r3)[0]!.text, /深度上限/); assert.equal(rows(r3)[0]!.forwards, undefined); assert.equal(s.state.children.size, 2); assert.equal(s.calls.length, 1);
});

test('ancestor resource cycles unavailable without registration or autoexpansion', async () => {
  const s = setup({ response: { messages: [node([native('opaque+/=secret')])] } });
  const r = await s.read(); assert.match(rows(r)[0]!.text, /循环引用/); assert.equal(s.state.children.size, 0); assert.equal(s.calls.length, 2);
  const t = setup({ onCall: (action, params) => action === 'get_msg' ? remote(native('a')) : (params as any).message_id === 'a' ? { messages: [node([native('b')])] } : { messages: [node([native('a')])] } });
  const first = await t.read(), second = await t.read(1, 1, rows(first)[0]!.forwards[0].id); assert.match(rows(second)[0]!.text, /循环引用/); assert.equal(t.calls.length, 3);
});

test('resource limits reject cycles, depth, oversized strings, excessive nodes and traversal budget safely', async () => {
  const cyclic: any = { messages: [] }; cyclic.messages.push(cyclic);
  let deep: any = {}; for (let i = 0; i < 40; i++) deep = { deep };
  for (const response of [cyclic, { messages: [node([text('x'.repeat(1048577))])] }, { messages: Array(1001).fill(null) }, { messages: [deep] }, { messages: Array.from({ length: 900 }, () => node()) }]) {
    const s = setup({ response }); const r = await s.read(); assert.equal(r.status, 'error'); assert.equal(s.state.cache.size, 0); assert.equal(s.state.children.size, 0); assert.ok(JSON.stringify(r).length < 150);
  }
  const inline: unknown[] = []; inline.push(node([native('x', inline)])); const s = setup({ origin: remote(native('x', inline)) }); assert.equal((await s.read()).error, 'invalid_resource'); assert.equal(s.calls.length, 1);
});

test('whole JSON bounds include overhead, large text truncates honestly and cursor advances', async () => {
  const s = setup({ response: { messages: [node([text('"\\\n'.repeat(30000)), native('not-shown')]), node([text('after')])] } });
  const r = await s.read(1, 2); assert.ok(JSON.stringify(r).length <= 12000); assert.equal(r.truncated, true); assert.deepEqual(r.partial_message_indices, [1]); assert.match(rows(r)[0]!.text, /内容已截断/); assert.equal(r.returned_end, 1); assert.equal(r.next_start, 2); assert.equal(s.state.children.size, 0);
  const next = await s.read(2, 2); assert.equal(rows(next)[0]!.text, 'after'); assert.equal(next.has_more, false);
});

test('per-turn 30000 character bound remains strict across long repeated reads', async () => {
  const s = setup({ response: { messages: [node([text('x'.repeat(20000))])] } });
  let chars = 0;
  for (let i = 0; i < 6; i++) { const r = await s.read(); if (r.status === 'ok') { assert.ok(JSON.stringify(r).length <= 12000); chars += JSON.stringify(r).length; } }
  assert.ok(chars <= 30000); assert.equal(chars, s.state.outputChars); assert.equal(s.calls.length, 2);
});

test('all nontext payloads remain opaque, no image ids or JSON card leaks, literal user URLs preserved', async () => {
  const secret = 'HIDDEN_SECRET_RESOURCE_ID';
  const s = setup({ response: { messages: [node([{ type: 'image', data: { url: `https://x/${secret}`, file: secret } }, { type: 'at', data: { qq: secret } }, { type: 'json', data: { data: secret } }, { type: 'video', data: { url: secret } }, card({ tsum: 1 }, { resid: secret }), text('quoted https://example.com/visible')])] } });
  const r = await s.read(), output = JSON.stringify(r); assert.equal(output.includes(secret), false); assert.equal(output.includes('img_'), false); assert.match(rows(r)[0]!.text, /图片：转发内图片本版不支持查看/); assert.match(output, /https:\/\/example.com\/visible/);
});

test('abort before or during any await commits no newly cached content or children', async () => {
  for (const abortAction of ['before', 'get_msg', 'get_forward_msg']) {
    const controller = new AbortController();
    const s = setup({ onCall(action) { if (action === abortAction) controller.abort(); return action === 'get_msg' ? remote() : { messages: [node([native('child')])] }; } });
    if (abortAction === 'before') controller.abort();
    assert.equal((await s.read(1, 1, 'fwd_1_0', controller.signal)).error, 'cancelled'); assert.equal(s.state.cache.size, 0); assert.equal(s.state.roots.size, 0); assert.equal(s.state.children.size, 0); assert.equal(s.state.cachedBytes, 0);
  }
});

test('reset revokes cached roots and child refs, including while API awaits', async () => {
  const s = setup({ response: { messages: [node([native('nested')])] } });
  const r = await s.read(), child = rows(r)[0]!.forwards[0].id; s.memory.clear();
  assert.equal((await s.read()).error, 'forbidden_reference'); assert.equal((await s.read(1, 1, child)).error, 'forbidden_reference'); assert.equal(s.calls.length, 2);
  const entries = [local()]; const t = setup({ entries, onCall(action) { if (action === 'get_forward_msg') entries.length = 0; return action === 'get_msg' ? remote() : { messages: [node([native('nested')])] }; } });
  assert.equal((await t.read()).error, 'forbidden_reference'); assert.equal(t.state.children.size, 0); assert.equal(t.state.roots.size, 0);
});

test('turn cache serialized budget is two MiB, failed loads do not commit', async () => {
  const segments = [native('a'), native('b'), native('c')];
  const s = setup({ origin: { ...remote(), message: segments }, entries: [{ ...local(), ...{ forwards: forwardReferences('1', segments) } }], response: { messages: [node([text('x'.repeat(750000))])] } });
  assert.equal((await s.read(1, 1, 'fwd_1_0')).status, 'ok');
  assert.equal((await s.read(1, 1, 'fwd_1_1')).status, 'ok');
  assert.equal((await s.read(1, 1, 'fwd_1_2')).error, 'cache_limit');
  assert.ok(s.state.cachedBytes < 2097152); assert.equal(s.state.roots.size, 2); assert.equal(s.state.cache.size, 2);
});

test('node wrappers and content strings are compatible, unknown nodes explicitly partial', async () => {
  const s = setup({ response: { messages: [{ type: 'node', data: { name: 'someone', uin: '123', content: 'compatibility text' } }, {}, { content: [text('content array')] }] } });
  const r = await s.read(1, 3); assert.equal(rows(r)[0]!.text, 'compatibility text'); assert.equal(rows(r)[0]!.claimed_sender.user_id, '123');
  assert.match(rows(r)[1]!.text, /无法解析的转发消息/); assert.deepEqual(r.partial_message_indices, [2]); assert.equal(rows(r)[2]!.text, 'content array');
  assert.throws(() => setup({ options: { enabled: true, maxPerRead: undefined } as any }));
  assert.throws(() => setup({ options: Object.assign(Object.create({}), { enabled: true, maxPerRead: 20 }) }));
});

test('nested hint becomes verified after explicit child read, never autoexpanded', async () => {
  const s = setup({ onCall: (action, params) => action === 'get_msg' ? remote() : (params as any).message_id === 'opaque+/=secret' ? { messages: [node([card({ tsum: 99 })])] } : { messages: [node(), node()] } });
  const first = await s.read(), ref = rows(first)[0]!.forwards[0]; assert.equal(ref.count, 99); assert.equal(ref.countSource, 'hint'); assert.equal(s.calls.length, 2); assert.match(rows(first)[0]!.text, /合并转发 fwdn_/);
  const second = await s.read(1, 20, ref.id); assert.equal(second.total, 2);
  const again = await s.read(); assert.equal(rows(again)[0]!.forwards[0].count, 2); assert.equal(rows(again)[0]!.forwards[0].countSource, 'verified'); assert.equal(s.calls.length, 3);
});

test('cancelled child load preserves previous refs but commits no new refs or resource', async () => {
  const controller = new AbortController();
  const s = setup({ onCall: (action, params) => {
    if (action === 'get_msg') return remote();
    if ((params as any).message_id === 'opaque+/=secret') return { messages: [node([native('child')])] };
    controller.abort(); return { messages: [node([native('grandchild')])] };
  } });
  const first = await s.read(), child = rows(first)[0]!.forwards[0].id, bytes = s.state.cachedBytes;
  assert.equal((await s.read(1, 1, child, controller.signal)).error, 'cancelled'); assert.equal(s.state.children.size, 1); assert.equal(s.state.cache.size, 1); assert.equal(s.state.cachedBytes, bytes);
});

test('API exceptions are static failures without body/token leakage', async () => {
  const s = setup({ onCall() { throw new Error('secret body token https://secret'); } });
  assert.deepEqual(await s.read(), { status: 'error', error: 'forward_unavailable' });
});
