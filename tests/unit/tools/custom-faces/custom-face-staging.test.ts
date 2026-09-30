import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, chmod, writeFile, symlink, link, rename, unlink, utimes } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SharedCustomFaceStaging } from '../../../../src/tools/custom-faces/staging.ts';
import type { CustomFaceImageFormat, SharedCustomFaceStagingOptions } from '../../../../src/tools/custom-faces/staging.ts';

const MARKER = '.qqbot-custom-face-cache.json';
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=', 'base64');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const errorIs = (code: string) => (error: unknown) => error instanceof Error && error.message === code;
async function setup(t: { after(fn: () => Promise<unknown>): void }, overrides: Partial<SharedCustomFaceStagingOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'qqbot-custom-face-staging-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'originals');
  const options = { directory, providerDirectory: '/app/qqbot-originals', ...overrides };
  return { root, directory, options, stager: new SharedCustomFaceStaging(options) };
}

// The downloader is responsible for full image decoding; these tests exercise
// immutable byte storage, not Sharp or any live OneBot/QQ endpoint.
test('stores original GIF bytes, private permissions, and mapped provider path', async t => {
  const { directory, stager } = await setup(t);
  const result = await stager.stage(gif, 'gif');
  assert.deepEqual(result, { digest: digest(gif), providerPath: `/app/qqbot-originals/${digest(gif)}.gif` });
  assert.deepEqual(await readFile(path.join(directory, `${digest(gif)}.gif`)), gif);
  assert.equal((await stat(directory)).mode & 0o7777, 0o700);
  assert.equal((await stat(path.join(directory, `${digest(gif)}.gif`))).mode & 0o7777, 0o400);
  assert.equal((await stat(path.join(directory, MARKER))).mode & 0o7777, 0o400);
  assert.deepEqual((await readdir(directory)).sort(), [MARKER, `${digest(gif)}.gif`].sort());
});

test('copies bytes before yielding and never stores a later caller mutation', async t => {
  const { directory, stager } = await setup(t);
  const input = Buffer.from(gif);
  const pending = stager.stage(input, 'gif');
  input.fill(0);
  const result = await pending;
  assert.equal(result.digest, digest(gif));
  assert.deepEqual(await readFile(path.join(directory, `${result.digest}.gif`)), gif);
});

test('assertAvailable initializes an empty directory and existing assets survive restart', async t => {
  const { directory, stager, options } = await setup(t);
  await stager.assertAvailable();
  const before = await readFile(path.join(directory, MARKER));
  const first = await stager.stage(gif, 'gif');
  const inode = (await stat(path.join(directory, `${first.digest}.gif`))).ino;
  const restarted = new SharedCustomFaceStaging(options);
  await restarted.assertAvailable();
  assert.deepEqual(await restarted.stage(gif, 'gif'), first);
  assert.equal((await stat(path.join(directory, `${first.digest}.gif`))).ino, inode);
  assert.deepEqual(await readFile(path.join(directory, MARKER)), before);
});

test('published assets never expire merely because their timestamps are old', async t => {
  const { directory, stager, options } = await setup(t);
  await stager.stage(gif, 'gif');
  const file = path.join(directory, `${digest(gif)}.gif`);
  await utimes(file, new Date(0), new Date(0));
  await new SharedCustomFaceStaging(options).assertAvailable();
  assert.deepEqual(await readFile(file), gif);
});

test('same-directory instances serialize concurrent publication and deduplicate', async t => {
  const { directory, stager, options } = await setup(t, { maxFiles: 1, maxBytes: gif.length });
  const second = new SharedCustomFaceStaging(options);
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? stager : second).stage(gif, 'gif')));
  assert.equal(new Set(results.map(result => result.providerPath)).size, 1);
  assert.equal((await readdir(directory)).length, 2);
  assert.equal((await stat(path.join(directory, `${digest(gif)}.gif`))).nlink, 1);
});

test('file-count quota is restored from disk and never evicts originals', async t => {
  const { directory, stager, options } = await setup(t, { maxFiles: 1 });
  await stager.stage(gif, 'gif');
  const restarted = new SharedCustomFaceStaging(options);
  await assert.rejects(restarted.stage(png, 'png'), errorIs('storage_capacity'));
  assert.deepEqual(await readFile(path.join(directory, `${digest(gif)}.gif`)), gif);
  assert.equal((await readdir(directory)).length, 2);
});

test('byte quota handles simultaneous different images without overcommit', async t => {
  const { directory, stager, options } = await setup(t, { maxBytes: gif.length + png.length - 1 });
  const results = await Promise.allSettled([stager.stage(gif, 'gif'), new SharedCustomFaceStaging(options).stage(png, 'png')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failed = results.find(result => result.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && errorIs('storage_capacity')(failed.reason));
  assert.equal((await readdir(directory)).length, 2);
});

test('reduced quota rejects an existing over-budget cache without deleting anything', async t => {
  const { directory, stager, options } = await setup(t);
  await stager.stage(gif, 'gif');
  await assert.rejects(new SharedCustomFaceStaging({ ...options, maxBytes: gif.length - 1 }).assertAvailable(), errorIs('storage_capacity'));
  assert.deepEqual(await readFile(path.join(directory, `${digest(gif)}.gif`)), gif);
});

test('rejects unsupported formats, mismatched signatures, empty and over-10MiB input before creating storage', async t => {
  const { root, stager } = await setup(t);
  for (const [bytes, format] of [[Buffer.alloc(0), 'gif'], [gif, 'png'], [Buffer.from('secret'), 'gif'], [gif, 'svg']] as [Buffer, CustomFaceImageFormat][]) {
    await assert.rejects(stager.stage(bytes, format), errorIs('storage_invalid_image'));
  }
  const large = Buffer.alloc(10 * 1024 * 1024 + 1);
  gif.copy(large);
  await assert.rejects(stager.stage(large, 'gif'), errorIs('storage_invalid_image'));
  assert.deepEqual(await readdir(root), []);
});

test('accepts all four advertised signatures and uses a POSIX provider path', async t => {
  const { stager } = await setup(t, { providerDirectory: '/app/provider path/' });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const webp = Buffer.alloc(12); webp.write('RIFF'); webp.writeUInt32LE(4, 4); webp.write('WEBP', 8);
  for (const [bytes, format] of [[gif, 'gif'], [png, 'png'], [jpeg, 'jpeg'], [webp, 'webp']] as const) {
    assert.equal((await stager.stage(bytes, format)).providerPath, `/app/provider path/${digest(bytes)}.${format}`);
  }
  const wrongSize = Buffer.from(webp); wrongSize.writeUInt32LE(90, 4);
  await assert.rejects(stager.stage(wrongSize, 'webp'), errorIs('storage_invalid_image'));
});

test('configuration rejects URLs, Windows paths, traversal, root, and invalid limits', () => {
  const base = { directory: '/tmp/owned', providerDirectory: '/app/owned' };
  for (const value of ['relative', '/', 'https://example.com/a', 'C:\\x', '/tmp/../etc', '/tmp/./x', '/tmp/x\0bad', '/tmp/a\\b']) {
    assert.throws(() => new SharedCustomFaceStaging({ ...base, directory: value }), errorIs('storage_configuration'));
    assert.throws(() => new SharedCustomFaceStaging({ ...base, providerDirectory: value }), errorIs('storage_configuration'));
  }
  for (const bad of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new SharedCustomFaceStaging({ ...base, maxBytes: bad }), errorIs('storage_configuration'));
    assert.throws(() => new SharedCustomFaceStaging({ ...base, maxFiles: bad }), errorIs('storage_configuration'));
  }
});

test('does not take over nonempty unmarked directories or touch their contents/mode', async t => {
  const { directory, stager } = await setup(t);
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  const existing = path.join(directory, 'unrelated.txt');
  await writeFile(existing, 'leave alone');
  await assert.rejects(stager.assertAvailable(), errorIs('storage_integrity'));
  assert.equal(await readFile(existing, 'utf8'), 'leave alone');
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(directory), ['unrelated.txt']);
});

test('rejects root and ancestor symlinks without writing through them', async t => {
  const { root, directory, stager } = await setup(t);
  const other = path.join(root, 'other'); await mkdir(other, { mode: 0o700 });
  await symlink(other, directory);
  await assert.rejects(stager.assertAvailable(), errorIs('storage_integrity'));
  await assert.rejects(new SharedCustomFaceStaging({ directory: path.join(directory, 'nested'), providerDirectory: '/safe' }).assertAvailable(), errorIs('storage_integrity'));
  assert.deepEqual(await readdir(other), []);
});

test('rejects unsafe non-sticky writable parent directories', async t => {
  const { root, stager } = await setup(t);
  await chmod(root, 0o777);
  await assert.rejects(stager.assertAvailable(), errorIs('storage_integrity'));
  assert.deepEqual(await readdir(root), []);
});

test('rejects asset symlinks and external hardlinks without deleting their targets', async t => {
  const { root, directory, stager } = await setup(t);
  await stager.assertAvailable();
  const outside = path.join(root, 'outside.gif'); await writeFile(outside, gif, { mode: 0o400 });
  const target = path.join(directory, `${digest(gif)}.gif`);
  await symlink(outside, target);
  await assert.rejects(stager.stage(gif, 'gif'), errorIs('storage_integrity'));
  await unlink(target); await link(outside, target);
  await assert.rejects(stager.stage(gif, 'gif'), errorIs('storage_integrity'));
  assert.deepEqual(await readFile(outside), gif);
  assert.equal((await stat(outside)).nlink, 2);
});

test('rejects marker hardlinks, forged/copied identity, and provider remapping', async t => {
  const { root, directory, stager, options } = await setup(t);
  await stager.assertAvailable();
  await assert.rejects(new SharedCustomFaceStaging({ ...options, providerDirectory: '/different' }).assertAvailable(), errorIs('storage_integrity'));
  await link(path.join(directory, MARKER), path.join(root, 'marker-copy'));
  await assert.rejects(stager.assertAvailable(), errorIs('storage_integrity'));
  await unlink(path.join(root, 'marker-copy'));
  const other = path.join(root, 'other'); await mkdir(other, { mode: 0o700 });
  await writeFile(path.join(other, MARKER), await readFile(path.join(directory, MARKER)), { mode: 0o400 });
  await assert.rejects(new SharedCustomFaceStaging({ ...options, directory: other }).assertAvailable(), errorIs('storage_integrity'));
});

test('rechecks hash and permissions of reused assets', async t => {
  const { directory, stager } = await setup(t);
  await stager.stage(gif, 'gif');
  const file = path.join(directory, `${digest(gif)}.gif`);
  await chmod(file, 0o644);
  await assert.rejects(stager.stage(gif, 'gif'), errorIs('storage_integrity'));
  await chmod(file, 0o600);
  await writeFile(file, Buffer.concat([gif.subarray(0, gif.length - 1), Buffer.from([0])]));
  await assert.rejects(stager.stage(gif, 'gif'), errorIs('storage_integrity'));
  assert.equal((await readdir(directory)).length, 2);
});

test('does not silently repair permissions or adopt replacement directory in the same instance', async t => {
  const { root, directory, stager } = await setup(t);
  await stager.assertAvailable();
  await chmod(directory, 0o755);
  await assert.rejects(stager.assertAvailable(), errorIs('storage_integrity'));
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  await chmod(directory, 0o700);
  await rename(directory, path.join(root, 'moved'));
  await mkdir(directory, { mode: 0o700 });
  await assert.rejects(stager.assertAvailable(), errorIs('storage_integrity'));
  assert.deepEqual(await readdir(directory), []);
});

test('startup cleans only own unpublished orphan temps including empty partial writes', async t => {
  const { directory, stager, options } = await setup(t);
  await stager.assertAvailable();
  const marker = JSON.parse(await readFile(path.join(directory, MARKER), 'utf8')) as { id: string };
  const tmp = `.tmp-${marker.id}-${digest(gif)}.gif-${randomUUID()}.tmp`;
  await writeFile(path.join(directory, tmp), Buffer.alloc(0), { mode: 0o600 });
  await new SharedCustomFaceStaging(options).assertAvailable();
  assert.deepEqual(await readdir(directory), [MARKER]);
});

test('startup completes an interrupted atomic publication without deleting the published original', async t => {
  const { directory, stager, options } = await setup(t);
  await stager.stage(gif, 'gif');
  const marker = JSON.parse(await readFile(path.join(directory, MARKER), 'utf8')) as { id: string };
  const file = path.join(directory, `${digest(gif)}.gif`);
  const tmp = `.tmp-${marker.id}-${digest(gif)}.gif-${randomUUID()}.tmp`;
  await link(file, path.join(directory, tmp));
  assert.equal((await stat(file)).nlink, 2);
  await new SharedCustomFaceStaging(options).assertAvailable();
  assert.equal((await stat(file)).nlink, 1);
  assert.deepEqual(await readFile(file), gif);
  assert.equal((await readdir(directory)).length, 2);
});

test('startup completes an interrupted marker publication', async t => {
  const { directory, stager, options } = await setup(t);
  await stager.assertAvailable();
  const marker = JSON.parse(await readFile(path.join(directory, MARKER), 'utf8')) as { id: string };
  const tmp = `.init-${marker.id}-${randomUUID()}.tmp`;
  await link(path.join(directory, MARKER), path.join(directory, tmp));
  await new SharedCustomFaceStaging(options).assertAvailable();
  assert.equal((await stat(path.join(directory, MARKER))).nlink, 1);
  assert.deepEqual(await readdir(directory), [MARKER]);
});

test('foreign temporary-looking files are never swept', async t => {
  const { directory, stager } = await setup(t);
  await stager.assertAvailable();
  const foreign = `.tmp-${randomUUID()}-${digest(gif)}.gif-${randomUUID()}.tmp`;
  await writeFile(path.join(directory, foreign), gif, { mode: 0o400 });
  await assert.rejects(stager.assertAvailable(), errorIs('storage_integrity'));
  assert.deepEqual(await readFile(path.join(directory, foreign)), gif);
});

test('managed directory entry enumeration is bounded and never sweeps unknown files', async t => {
  const { directory, stager } = await setup(t, { maxFiles: 1 });
  await stager.assertAvailable();
  await Promise.all(Array.from({ length: 65 }, (_, index) => writeFile(path.join(directory, `foreign-${index}`), 'x', { mode: 0o600 })));
  await assert.rejects(stager.assertAvailable(), errorIs('storage_capacity'));
  assert.equal((await readdir(directory)).length, 66);
});

test('filesystem failures never expose configured paths through errors', async t => {
  const { root, options } = await setup(t);
  const file = path.join(root, 'private-secret-path'); await writeFile(file, 'not a directory');
  await assert.rejects(new SharedCustomFaceStaging({ ...options, directory: path.join(file, 'child') }).assertAvailable(), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'storage_integrity');
    assert.equal(error.message.includes(root), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});
