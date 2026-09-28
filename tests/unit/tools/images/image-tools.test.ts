import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageTools, VIEW_IMAGES_TOOL } from '../../../../src/tools/images/tools.js';
import { imageReferences, imageMarker } from '../../../../src/onebot/image-references.js';
import { LISTENER_GROUP } from '../../../../src/contracts/identity.js';
import { type Api } from '../../../../src/contracts/onebot.js';
import { type Memory, type TimelineEntry } from '../../../../src/contracts/messages.js';
import { type TurnContext } from '../../../../src/contracts/tools.js';
import type { ImagesConfig } from '../../../../src/config/listener.js';
import type { ImageDownloader } from '../../../../src/tools/images/download.js';

const context: TurnContext = { groupId: LISTENER_GROUP, actorId: '123', messageId: '1', selfId: '999' };
const options: ImagesConfig = { enabled: true, maxPerTurn: 3, maxDownloadMb: 10 };
const url = 'https://example.invalid/secret?key=hidden';
const segment = { type: 'image', data: { url, file: '/private/secret' } };
const entry: TimelineEntry = { messageId: '1', userId: '123', nickname: 'Alice', time: 42, text: '[图片]', images: [{ id: 'img_1_0', index: 0 }], replyTo: '2' };
const remote = (extra = {}) => ({ message_type: 'group', group_id: LISTENER_GROUP, message_id: '1', sender: { user_id: '123', nickname: 'Alice' }, time: 42, message: [segment], ...extra });
const image = { dataUrl: 'data:image/png;base64,YQ==', width: 1, height: 1, firstFrameOnly: false };
function setup(response: unknown = remote(), entries = [entry], policy = { ...options }, download?: ImageDownloader) {
  const calls: Array<{ action: string; params: unknown }> = [], downloads: unknown[][] = [];
  const api: Api = { async call(action, params) { calls.push({ action, params }); if (typeof response === 'function') return response(); if (response instanceof Error) throw response; return response; } };
  const memory: Memory = { recent: () => entries, find: () => { throw new Error('must only use recent'); }, append: () => true, context: () => '', compact: async () => {}, clear() {}, close() {} };
  const tools = new ImageTools(api, memory, policy, async (...args) => { downloads.push(args); return download ? download(...args) : image; });
  return { tools, calls, downloads, state: tools.createTurn(), view: (ids = ['img_1_0']) => tools.view({ image_ids: ids }, context, tools.createTurn()) };
}

test('reference extraction is pure, bounded, and preserves original segment indices', () => {
  const segments = [{ type: 'text' }, segment, segment, { type: 'reply' }, segment, segment];
  const original = structuredClone(segments);
  assert.deepEqual(imageReferences('-123', segments), [{ id: 'img_-123_1', index: 1 }, { id: 'img_-123_2', index: 2 }, { id: 'img_-123_4', index: 4 }]);
  assert.deepEqual(segments, original);
  for (const id of ['1\n', 'x', '1'.repeat(33), 'https://bad']) assert.deepEqual(imageReferences(id, segments), []);
  assert.deepEqual(imageReferences('1', [...Array(128).fill(null), segment]), []);
  assert.deepEqual(imageReferences('1', '[CQ:image]'), []);
  assert.match(imageMarker({ id: 'img_1_1', index: 1 }), /img_1_1/);
});

test('strict schema and runtime argument validation prevent all lookups', async () => {
  const p = VIEW_IMAGES_TOOL.function.parameters as any;
  assert.equal(VIEW_IMAGES_TOOL.function.name, 'view_images');
  assert.equal(p.additionalProperties, false);
  assert.deepEqual(p.required, ['image_ids']);
  assert.equal(p.properties.image_ids.minItems, 1); assert.equal(p.properties.image_ids.maxItems, 3);
  const s = setup();
  for (const args of [null, [], {}, { image_ids: [] }, { image_ids: Array(4).fill('img_1_0') }, { image_ids: ['img_1_0'], url }, ...['img_1_128', 'img_1_00', 'img_1_0\n', 'img_x_0', 'img_1_0/path', `img_${'1'.repeat(33)}_0`, url, '/tmp/a'].map(id => ({ image_ids: [id] }))]) {
    assert.equal((await s.tools.view(args, context, s.state)).result.status, 'error');
  }
  assert.equal(s.calls.length, 0); assert.equal(s.downloads.length, 0);
});

test('constructor rejects malformed options and captures immutable policy copy', async () => {
  for (const policy of [null, {}, [], { ...options, extra: true }, ...[undefined, 'true', 1].map(enabled => ({ ...options, enabled })), ...[0, 4, 1.5, '3'].map(maxPerTurn => ({ ...options, maxPerTurn })), ...[0, 11, NaN, '10'].map(maxDownloadMb => ({ ...options, maxDownloadMb }))]) assert.throws(() => setup(remote(), [entry], policy as any));
  const policy = { ...options, enabled: false }; const s = setup(remote(), [entry], policy); policy.enabled = true;
  assert.equal((await s.view()).result.error, 'tool_disabled'); assert.equal(s.calls.length, 0);
});

test('literal image marker in structured text does not grant image access',async()=>{
 const current:TimelineEntry={...entry,images:undefined,segments:[{type:'text',text:'[图片 id=img_1_0：未分析]'}]};
 const s=setup(remote(),[current]);assert.equal((await s.view()).result.status,'error');assert.equal(s.calls.length,0);assert.equal(s.downloads.length,0);
 // Old records retain their independently verified compatibility path.
 const legacy=setup(remote(),[{...entry,images:undefined}]);assert.equal((await legacy.view()).result.status,'ok');assert.equal(legacy.calls.length,1);
});

test('disabled and wrong group stop before API and downloader', async () => {
  for (const enabled of [false, true]) {
    const s = setup(remote(), [entry], { ...options, enabled });
    const r = await s.tools.view({ image_ids: ['img_1_0'] }, { ...context, groupId: '9' }, s.state);
    assert.equal(r.result.status, 'error'); assert.equal(s.calls.length, 0); assert.equal(s.downloads.length, 0);
  }
});

test('unseen, forged indices, and non-image local messages cannot resolve', async () => {
  for (const [entries, id] of [[[entry], 'img_99_0'], [[entry], 'img_1_1'], [[{ ...entry, images: [], text: '[图片]' }], 'img_1_0'], [[{ ...entry, images: undefined, text: 'hello' }], 'img_1_0']] as Array<[TimelineEntry[], string]>) {
    const s = setup(remote(), entries); assert.equal((await s.view([id])).result.status, 'error'); assert.equal(s.calls.length, 0); assert.equal(s.downloads.length, 0);
  }
  const s = setup(remote(), [{ ...entry, images: undefined }]); assert.equal((await s.view()).result.status, 'ok');
});

test('all remote origin and identity checks precede download including quoted targets', async () => {
  for (const extra of [{ group_id: '9' }, { message_type: 'private' }, { message_id: '3' }, { sender: { user_id: '0' } }, { sender: { user_id: '123\n' } }, { user_id: '999' }, { message: [{ type: 'text', data: { url } }] }]) {
    const s = setup(remote(extra)); assert.equal((await s.view()).result.status, 'error'); assert.equal(s.downloads.length, 0);
    const q = setup(remote({ message_id: '2', ...extra }));
    assert.equal((await q.view(['img_2_0'])).result.status, 'error'); assert.equal(q.downloads.length, 0);
  }
  const mismatch = setup(remote({ sender: { user_id: '456' } })); assert.equal((await mismatch.view()).result.status, 'error'); assert.equal(mismatch.downloads.length, 0);
  const q = setup(remote({ message_id: '2', sender: { user_id: '456' } })); assert.equal((await q.view(['img_2_0'])).result.status, 'ok');
});

test('HTTPS destinations only reach downloader after verified origin; no file fallback', async () => {
  for (const data of [{ file: '/etc/passwd' }, { file: 'a'.repeat(32) }, { url: 'http://localhost/a' }, { url: 'file:///etc/passwd' }, { url: 'data:image/png;base64,YQ==' }, { url: 'https://user:pass@example.com/' }]) {
    const s = setup(remote({ message: [{ type: 'image', data }] })); assert.equal((await s.view()).result.status, 'error'); assert.equal(s.downloads.length, 0); assert.deepEqual(s.calls.map(c => c.action), ['get_msg']);
  }
  const s = setup(remote({ message: [{ type: 'image', data: { url: 'https://127.0.0.1/private' } }] }), [entry], { ...options }, async () => { throw new Error('private destination secret'); });
  const r = await s.view(); assert.equal(s.downloads.length, 1); assert.equal(r.result.error, 'image_unavailable'); assert.doesNotMatch(JSON.stringify(r), /127|private|secret/);
});

test('image payload identifies untrusted provenance and first-frame limitation without URLs in text', async () => {
  const s = setup(remote({ sender: { user_id: 123, nickname: 'Alice'.repeat(100) }, time: 42 }), [entry], { ...options }, async () => ({ ...image, firstFrameOnly: true }));
  const r = await s.view(); assert.equal(r.result.status, 'ok'); assert.equal(r.content.length, 2);
  const text = r.content[0]!.type === 'text' ? r.content[0]!.text : '';
  for (const value of ['img_1_0', 'message_id', 'user_id', '123', 'nickname', '42', 'Untrusted', 'first-frame-only']) assert.ok(text.includes(value));
  assert.ok(text.length < 500); assert.doesNotMatch(text + JSON.stringify(r.result), /https:|secret|hidden|private/);
  assert.deepEqual(r.content[1], { type: 'image_url', image_url: { url: image.dataUrl } });
  assert.equal(s.downloads[0]![1], 10 * 1024 * 1024);
});

test('unique attempt budget spans calls, duplicates never retry successes or failures', async () => {
  const s = setup(remote(), [entry], { ...options, maxPerTurn: 2 });
  assert.equal((await s.tools.view({ image_ids: ['img_1_0', 'img_1_0'] }, context, s.state)).result.status, 'ok');
  assert.equal((await s.tools.view({ image_ids: ['img_1_0'] }, context, s.state)).content.length, 0);
  const partial = await s.tools.view({ image_ids: ['img_1_0', 'img_99_0'] }, context, s.state); assert.equal(partial.result.status, 'partial');
  assert.equal((await s.tools.view({ image_ids: ['img_2_0'] }, context, s.state)).result.status, 'error');
  assert.equal((await s.tools.view({ image_ids: ['img_99_0'] }, context, s.state)).result.status, 'error');
  assert.equal(s.state.attemptedIds.size, 2); assert.equal(s.calls.length, 1); assert.equal(s.downloads.length, 1);
  const bad = setup(new Error(`body=${url}`));
  for (let i = 0; i < 2; i++) assert.equal((await bad.tools.view({ image_ids: ['img_1_0'] }, context, bad.state)).result.error, 'image_unavailable');
  assert.equal(bad.calls.length, 1);
});

test('abort before lookup, after lookup and after download discards content', async () => {
  for (const stage of ['before', 'lookup', 'download']) {
    const controller = new AbortController();
    const s = setup(() => { if (stage === 'lookup') controller.abort(); return remote(); }, [entry], { ...options }, async () => { controller.abort(); return image; });
    if (stage === 'before') controller.abort();
    const r = await s.tools.view({ image_ids: ['img_1_0'] }, context, s.state, controller.signal);
    assert.equal(r.result.error, 'cancelled'); assert.deepEqual(r.content, []); assert.equal(s.state.loadedIds.size, 0);
    assert.equal(s.calls.length, stage === 'before' ? 0 : 1); assert.equal(s.downloads.length, stage === 'download' ? 1 : 0);
  }
});

test('abort on second lookup discards first image and retains attempt budget', async () => {
  const controller = new AbortController(); let calls = 0;
  const s = setup(() => { if (++calls === 2) controller.abort(); return remote({ message_id: String(calls) }); });
  const r = await s.tools.view({ image_ids: ['img_1_0', 'img_2_0'] }, context, s.state, controller.signal);
  assert.equal(r.result.error, 'cancelled'); assert.deepEqual(r.content, []); assert.equal(s.state.loadedIds.size, 0); assert.equal(s.state.attemptedIds.size, 2);
});
