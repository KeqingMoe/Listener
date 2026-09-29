import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ArtifactStore, ARTIFACT_LIMITS } from '../../../src/artifacts/store.js';
import { ArtifactTools, buildArtifactToolDefinitions } from '../../../src/tools/artifacts/tools.js';

const context = { selfId: '1', groupId: '2', actorId: '3', messageId: '4' };
function fixture(now = () => Date.now()) {
  const root = mkdtempSync(join(tmpdir(), 'artifacts-')), directory = join(root, 'files');
  const store = new ArtifactStore({ path: join(root, 'a.sqlite'), directory, providerDirectory: '/napcat/artifacts', now });
  return { root, directory, store, tools: new ArtifactTools(store), close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('create_artifact stores text or byte arrays with required ttl and description; list is scoped', async () => {
  const f = fixture(); try {
    const text = await f.tools.execute('create_artifact', { name: 'notes.txt', description: '笔记', ttl_ms: 60000, content: '你好', media_type: 'text/plain' }, context);
    assert.equal(text.status, 'ok'); assert.match(String(text.artifact_id), /^art_[a-f0-9]{24}$/); assert.equal(text.size, 6); assert.equal(text.media_type, 'text/plain');
    const bytes = await f.tools.execute('create_artifact', { name: 'raw.bin', description: '字节', ttl_ms: 60000, content: [0, 1, 255] }, context);
    assert.equal(bytes.media_type, 'application/octet-stream'); assert.equal(bytes.size, 3);
    const u8 = await f.tools.execute('create_artifact', { name: 'u8.bin', description: 'Uint8Array', ttl_ms: 1000, content: new Uint8Array([9, 9]) }, context);
    assert.equal(u8.size, 2);
    for (const bad of [
      { name: 'x', description: 'd', content: 'a' },
      { name: 'x', description: 'd', ttl_ms: 0, content: 'a' },
      { name: 'x', description: 'd', ttl_ms: ARTIFACT_LIMITS.ttlMs + 1, content: 'a' },
      { name: 'x', ttl_ms: 1, content: 'a' },
      { name: 'x', description: '  ', ttl_ms: 1, content: 'a' },
      { name: 'a/b', description: 'd', ttl_ms: 1, content: 'a' },
      { name: 'x', description: 'd', ttl_ms: 1, content: [256] },
      { name: 'x', description: 'd', ttl_ms: 1, content: 'a', media_type: 'text' },
      { name: 'x', description: 'd', ttl_ms: 1, content: 'a', extra: 1 },
    ]) assert.deepEqual(await f.tools.execute('create_artifact', bad, context), { status: 'error', error: 'invalid_arguments' }, JSON.stringify(bad));
    const listed = await f.tools.execute('list_artifacts', {}, context);
    assert.equal((listed.artifacts as unknown[]).length, 3);
    assert.deepEqual(await f.tools.execute('list_artifacts', {}, { ...context, groupId: '5' }), { status: 'ok', artifacts: [], has_more: false });
    const id = String(text.artifact_id);
    assert.equal(f.store.get({ selfId: '1', groupId: '5' }, id), undefined);
    const artifact = f.store.get(context, id)!;
    assert.equal((await f.store.read(artifact)).toString(), '你好');
    assert.equal(f.store.providerPath(artifact), `/napcat/artifacts/${id}`);
    assert.equal(statSync(join(f.directory, id)).mode & 0o777, 0o400);
  } finally { f.close(); }
});

test('expired artifacts disappear and are swept with stray temporaries; global quota rejects without eviction', async () => {
  let now = 1_000_000; const f = fixture(() => now); try {
    const a = await f.tools.execute('create_artifact', { name: 'a', description: 'd', ttl_ms: 1000, content: 'x' }, context);
    writeFileSync(join(f.directory, '.stray.tmp'), 'x'); utimesSync(join(f.directory, '.stray.tmp'), new Date(0), new Date(0));
    now += 1000;
    assert.equal(f.store.get(context, String(a.artifact_id)), undefined);
    now += 120_000; await f.store.sweep();
    assert.deepEqual(readdirSync(f.directory), []);
    // Simulate a nearly full store by reserving metadata only.
    (f.store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run('art_' + '0'.repeat(24), '1', '2', 'big', 'd', 'x/y', ARTIFACT_LIMITS.totalBytes - 1, 'h', now, now + 10_000);
    assert.deepEqual(await f.tools.execute('create_artifact', { name: 'b', description: 'd', ttl_ms: 1000, content: 'xy' }, context), { status: 'error', error: 'artifact_storage_full' });
    assert.equal((await f.tools.execute('create_artifact', { name: 'c', description: 'd', ttl_ms: 1000, content: 'x' }, context)).status, 'ok');
  } finally { f.close(); }
});

test('create_image encodes RGBA pixels and rejects mismatched sizes', async () => {
  const f = fixture(); try {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]);
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const r = await f.tools.execute('create_image', { name: `x.${format}`, description: '测试图', ttl_ms: 1000, width: 2, height: 2, pixels, format }, context);
      assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.media_type, `image/${format}`);
      const meta = await sharp(await f.store.read(f.store.get(context, String(r.artifact_id))!)).metadata();
      assert.equal(meta.format, format); assert.equal(meta.width, 2); assert.equal(meta.height, 2);
    }
    const png = await f.tools.execute('create_image', { name: 'p', description: 'd', ttl_ms: 1000, width: 2, height: 2, pixels: Array.from(pixels), format: 'png' }, context);
    const raw = await sharp(await f.store.read(f.store.get(context, String(png.artifact_id))!)).ensureAlpha().raw().toBuffer();
    assert.deepEqual([...raw], [...pixels]);
    for (const bad of [{ width: 3, height: 2 }, { width: 0, height: 2 }, { width: 8193, height: 1 }, { format: 'gif' }])
      assert.equal((await f.tools.execute('create_image', { name: 'p', description: 'd', ttl_ms: 1000, width: 2, height: 2, pixels, format: 'png', ...bad }, context)).error, 'invalid_arguments', JSON.stringify(bad));
    assert.deepEqual(buildArtifactToolDefinitions(['create_image', 'nope']).map(d => d.function.name), ['create_image']);
  } finally { f.close(); }
});

test('tampered artifact files are never served', async () => {
  const f = fixture(); try {
    const r = await f.tools.execute('create_artifact', { name: 'a', description: 'd', ttl_ms: 1000, content: 'abc' }, context);
    const id = String(r.artifact_id), file = join(f.directory, id);
    rmSync(file); writeFileSync(file, 'abd');
    await assert.rejects(f.store.read(f.store.get(context, id)!), /artifact_unavailable/);
  } finally { f.close(); }
});
