import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { GroupMediaTools } from '../../../../src/tools/media/tools.ts';
import { ImageTools } from '../../../../src/tools/images/tools.ts';
import { ArtifactStore } from '../../../../src/artifacts/store.ts';
import type { Api } from '../../../../src/contracts/onebot.ts';
import type { JsonObject } from '../../../../src/contracts/json.ts';
import type { Memory, TimelineEntry } from '../../../../src/contracts/messages.ts';

const GROUP = '12345', SELF = '99999';
const ctx = { groupId: GROUP, selfId: SELF, actorId: '22222', messageId: '1' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-images-'));
  const store = new ArtifactStore({ path: join(dir, 'a.sqlite'), directory: join(dir, 'files'), providerDirectory: '/napcat/art' });
  const calls: { action: string; params: JsonObject }[] = []; const sent: TimelineEntry[] = [];
  const api: Api = { async call(action, params = {}) { calls.push({ action, params: params as JsonObject }); if (action === 'get_login_info') return { user_id: SELF }; if (action === 'send_group_msg') return { message_id: 777 }; return {}; } };
  const memory: Memory = { append: () => true, recent: () => [], find: () => undefined, context: () => '', async compact() {}, clear() {}, close() {} };
  const media = new GroupMediaTools(api, GROUP, ['send_group_image'], memory, { artifacts: store, onSent: e => { sent.push(e); } });
  const images = new ImageTools(api, memory, { enabled: true, maxDownloadMb: 10 }, async () => { throw new Error('no network'); }, GROUP, store);
  return { store, calls, sent, media, images, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const png = () => sharp({ create: { width: 4, height: 3, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
const create = (f: ReturnType<typeof fixture>, bytes: Buffer, mediaType = 'image/png', scope = { selfId: SELF, groupId: GROUP }) =>
  f.store.create({ ...scope, name: 'x.png', description: '图', mediaType, ttlMs: 60000, bytes });

test('send_group_image sends an image artifact by NapCat-side path, never base64', async () => {
  const f = fixture(); try {
    const artifact = await create(f, await png());
    const result = await f.media.execute('send_group_image', { artifact_id: artifact.artifactId }, ctx);
    assert.equal(result.status, 'executed', JSON.stringify(result)); assert.equal(result.message_id, '777');
    const send = f.calls.find(c => c.action === 'send_group_msg')!;
    assert.deepEqual(send.params, { group_id: GROUP, message: [{ type: 'image', data: { file: `/napcat/art/${artifact.artifactId}` } }] });
    assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('send_group_image rejects non-image artifacts, other groups, both or neither id', async () => {
  const f = fixture(); try {
    const text = await create(f, Buffer.from('not an image'), 'image/png');
    assert.equal((await f.media.execute('send_group_image', { artifact_id: text.artifactId }, ctx)).error, 'not_an_image');
    const other = await create(f, await png(), 'image/png', { selfId: SELF, groupId: '54321' });
    assert.equal((await f.media.execute('send_group_image', { artifact_id: other.artifactId }, ctx)).error, 'artifact_not_found');
    assert.equal((await f.media.execute('send_group_image', { artifact_id: other.artifactId, image_id: 'img_1_0' }, ctx)).error, 'invalid_arguments');
    assert.equal((await f.media.execute('send_group_image', {}, ctx)).error, 'invalid_arguments');
    assert.equal((await f.media.execute('send_group_image', { artifact_id: 'art_x' }, ctx)).error, 'invalid_arguments');
    assert.equal(f.calls.filter(c => c.action === 'send_group_msg').length, 0);
    const schema = f.media.definitions()[0]!.function.parameters as JsonObject;
    assert.deepEqual(schema.required, []); assert.equal('oneOf' in schema, false);
  } finally { f.close(); }
});

test('view_images accepts image artifact ids through the normal image pipeline', async () => {
  const f = fixture(); try {
    const artifact = await create(f, await png());
    const viewed = await f.images.view({ image_ids: [artifact.artifactId] }, ctx, f.images.createTurn());
    assert.equal(viewed.result.status, 'ok'); assert.deepEqual(viewed.result.loaded_ids, [artifact.artifactId]);
    const part = viewed.content.find(p => p.type === 'image_url');
    assert.ok(part && part.type === 'image_url' && part.image_url.url.startsWith('data:image/'));
    const text = await create(f, Buffer.from('plain'));
    assert.equal((await f.images.view({ image_ids: [text.artifactId] }, ctx, f.images.createTurn())).result.status, 'error');
  } finally { f.close(); }
});
