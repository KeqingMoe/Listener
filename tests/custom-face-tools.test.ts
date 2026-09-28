import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { CustomFaceTools, CUSTOM_FACE_TOOL_NAMES, buildCustomFaceToolDefinitions, type CustomFaceOptions } from '../src/tools/custom-faces/tools.js';
import { CustomFaceStore } from '../src/tools/custom-faces/store.js';
import { CustomFaceCoordinator } from '../src/tools/custom-faces/coordinator.js';
import { validateOriginalImage } from '../src/tools/images/download.js';
import { OneBotError } from '../src/onebot/client.js';
import { DuplicateMessageAckError, UnverifiedMessageAckError } from '../src/onebot/operation-result.js';
import type { Api, ChatContentPart, JsonObject, Memory, TimelineEntry, TurnContext } from '../src/contracts/index.js';

const GROUP = '100000002', SELF = '123456789', USER = '100000001';
const CTX: TurnContext = { groupId: GROUP, selfId: SELF, actorId: USER, messageId: '11' };
const PNG = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
const frames = Buffer.concat([Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]), Buffer.from([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255])]);
const GIF = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
const BLUE_PNG = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0000ff' } }).png().toBuffer();
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceEntry = (): TimelineEntry => ({ messageId: '11', userId: USER, nickname: '', text: '', time: 1, images: [{ id: 'img_11_0', index: 0 }], segments: [{ type: 'image', image_id: 'img_11_0', content_status: 'not_viewed' }] });
function favorite(bytes = PNG, extra: JsonObject = {}): JsonObject { return { resId: 'NATIVE_SECRET_RESOURCE', emoId: 0, md5: md5(bytes), desc: '白猫无语', url: 'https://p.qpic.cn/qq_expression/1/NATIVE_SECRET_RESOURCE/0', eId: 'DO_NOT_USE_MARKET_ID', epId: 9999, emoPath: '/private/native/face.gif', ...extra }; }
function wire(bytes = PNG): JsonObject { return { message_id: '11', message_type: 'group', group_id: GROUP, sender: { user_id: USER }, user_id: USER, message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/source?rkey=SECRET', file: `${md5(bytes)}.png` } }] }; }
type Hook = (params: JsonObject | undefined) => unknown | Promise<unknown>;
function fixture(options: { bytes?: Buffer; rows?: JsonObject[]; enabled?: readonly string[]; hooks?: Record<string, Hook>; extras?: Partial<CustomFaceOptions>; entries?: TimelineEntry[]; store?: CustomFaceStore; coordinator?: CustomFaceCoordinator } = {}) {
  const bytes = options.bytes ?? PNG;
  let rows = options.rows ?? [favorite(bytes)], entries = options.entries ?? [sourceEntry()], nextId = 900;
  const store = options.store ?? new CustomFaceStore(), coordinator = options.coordinator ?? new CustomFaceCoordinator();
  const calls: { action: string; params?: JsonObject }[] = [], visuals: ChatContentPart[] = [], sent: TimelineEntry[] = [];
  let downloads = 0, stages = 0;
  const memory: Memory = { append: e => { entries.push(e); return true; }, recent: () => entries, find: id => entries.find(e => e.messageId === id), context: () => '', compact: async () => {}, clear: () => { entries = []; }, close: () => {} };
  const hooks = options.hooks ?? {};
  const api: Api = { async call(action, params) {
    calls.push({ action, ...(params ? { params } : {}) });
    if (hooks[action]) return hooks[action]!(params);
    switch (action) {
      case 'get_login_info': return { user_id: SELF };
      case 'fetch_custom_face_detail': return structuredClone(rows);
      case 'get_msg': return wire(bytes);
      case 'send_group_msg': return { message_id: nextId++ };
      case 'add_custom_face': rows.push(favorite(bytes, { resId: 'CREATED_NATIVE_RESOURCE', emoId: 42, desc: '' })); return undefined;
      case 'set_custom_face_desc': { const row = rows.find(r => r.resId === params?.res_id && r.emoId === params?.emoji_id && r.md5 === params?.md5); if (row) row.desc = params!.desc; return null; }
      case 'delete_custom_face': rows = rows.filter(r => r.resId !== params?.res_id); return null;
      default: throw new Error(`unexpected ${action}`);
    }
  } };
  const config: CustomFaceOptions = {
    store, coordinator,
    originalDownloader: async () => { downloads++; return validateOriginalImage(bytes); },
    staging: { stage: async (data, format) => { stages++; assert.deepEqual(data, bytes); return { providerPath: `/container/shared/opaque.${format}`, digest: hash(data) }; } },
    onVisualContent: parts => visuals.push(...parts),
    onSent: entry => { sent.push(entry); },
    ...options.extras,
  };
  const tools = new CustomFaceTools(api, GROUP, options.enabled ?? CUSTOM_FACE_TOOL_NAMES, memory, config);
  const execute = (name: string, args: JsonObject = {}, ctx = CTX, signal?: AbortSignal) => tools.execute(name, args, ctx, signal);
  return { api, tools, execute, store, coordinator, memory, calls, visuals, sent, hooks, config, get downloads() { return downloads; }, get stages() { return stages; }, get rows() { return rows; }, set rows(value: JsonObject[]) { rows = value; }, close() { if (!options.store) store.close(); if (!options.coordinator) coordinator.close(); } };
}
async function firstRef(f: ReturnType<typeof fixture>): Promise<string> {
  const result = await f.execute('list_custom_faces');
  assert.equal(result.status, 'ok');
  return ((result.items as JsonObject[])[0]!).face_ref as string;
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(c => ['send_group_msg', 'add_custom_face', 'delete_custom_face', 'set_custom_face_desc'].includes(c.action));

test('schemas are independent, fail closed by default, and do not expose native IDs or paths', () => {
  assert.deepEqual(buildCustomFaceToolDefinitions(), []);
  const defs = buildCustomFaceToolDefinitions(CUSTOM_FACE_TOOL_NAMES);
  assert.equal(defs.length, 6);
  (defs[0]!.function.parameters as JsonObject).evil = true;
  assert.equal(buildCustomFaceToolDefinitions(CUSTOM_FACE_TOOL_NAMES)[0]!.function.parameters.evil, undefined);
  assert.throws(() => buildCustomFaceToolDefinitions(['not_a_tool']));
  for (const d of defs) for (const key of Object.keys(d.function.parameters.properties as JsonObject)) assert.ok(!['url', 'file', 'md5', 'res_id', 'emoji_id', 'package_id'].includes(key));
});

test('directory accepts explicit emoId zero, searches descriptions/tags and returns opaque references only', async t => {
  const f = fixture(); t.after(() => f.close());
  const ref = await firstRef(f);
  assert.equal(f.store.resolve(ref, SELF, GROUP)?.emoId, 0);
  const json = JSON.stringify(await f.execute('list_custom_faces', { query: '白猫', limit: 1 }));
  for (const secret of ['NATIVE_SECRET_RESOURCE', md5(PNG), '/private/native', 'p.qpic.cn', 'DO_NOT_USE_MARKET_ID']) assert.ok(!json.includes(secret), secret);
  assert.equal((await f.execute('list_custom_faces', { query: 'missing' })).returned_count, 0);
  const row = f.store.resolve(ref, SELF, GROUP)!;
  f.store.setLocalTags(SELF, row.resId, ['嫌弃'], row.revision);
  assert.equal((await f.execute('list_custom_faces', { query: '嫌弃' })).returned_count, 1);
  assert.equal(f.calls.find(c => c.action === 'fetch_custom_face_detail')?.params?.count, 512);
  assert.equal(writes(f).length, 0);
});

test('empty or short native prefixes never claim completeness or clear older index records', async t => {
  const f = fixture(); t.after(() => f.close());
  const ref = await firstRef(f); f.rows = [];
  const result = await f.execute('list_custom_faces');
  assert.equal(result.directory_complete, false);
  assert.equal(result.observed_in_current_read, 0);
  assert.equal(result.returned_count, 1);
  for (const key of ['cursor', 'total', 'hasMore', 'has_more', 'next_cursor']) assert.equal(result[key], undefined);
  assert.ok(f.store.resolve(ref, SELF, GROUP));
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).error, 'resource_not_verified');
  assert.equal(writes(f).length, 0);
});

test('missing/null/empty/noninteger emoId cannot alias native collection zero or marketplace IDs', async t => {
  for (const value of [undefined, null, '', -1, 1.2, NaN, '0.0']) {
    await t.test(String(value), async () => { const f = fixture({ rows: [favorite(PNG, { emoId: value, eId: 0 })] }); try { assert.equal((await f.execute('list_custom_faces')).status, 'error'); } finally { f.close(); } });
  }
});

test('strict arguments reject getters, proxies, inherited fields, unknown fields and malformed arrays without native calls', async t => {
  const f = fixture(); t.after(() => f.close());
  let touches = 0;
  const getter = Object.defineProperty({}, 'face_ref', { enumerable: true, get() { touches++; return 'x'; } });
  const proxy = new Proxy({}, { getPrototypeOf() { touches++; return Object.prototype; } });
  const cases = [getter, proxy, Object.create({ face_ref: 'x' }), { face_ref: 'x', url: 'https://evil' }, { face_ref: undefined }, { face_ref: 1 }];
  for (const arg of cases) assert.equal((await f.tools.execute('send_custom_face', arg, CTX)).status, 'error');
  assert.equal(touches, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.execute('add_custom_face', { image_id: 'img_11_0', description: ' ', tags: [] })).error, 'invalid_arguments');
});

test('disabled tools, cross-group context and changed login fail before resource access', async t => {
  const disabled = fixture({ enabled: [] }); t.after(() => disabled.close());
  assert.equal((await disabled.execute('list_custom_faces')).error, 'tool_disabled'); assert.equal(disabled.calls.length, 0);
  const f = fixture(); t.after(() => f.close());
  assert.equal((await f.execute('list_custom_faces', {}, { ...CTX, groupId: '200000002' })).error, 'forbidden_group');
  f.hooks.get_login_info = () => ({ user_id: '200000001' });
  assert.equal((await f.execute('list_custom_faces')).error, 'identity_unverified');
  assert.deepEqual(f.calls.map(c => c.action), ['get_login_info']);
});

test('group-bound refs cannot be borrowed, and changed resId/md5/emoId/descriptions are not silently rebound', async t => {
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  assert.equal(f.store.resolve(ref, SELF, '200000002'), undefined);
  for (const patch of [{ resId: 'OTHER' }, { md5: '1'.repeat(32) }, { emoId: 1 }, { desc: 'renamed' }]) {
    f.rows = [favorite(PNG, patch)];
    assert.equal((await f.execute('send_custom_face', { face_ref: ref })).error, 'resource_not_verified');
  }
  assert.equal(writes(f).length, 0);
});

test('view gives actual JPEG visual attachments separately, marks GIF first-frame-only, and spends shared budget', async t => {
  const budget = { attemptedIds: new Set(['img_7_0', 'img_8_0']), loadedIds: new Set<string>() };
  const f = fixture({ bytes: GIF, extras: { imageBudget: budget } }); t.after(() => f.close());
  const ref = await firstRef(f), result = await f.execute('view_custom_face', { face_ref: ref });
  assert.equal(result.status, 'ok'); assert.equal(result.first_frame_only, true);
  assert.equal(budget.attemptedIds.size, 3); assert.ok(budget.loadedIds.has(ref));
  assert.equal(f.visuals.length, 2); assert.equal(f.visuals[1]?.type, 'image_url');
  assert.match(JSON.stringify(f.visuals[1]), /data:image\/jpeg;base64/);
  assert.ok(!JSON.stringify(result).includes('base64'));
  await f.execute('view_custom_face', { face_ref: ref }); assert.equal(f.visuals.length, 2);
  const second = favorite(GIF, { resId: 'OTHER_RES', emoId: 1 }); f.rows.push(second);
  const list = await f.execute('list_custom_faces'); const other = (list.items as JsonObject[]).find(i => i.face_ref !== ref)!.face_ref;
  assert.equal((await f.execute('view_custom_face', { face_ref: other })).error, 'image_budget_exhausted');
});

test('single-frame GIF reports the actual shared preview first-frame policy, separately from animation', async t => {
  const single = await sharp(PNG).gif().toBuffer();
  const f = fixture({ bytes: single }); t.after(() => f.close()); const ref = await firstRef(f);
  const result = await f.execute('view_custom_face', { face_ref: ref });
  assert.equal(result.status, 'ok'); assert.equal(result.animated, false); assert.equal(result.first_frame_only, true);
  assert.ok(JSON.stringify(f.visuals[0]).includes('first_frame_only'));
  const text = (f.visuals[0] as { type: 'text'; text: string }).text;
  assert.match(text, /"first_frame_only":true/); assert.match(text, /"animated":false/);
});

test('failed/incorrect original image consumes one view attempt and never produces visual content', async t => {
  const f = fixture({ rows: [favorite(PNG, { md5: 'f'.repeat(32) })] }); t.after(() => f.close());
  const ref = await firstRef(f);
  assert.equal((await f.execute('view_custom_face', { face_ref: ref })).error, 'image_identity_mismatch');
  assert.equal((await f.execute('view_custom_face', { face_ref: ref })).error, 'image_unavailable');
  assert.equal(f.visuals.length, 0); assert.equal(f.downloads, 1);
});

test('GIF sends original bytes, not preview JPEG, and normal explicit repeated calls send again', async t => {
  const f = fixture({ bytes: GIF }); t.after(() => f.close()); const ref = await firstRef(f);
  for (let n = 0; n < 2; n++) assert.equal((await f.execute('send_custom_face', { face_ref: ref })).status, 'executed');
  const sends = writes(f); assert.equal(sends.length, 2); assert.equal(f.sent.length, 2);
  for (const call of sends) {
    assert.equal(call.action, 'send_group_msg');
    const file = (((call.params!.message as JsonObject[])[0]!.data as JsonObject).file as string);
    assert.deepEqual(Buffer.from(file.slice('base64://'.length), 'base64'), GIF);
  }
  assert.notEqual(f.sent[0]!.messageId, f.sent[1]!.messageId);
});

test('cancellation after valid ACK still records it; no old memory is restored', async t => {
  const abort = new AbortController();
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  f.hooks.send_group_msg = () => { f.memory.clear(); abort.abort(); return { message_id: '1200' }; };
  const result = await f.execute('send_custom_face', { face_ref: ref }, CTX, abort.signal);
  assert.equal(result.status, 'executed'); assert.equal(result.message_id, '1200'); assert.equal(result.cancelled_after_dispatch, true);
  assert.equal(f.sent.length, 1); assert.equal(f.memory.recent().length, 0);
});

test('unknown send is blocked across a new wake/module and reset, not merely a per-call cache', async t => {
  const store = new CustomFaceStore(), coordinator = new CustomFaceCoordinator(); t.after(() => { store.close(); coordinator.close(); });
  const f = fixture({ store, coordinator }); const ref = await firstRef(f);
  f.hooks.send_group_msg = () => { throw new OneBotError('api_failed', 1200); };
  const unknown = await f.execute('send_custom_face', { face_ref: ref }); assert.equal(unknown.status, 'unknown');
  f.memory.clear();
  const second = fixture({ store, coordinator }); const result = await second.execute('send_custom_face', { face_ref: ref });
  assert.equal(result.error, 'previous_operation_unresolved'); assert.equal(writes(second).length, 0);
});

test('duplicate ACK differs from local projection error and preserves uncertainty', async t => {
  const f = fixture({ extras: { onSent() { throw new DuplicateMessageAckError(); } } }); t.after(() => f.close()); const ref = await firstRef(f);
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).error, 'duplicate_message_ack');
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).error, 'previous_operation_unresolved');
  const g = fixture({ extras: { onSent() { throw new Error('private exception'); } } }); t.after(() => g.close()); const r = await firstRef(g);
  const result = await g.execute('send_custom_face', { face_ref: r }); assert.equal(result.status, 'executed'); assert.equal(result.local_projection_failed, true);
  assert.ok(!JSON.stringify(result).includes('private exception'));
});

test('unverified historical ACK remains durably unknown, unlike post-claim projection failure', async t => {
  const f = fixture({ extras: { onSent() { throw new UnverifiedMessageAckError(); } } }); t.after(() => f.close()); const ref = await firstRef(f);
  const result = await f.execute('send_custom_face', { face_ref: ref });
  assert.equal(result.status, 'unknown'); assert.equal(result.error, 'message_ack_unverified'); assert.equal(result.message_id, null);
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).error, 'previous_operation_unresolved');
  assert.equal(writes(f).length, 1);
});

test('known rejection is not unknown and allows the next explicit send', async t => {
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  f.hooks.send_group_msg = () => { throw new OneBotError('api_failed', 1400); };
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).dispatched, false);
  delete f.hooks.send_group_msg;
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).status, 'executed');
});

test('add performs verified source → original staging → collection → unique binding → description using emoId (not eId)', async t => {
  const f = fixture({ rows: [] }); t.after(() => f.close());
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: '无语猫', tags: ['无语', '猫'] });
  assert.equal(result.status, 'ok'); assert.equal(result.collection_submitted, true); assert.equal(result.description_confirmed, true);
  const calls = writes(f); assert.deepEqual(calls.map(c => c.action), ['add_custom_face', 'set_custom_face_desc']);
  assert.equal(calls[0]!.params!.file, '/container/shared/opaque.png'); assert.equal(calls[0]!.params!.md5, md5(PNG));
  assert.equal(calls[1]!.params!.emoji_id, 42); assert.equal(calls[1]!.params!.res_id, 'CREATED_NATIVE_RESOURCE');
  assert.equal(f.stages, 1);
  const row = f.store.resolve(result.face_ref as string, SELF, GROUP)!;
  assert.equal(row.description, '无语猫'); assert.deepEqual(row.tags, ['无语', '猫']);
  for (const secret of ['/container/', md5(PNG), 'CREATED_NATIVE_RESOURCE', 'DO_NOT_USE_MARKET_ID']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('existing unique content avoids re-adding and uses valid native emoId zero for description', async t => {
  const f = fixture(); t.after(() => f.close());
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: '已有图新描述' });
  assert.equal(result.already_collected, true); assert.equal(result.collection_submitted, false);
  assert.equal(f.stages, 0); assert.deepEqual(writes(f).map(c => c.action), ['set_custom_face_desc']);
  assert.equal(writes(f)[0]!.params!.emoji_id, 0);
});

test('ambiguous same-MD5 collection is not guessed; unbound submitted add is durably guarded', async t => {
  const ambiguous = fixture({ rows: [favorite(), favorite(PNG, { resId: 'SECOND', emoId: 2 })] }); t.after(() => ambiguous.close());
  assert.equal((await ambiguous.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' })).error, 'ambiguous_content');
  assert.equal(writes(ambiguous).length, 0);
  const f = fixture({ rows: [], hooks: { add_custom_face: () => null } }); t.after(() => f.close());
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' });
  assert.equal(result.status, 'ok'); assert.equal(result.submitted, true); assert.equal(result.description_submitted, false);
  assert.equal(result.collection_binding_confirmed, false);
  assert.equal(result.reconcile_allowed, true);
  const again = await f.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' });
  assert.equal(again.error, 'collection_not_uniquely_verified'); assert.equal(again.previous_collection_submitted, true); assert.equal(again.new_add_dispatched, false); assert.equal(again.reconcile_allowed, true);
  assert.deepEqual(writes(f).map(c => c.action), ['add_custom_face']);
});

test('normal submitted add whose directory entry appears later reconciles by bytes without dispatching add again', async t => {
  const f = fixture({ rows: [], hooks: { add_custom_face: () => null } }); t.after(() => f.close());
  const first = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'first label' });
  assert.equal(first.reconcile_allowed, true); assert.equal(first.collection_binding_confirmed, false);
  f.rows = [favorite(PNG, { desc: '', resId: 'DELAYED_RESOURCE', emoId: 7 })];
  const next = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'current requested label', tags: ['late'] });
  assert.equal(next.reconciled_previous_add, true); assert.equal(next.new_add_dispatched, false); assert.equal(next.previous_collection_submitted, true);
  assert.equal(next.description_confirmed, true); assert.equal(next.collection_binding_confirmed, true);
  assert.equal(f.stages, 1); assert.deepEqual(writes(f).map(c => c.action), ['add_custom_face', 'set_custom_face_desc']);
  assert.equal(f.store.resolve(next.face_ref as string, SELF, GROUP)?.description, 'current requested label');
});

test('true unknown add is never reclassified as a normal hold merely because a matching image later exists', async t => {
  const f = fixture({ rows: [], hooks: { add_custom_face: () => { throw new OneBotError('api_failed', 1200); } } }); t.after(() => f.close());
  const first = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' }); assert.equal(first.status, 'unknown'); assert.equal(first.reconcile_allowed, false);
  f.rows = [favorite()];
  const next = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' });
  assert.equal(next.error, 'previous_operation_unresolved'); assert.equal(next.reconcile_allowed, false);
  assert.deepEqual(writes(f).map(c => c.action), ['add_custom_face']);
});

test('normal hold with mismatched original SHA proof cannot be reconciled using only a matching MD5 target', async t => {
  const f = fixture(); t.after(() => f.close());
  const proof = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const held = f.coordinator.begin(SELF, [proof(['content', md5(PNG)]), proof(['add-original', hash(BLUE_PNG)])], 'add');
  f.coordinator.settle(held, 'hold');
  assert.equal((await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' })).error, 'previous_operation_unresolved');
  assert.equal(writes(f).length, 0); assert.equal(f.stages, 0);
});

test('withdrawn source cannot authorize normal-hold recovery using only a cached or catalog image', async t => {
  const f = fixture({ rows: [], hooks: { add_custom_face: () => null } }); t.after(() => f.close());
  await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' }); f.rows = [favorite()]; f.memory.clear();
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' });
  assert.equal(result.error, 'forbidden_reference'); assert.deepEqual(writes(f).map(c => c.action), ['add_custom_face']);
});

test('remote withdrawal while candidate bytes are verified retains the normal hold and never annotates', async t => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({ rows: [], hooks: { add_custom_face: () => null }, extras: { originalDownloader: async url => { if (url.includes('qq_expression')) f.hooks.get_msg = () => { throw new Error('source withdrawn'); }; return validateOriginalImage(PNG); } } }); t.after(() => f.close());
  await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' }); f.rows = [favorite()];
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' });
  assert.equal(result.collection_binding_confirmed, false); assert.equal(result.reconciled_previous_add, false); assert.equal(result.new_add_dispatched, false);
  assert.deepEqual(writes(f).map(c => c.action), ['add_custom_face']); assert.equal(f.store.get(SELF, 'NATIVE_SECRET_RESOURCE'), undefined);
});

test('matching directory MD5 is insufficient when an existing candidate URL serves different actual bytes', async t => {
  const f = fixture({ extras: { originalDownloader: async url => validateOriginalImage(url.includes('qq_expression') ? BLUE_PNG : PNG) } }); t.after(() => f.close());
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'red source' });
  assert.equal(result.error, 'collection_content_unverified'); assert.equal(writes(f).length, 0);
  assert.equal(f.store.get(SELF, 'NATIVE_SECRET_RESOURCE'), undefined);
});

test('after submitted add a wrong/unreadable candidate image keeps hold and never binds, labels, rolls back or re-adds', async t => {
  for (const missing of [false, true]) {
    const f = fixture({ rows: [], extras: { originalDownloader: async url => { if (url.includes('qq_expression')) { if (missing) throw new Error('unavailable PRIVATE_URL'); return validateOriginalImage(BLUE_PNG); } return validateOriginalImage(PNG); } } });
    try {
      const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'red source' });
      assert.equal(result.status, 'ok'); assert.equal(result.submitted, true); assert.equal(result.collection_binding_confirmed, false); assert.equal(result.description_submitted, false);
      assert.equal(result.face_ref, undefined); assert.equal(f.store.get(SELF, 'CREATED_NATIVE_RESOURCE'), undefined);
      const retry = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'red source' });
      assert.equal(retry.error, 'collection_content_unverified'); assert.equal(retry.new_add_dispatched, false); assert.equal(retry.previous_collection_submitted, true); assert.equal(retry.reconcile_allowed, true);
      assert.deepEqual(writes(f).map(c => c.action), ['add_custom_face']);
    } finally { f.close(); }
  }
});

test('candidate must still be the unique same native identity after actual-byte verification', async t => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({ extras: { originalDownloader: async url => { if (url.includes('qq_expression')) f.rows = [favorite(PNG, { resId: 'REPLACED_ID', emoId: 3 })]; return validateOriginalImage(PNG); } } }); t.after(() => f.close());
  assert.equal((await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'cat' })).error, 'collection_content_unverified');
  assert.equal(writes(f).length, 0);
});

test('known safe staging errors remain diagnosable without exposing paths, getters or arbitrary errors', async t => {
  const f = fixture({ rows: [], extras: { staging: { stage: async () => { throw new Error('storage_capacity'); } } } }); t.after(() => f.close());
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' });
  assert.equal(result.error, 'storage_capacity'); assert.equal(result.dispatched, false); assert.equal(writes(f).length, 0);
  let touches = 0; const evil = Object.defineProperty(new Error(), 'message', { get() { touches++; return '/PRIVATE_PATH'; } });
  const g = fixture({ rows: [], extras: { staging: { stage: async () => { throw evil; } } } }); t.after(() => g.close());
  const unknown = await g.execute('add_custom_face', { image_id: 'img_11_0', description: 'x' });
  assert.equal(unknown.error, 'resource_unavailable'); assert.equal(touches, 0); assert.equal(writes(g).length, 0);
});

test('stager must attest the exact source bytes and cannot mutate the source validation buffer', async t => {
  const f = fixture({ rows: [], extras: { staging: { stage: async bytes => { BLUE_PNG.copy(bytes, 0, 0, Math.min(bytes.length, BLUE_PNG.length)); return { providerPath: '/container/blue.png', digest: hash(bytes) }; } } } }); t.after(() => f.close());
  assert.equal((await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'red' })).error, 'storage_unavailable');
  assert.equal(writes(f).length, 0);
});

test('description failure preserves a completed collection and never rolls it back or re-adds', async t => {
  const f = fixture({ rows: [], hooks: { set_custom_face_desc: () => { throw new OneBotError('api_failed', 1400); } } }); t.after(() => f.close());
  const first = await f.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' });
  assert.equal(first.collection_submitted, true); assert.equal(first.description_confirmed, false);
  delete f.hooks.set_custom_face_desc;
  const second = await f.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' });
  assert.equal(second.already_collected, true); assert.equal(second.description_confirmed, true);
  assert.equal(writes(f).filter(c => c.action === 'add_custom_face').length, 1);
  assert.equal(writes(f).filter(c => c.action === 'delete_custom_face').length, 0);
});

test('Any native responses are submissions only; description cache changes only after matching readback', async t => {
  const f = fixture({ hooks: { set_custom_face_desc: () => ({ result: 7, errMsg: 'SECRET' }) } }); t.after(() => f.close());
  const ref = await firstRef(f);
  const result = await f.execute('set_custom_face_description', { face_ref: ref, description: '新描述' });
  assert.equal(result.status, 'ok'); assert.equal(result.submitted, true); assert.equal(result.effect_confirmed, false);
  assert.equal(f.store.resolve(ref, SELF, GROUP)?.description, '白猫无语');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('successful description readback rotates ref; failures after native submission retain receipt', async t => {
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  const changed = await f.execute('set_custom_face_description', { face_ref: ref, description: '新描述', tags: ['新标签'] });
  assert.equal(changed.description_confirmed, true); assert.notEqual(changed.face_ref, ref); assert.equal(f.store.resolve(ref, SELF, GROUP), undefined);
  const fresh = changed.face_ref as string;
  f.hooks.set_custom_face_desc = () => { f.hooks.fetch_custom_face_detail = () => { throw new Error('readback SECRET failed'); }; return null; };
  const partial = await f.execute('set_custom_face_description', { face_ref: fresh, description: '另一个描述' });
  assert.equal(partial.status, 'ok'); assert.equal(partial.submitted, true); assert.equal(partial.effect_confirmed, false);
  assert.equal(f.store.resolve(fresh, SELF, GROUP)?.description, '新描述');
});

test('delete revokes local ref after submission but never proves remote absence', async t => {
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  const result = await f.execute('delete_custom_face', { face_ref: ref });
  assert.equal(result.status, 'ok'); assert.equal(result.effect_confirmed, false); assert.equal(result.reference_revoked, true);
  assert.equal(f.store.resolve(ref, SELF, GROUP), undefined);
  f.rows = [favorite()]; // stale native cache must not resurrect a locally retired ref
  assert.equal((await f.execute('list_custom_faces')).returned_count, 0);
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).error, 'invalid_face_ref');
  assert.equal(writes(f).length, 1);
});

test('normal delete permits a later explicit real add; stale catalog rows alone never revive retired references', async t => {
  const f = fixture(); t.after(() => f.close()); const old = await firstRef(f);
  assert.equal((await f.execute('delete_custom_face', { face_ref: old })).reference_revoked, true);
  f.rows = [favorite()]; // provider cache still shows the old row after deletion
  assert.equal((await f.execute('list_custom_faces')).returned_count, 0);
  f.hooks.add_custom_face = () => null; // real explicit re-add accepted with same native identity
  const added = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'collected again' });
  assert.equal(added.collection_submitted, true); assert.equal(added.already_collected, false); assert.equal(added.description_confirmed, true);
  assert.deepEqual(writes(f).map(c => c.action), ['delete_custom_face', 'add_custom_face', 'set_custom_face_desc']);
  assert.equal(f.store.resolve(old, SELF, GROUP), undefined); assert.ok(f.store.resolve(added.face_ref as string, SELF, GROUP));
});

test('normal delete with absent native row also permits a fresh later add', async t => {
  const f = fixture(); t.after(() => f.close()); const old = await firstRef(f);
  await f.execute('delete_custom_face', { face_ref: old });
  const result = await f.execute('add_custom_face', { image_id: 'img_11_0', description: 'readded' });
  assert.equal(result.collection_submitted, true); assert.equal(result.description_confirmed, true);
  assert.deepEqual(writes(f).map(c => c.action), ['delete_custom_face', 'add_custom_face', 'set_custom_face_desc']);
});

test('negative business codes and malicious accessors are uncertain, never followed by additional write stages', async t => {
  for (const action of ['add_custom_face', 'delete_custom_face', 'set_custom_face_desc']) {
    for (const shape of ['negative', 'getter', 'proxy']) {
      let touches = 0;
      const reply = shape === 'negative' ? { result: -1, errMsg: 'PRIVATE_PROVIDER_BODY' } : shape === 'getter' ? Object.defineProperty({}, 'result', { enumerable: true, get() { touches++; return 0; } }) : new Proxy({}, { getOwnPropertyDescriptor() { touches++; return undefined; } });
      const f = fixture({ rows: action === 'add_custom_face' ? [] : [favorite()], hooks: { [action]: () => reply } });
      try {
        const ref = action === 'add_custom_face' ? undefined : await firstRef(f);
        const name = action === 'set_custom_face_desc' ? 'set_custom_face_description' : action;
        const args = action === 'add_custom_face' ? { image_id: 'img_11_0', description: 'new' } : action === 'set_custom_face_desc' ? { face_ref: ref, description: 'new' } : { face_ref: ref };
        const result = await f.execute(name, args);
        assert.equal(result.status, 'unknown'); assert.equal(result.retry_allowed, false); assert.equal(touches, 0);
        assert.equal(result.provider_reported_failure, shape === 'negative' ? true : undefined);
        assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_BODY'));
        assert.equal((await f.execute(name, args)).error, 'previous_operation_unresolved');
        assert.equal(writes(f).length, 1);
      } finally { f.close(); }
    }
  }
});

test('unknown send is recipient-scoped, does not freeze shared asset edits, and cannot be bypassed by renaming', async t => {
  const f = fixture({ hooks: { send_group_msg: params => { if (params?.group_id === GROUP) throw new OneBotError('api_failed', 1200); return { message_id: '2000' }; } } }); t.after(() => f.close());
  const ref = await firstRef(f);
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).status, 'unknown');
  const group = '100000003', ctx = { ...CTX, groupId: group };
  const other = new CustomFaceTools(f.api, group, CUSTOM_FACE_TOOL_NAMES, f.memory, f.config);
  const otherRef = f.store.issue(SELF, group, 'NATIVE_SECRET_RESOURCE')!;
  assert.equal((await other.execute('send_custom_face', { face_ref: otherRef }, ctx)).status, 'executed');
  const changed = await other.execute('set_custom_face_description', { face_ref: otherRef, description: 'changed' }, ctx);
  assert.equal(changed.description_confirmed, true);
  const renewed = f.store.issue(SELF, GROUP, 'NATIVE_SECRET_RESOURCE')!;
  assert.equal((await f.execute('send_custom_face', { face_ref: renewed })).error, 'previous_operation_unresolved');
  assert.equal((await other.execute('delete_custom_face', { face_ref: changed.face_ref }, ctx)).reference_revoked, true);
});

test('uncertain asset mutation still blocks sends to every authorized group', async t => {
  const f = fixture({ hooks: { set_custom_face_desc: () => { throw new OneBotError('api_failed', 1200); } } }); t.after(() => f.close());
  const ref = await firstRef(f);
  assert.equal((await f.execute('set_custom_face_description', { face_ref: ref, description: 'new' })).status, 'unknown');
  const group = '100000003', other = new CustomFaceTools(f.api, group, CUSTOM_FACE_TOOL_NAMES, f.memory, f.config);
  const otherRef = f.store.issue(SELF, group, 'NATIVE_SECRET_RESOURCE')!;
  assert.equal((await other.execute('send_custom_face', { face_ref: otherRef }, { ...CTX, groupId: group })).error, 'previous_operation_unresolved');
  assert.deepEqual(writes(f).map(c => c.action), ['set_custom_face_desc']);
});

test('unknown delete protects target without inventing a confirmed deletion', async t => {
  const f = fixture({ hooks: { delete_custom_face: () => { throw new OneBotError('api_failed', 1200); } } }); t.after(() => f.close()); const ref = await firstRef(f);
  const first = await f.execute('delete_custom_face', { face_ref: ref }); assert.equal(first.status, 'unknown');
  assert.equal((await f.execute('send_custom_face', { face_ref: ref })).error, 'previous_operation_unresolved');
  assert.equal((await f.execute('set_custom_face_description', { face_ref: ref, description: 'x' })).error, 'previous_operation_unresolved');
  assert.equal(writes(f).length, 1);
});

test('source validation rejects foreign group/sender/message/index/non-image/unknown source and never stages', async t => {
  const cases: JsonObject[] = [wire(), wire(), wire(), wire(), wire()];
  cases[0]!.group_id = '200000002'; cases[1]!.sender = { user_id: '300000001' }; cases[2]!.message_id = '12';
  cases[3]!.message = [{ type: 'text', data: { text: 'https://evil/image.png' } }]; cases[4]!.message = [];
  for (const raw of cases) {
    const f = fixture({ rows: [], hooks: { get_msg: () => raw } });
    try { assert.equal((await f.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' })).status, 'error'); assert.equal(f.downloads, 0); assert.equal(f.stages, 0); assert.equal(writes(f).length, 0); } finally { f.close(); }
  }
  const absent = fixture({ rows: [], entries: [] }); t.after(() => absent.close());
  assert.equal((await absent.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' })).error, 'forbidden_reference');
  assert.equal(absent.calls.some(c => c.action === 'get_msg'), false);
});

test('direct reply grants source lookup, but reset during download revokes it before staging/native writes', async t => {
  const reply: TimelineEntry = { messageId: '12', userId: USER, nickname: '', text: '', time: 1, replyTo: '11' };
  const f = fixture({ rows: [], entries: [reply] }); t.after(() => f.close());
  assert.equal((await f.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' })).description_confirmed, true);
  const g = fixture({ rows: [], extras: { originalDownloader: async () => { g.memory.clear(); return validateOriginalImage(PNG); } } }); t.after(() => g.close());
  const result = await g.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' });
  assert.equal(result.status, 'error'); assert.equal(writes(g).length, 0); assert.equal(g.stages, 0);
});

test('source image requires URL, not file_id; rotating transport rkeys do not change confirmation fingerprints', async t => {
  let sequence = 0;
  const f = fixture({ rows: [], hooks: { get_msg: () => { const raw = wire(); ((raw.message as JsonObject[])[0]!.data as JsonObject).url = `https://gchat.qpic.cn/source?rkey=${sequence++}`; return raw; } } }); t.after(() => f.close());
  const args = { image_id: 'img_11_0', description: '猫' };
  const one = await f.tools.confirmationDetails('add_custom_face', args, CTX), two = await f.tools.confirmationDetails('add_custom_face', args, CTX);
  assert.equal(one, two); assert.equal(f.stages, 0); assert.equal(f.downloads, 0); assert.equal(writes(f).length, 0);
  assert.ok(!one.includes('https:')); assert.ok(!one.includes(md5(PNG)));
  assert.equal((await f.execute('add_custom_face', args)).description_confirmed, true);
});

test('confirmation target details are readonly, private-identity-hashed and fail on stale revisions', async t => {
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  const args = { face_ref: ref, description: 'new' };
  const result = await f.tools.confirmationDetails('set_custom_face_description', args, CTX);
  assert.equal(f.downloads, 0); assert.equal(f.stages, 0); assert.equal(writes(f).length, 0);
  for (const secret of [md5(PNG), 'NATIVE_SECRET_RESOURCE', 'https:', '/private/']) assert.ok(!result.includes(secret));
  const row = f.store.resolve(ref, SELF, GROUP)!; f.store.setLocalTags(SELF, row.resId, ['changed'], row.revision);
  await assert.rejects(f.tools.confirmationDetails('set_custom_face_description', args, CTX));
});

test('absence of staging only disables add; catalogue/view remain usable', async t => {
  const f = fixture({ extras: { staging: undefined } }); t.after(() => f.close());
  const ref = await firstRef(f); assert.equal((await f.execute('view_custom_face', { face_ref: ref })).status, 'ok');
  assert.equal((await f.execute('add_custom_face', { image_id: 'img_11_0', description: '猫' })).error, 'storage_unavailable');
});

test('local snapshot pagination can traverse all observed entries without refreshing QQ or changing membership', async t => {
  const f = fixture({ rows: Array.from({ length: 205 }, (_, n) => favorite(PNG, { resId: `RES_${String(n).padStart(3, '0')}`, emoId: n, desc: `cat ${n}` })) }); t.after(() => f.close());
  const one = await f.execute('list_custom_faces', { limit: 100, query: 'cat' });
  assert.equal(one.returned_count, 100); assert.equal(one.snapshot_count, 205); assert.equal(one.pagination, 'local_fixed_snapshot');
  f.rows = []; // pagination must not refresh and replace a fixed snapshot
  const two = await f.execute('list_custom_faces', { limit: 100, cursor: one.next_cursor });
  const three = await f.execute('list_custom_faces', { limit: 100, cursor: two.next_cursor, query: 'cat' });
  assert.equal(two.returned_count, 100); assert.equal(three.returned_count, 5); assert.equal(three.next_cursor, undefined);
  assert.equal(f.calls.filter(c => c.action === 'fetch_custom_face_detail').length, 1);
  assert.equal((await f.execute('list_custom_faces', { cursor: one.next_cursor, query: 'dog' })).error, 'invalid_cursor');
  const otherGroup = '100000003';
  const other = new CustomFaceTools(f.api, otherGroup, CUSTOM_FACE_TOOL_NAMES, f.memory, f.config);
  assert.equal((await other.execute('list_custom_faces', { cursor: one.next_cursor }, { ...CTX, groupId: otherGroup })).error, 'invalid_cursor');
});

test('snapshot skips stale revisions rather than silently returning changed resources', async t => {
  const f = fixture({ rows: [favorite(PNG, { resId: 'A' }), favorite(PNG, { resId: 'B', emoId: 1 })] }); t.after(() => f.close());
  const first = await f.execute('list_custom_faces', { limit: 1 });
  const row = f.store.get(SELF, 'B')!; f.store.setLocalTags(SELF, 'B', ['changed'], row.revision);
  const second = await f.execute('list_custom_faces', { cursor: first.next_cursor });
  assert.equal(second.returned_count, 0); assert.equal(second.stale_omitted, 1); assert.equal(second.next_cursor, undefined);
});

test('missing native description cannot overwrite a known description with invented empty text', async t => {
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  f.rows = [favorite(PNG, { desc: undefined })];
  assert.equal((await f.execute('list_custom_faces')).error, 'invalid_directory');
  assert.equal(f.store.resolve(ref, SELF, GROUP)?.description, '白猫无语');
});

test('confirmed native description is not erased by a local index projection failure', async t => {
  const f = fixture(); t.after(() => f.close()); const ref = await firstRef(f);
  f.store.updateDescription = () => { throw new Error('disk full SECRET'); };
  const result = await f.execute('set_custom_face_description', { face_ref: ref, description: 'new' });
  assert.equal(result.submitted, true); assert.equal(result.effect_confirmed, true); assert.equal(result.description_confirmed, true);
  assert.equal(result.local_projection_failed, true); assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('cancellation from pre-send capture does not dispatch or leave a spurious pending record', async t => {
  const ac = new AbortController();
  const f = fixture({ extras: { beforeSend: () => { ac.abort(); return { memoryIds: new Set() }; } } }); t.after(() => f.close());
  const ref = await firstRef(f), result = await f.execute('send_custom_face', { face_ref: ref }, CTX, ac.signal);
  assert.equal(result.error, 'cancelled'); assert.equal(writes(f).length, 0);
});

test('account-level queue serializes different wakes/groups using shared coordinator', async t => {
  const coordinator = new CustomFaceCoordinator(), store = new CustomFaceStore(); t.after(() => { coordinator.close(); store.close(); });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const first = fixture({ store, coordinator }); const ref = await firstRef(first);
  first.hooks.send_group_msg = async () => { await gate; return { message_id: '1400' }; };
  const one = first.execute('send_custom_face', { face_ref: ref });
  while (!first.calls.some(c => c.action === 'send_group_msg')) await new Promise<void>(r => setImmediate(r));
  const second = fixture({ store, coordinator });
  const two = second.execute('set_custom_face_description', { face_ref: ref, description: 'later' });
  await new Promise<void>(r => setImmediate(r)); assert.equal(second.calls.length, 0);
  release(); assert.equal((await one).status, 'executed'); assert.equal((await two).description_confirmed, true);
});
