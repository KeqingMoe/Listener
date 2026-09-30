import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CustomFaceStore, type CustomFaceInput } from '../../../../src/tools/custom-faces/store.ts';

const ACCOUNT = '10001', OTHER_ACCOUNT = '10002', GROUP = '20001', OTHER_GROUP = '20002';
const HASH = 'a'.repeat(32), OTHER_HASH = 'b'.repeat(32);
const row = (resId = 'native_resource_one', overrides: Partial<CustomFaceInput> = {}): CustomFaceInput => ({ resId, emoId: 21, md5: HASH, description: '白猫翻白眼，表示无语', ...overrides });
function disk(): { dir: string; path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-custom-face-store-test-'));
  return { dir, path: join(dir, 'favorites.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('defaults to an in-memory metadata index and returns no raw native identifiers', () => {
  const store = new CustomFaceStore();
  try {
    assert.deepEqual(store.sync(ACCOUNT, [row()]), { observed: 1, upserted: 1 });
    const page = store.list(ACCOUNT, GROUP);
    assert.equal(page.coverage, 'observed_prefix');
    assert.equal(page.snapshot_count, 1);
    assert.equal(page.stale_omitted, 0);
    assert.equal(page.next_cursor, undefined);
    assert.deepEqual(Object.keys(page.items[0]!).sort(), ['description', 'face_ref', 'revision', 'tags']);
    assert.equal(JSON.stringify(page).includes('native_resource_one'), false);
    assert.equal(JSON.stringify(page).includes(HASH), false);
    assert.deepEqual(store.resolve(page.items[0]!.face_ref, ACCOUNT, GROUP), { accountId: ACCOUNT, resId: 'native_resource_one', emoId: 21, md5: HASH, description: row().description, tags: [], revision: 1, retired: false });
  } finally { store.close(); }
});

test('shared account resources issue separate group capabilities and reject guessed or cross-account references', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row()]); store.sync(OTHER_ACCOUNT, [row()]);
    const first = store.issue(ACCOUNT, GROUP, row().resId)!;
    const otherGroup = store.issue(ACCOUNT, OTHER_GROUP, row().resId)!;
    assert.notEqual(first, otherGroup);
    assert.equal(store.resolve(first, ACCOUNT, OTHER_GROUP), undefined);
    assert.equal(store.resolve(first, OTHER_ACCOUNT, GROUP), undefined);
    assert.equal(store.resolve(first.replace(/.$/, first.endsWith('0') ? '1' : '0'), ACCOUNT, GROUP), undefined);
    assert.equal(store.resolve('cf_1', ACCOUNT, GROUP), undefined);
    assert.equal(store.resolve(otherGroup, ACCOUNT, OTHER_GROUP)?.resId, row().resId);
    assert.equal(store.list(ACCOUNT, GROUP).items.length, 1);
    assert.equal(store.list(OTHER_ACCOUNT, GROUP).items.length, 1);
  } finally { store.close(); }
});

test('native emoId is a canonical safe integer, not a market eId or a lossy coercion', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row('zero', { emoId: '0' }), row('maximum', { emoId: String(Number.MAX_SAFE_INTEGER), md5: HASH.toUpperCase() })]);
    assert.equal(store.get(ACCOUNT, 'zero')?.emoId, 0);
    assert.equal(store.get(ACCOUNT, 'maximum')?.emoId, Number.MAX_SAFE_INTEGER);
    assert.equal(store.get(ACCOUNT, 'maximum')?.md5, HASH);
    for (const value of [-1, -0, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1, '01', '+1', ' 1', '1 ', '1e2', '1.0', '9007199254740992', HASH, null, undefined]) {
      assert.throws(() => store.sync(ACCOUNT, [row('bad', { emoId: value as number })]), /invalid_emoji_id/);
    }
    assert.equal(store.get(ACCOUNT, 'bad'), undefined);
  } finally { store.close(); }
});

test('sync only upserts observed entries and does not merge two resources with the same md5', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row('a'), row('b')]);
    const a = store.issue(ACCOUNT, GROUP, 'a')!, b = store.issue(ACCOUNT, GROUP, 'b')!;
    assert.notEqual(a, b);
    assert.deepEqual(store.sync(ACCOUNT, []), { observed: 0, upserted: 0 });
    assert.deepEqual(store.sync(ACCOUNT, [row('a')]), { observed: 1, upserted: 0 });
    assert.equal(store.resolve(a, ACCOUNT, GROUP)?.resId, 'a');
    assert.equal(store.resolve(b, ACCOUNT, GROUP)?.resId, 'b');
    assert.equal(store.list(ACCOUNT, GROUP).snapshot_count, 2);
  } finally { store.close(); }
});

test('metadata identity changes invalidate old handles without affecting another account', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row()]); store.sync(OTHER_ACCOUNT, [row()]);
    const before = store.issue(ACCOUNT, GROUP, row().resId)!;
    const other = store.issue(OTHER_ACCOUNT, GROUP, row().resId)!;
    store.sync(ACCOUNT, [row(undefined, { md5: OTHER_HASH, emoId: 22 })]);
    assert.equal(store.resolve(before, ACCOUNT, GROUP), undefined);
    assert.equal(store.get(ACCOUNT, row().resId)?.revision, 2);
    assert.equal(store.resolve(other, OTHER_ACCOUNT, GROUP)?.revision, 1);
    assert.equal(store.retire(ACCOUNT, row().resId, HASH), false);
    assert.equal(store.retire(ACCOUNT, row().resId, OTHER_HASH, 1), false);
  } finally { store.close(); }
});

test('submitted deletion creates a local tombstone across groups, and late sync cannot resurrect it', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row()]);
    const first = store.issue(ACCOUNT, GROUP, row().resId)!, second = store.issue(ACCOUNT, OTHER_GROUP, row().resId)!;
    assert.equal(store.retire(ACCOUNT, row().resId, HASH, 1), true);
    assert.equal(store.get(ACCOUNT, row().resId)?.retired, true);
    assert.equal(store.get(ACCOUNT, row().resId)?.revision, 2);
    assert.equal(store.resolve(first, ACCOUNT, GROUP), undefined);
    assert.equal(store.resolve(second, ACCOUNT, OTHER_GROUP), undefined);
    assert.equal(store.issue(ACCOUNT, GROUP, row().resId), undefined);
    assert.equal(store.list(ACCOUNT, GROUP).items.length, 0);
    assert.deepEqual(store.sync(ACCOUNT, [row()]), { observed: 1, upserted: 0 });
    assert.equal(store.get(ACCOUNT, row().resId)?.retired, true);
    assert.equal(store.retire(ACCOUNT, row().resId, HASH), false);
  } finally { store.close(); }
});

test('verified re-addition rotates the revision and never revives the previous reference', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row()]); const old = store.issue(ACCOUNT, GROUP, row().resId)!;
    store.retire(ACCOUNT, row().resId, HASH);
    const added = store.revive(ACCOUNT, row());
    assert.equal(added.revision, 3); assert.equal(added.retired, false);
    assert.equal(store.resolve(old, ACCOUNT, GROUP), undefined);
    const current = store.reference(ACCOUNT, GROUP, row().resId)!;
    assert.notEqual(current, old);
    assert.equal(store.resolve(current, ACCOUNT, GROUP)?.revision, 3);
  } finally { store.close(); }
});

test('local tags do not overwrite the QQ caption and external caption changes discard stale tags', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row()]);
    assert.equal(store.setLocalTags(ACCOUNT, row().resId, ['无奈', ' Ａ ', 'A'], 1), true);
    const tagged = store.get(ACCOUNT, row().resId)!;
    assert.equal(tagged.description, row().description);
    assert.deepEqual(tagged.tags, ['无奈', 'A']);
    assert.equal(store.list(ACCOUNT, GROUP, { query: '无奈' }).items.length, 1);
    assert.equal(store.list(ACCOUNT, GROUP, { query: 'ａ' }).items.length, 1);
    store.sync(ACCOUNT, [row()]);
    assert.deepEqual(store.get(ACCOUNT, row().resId)?.tags, ['无奈', 'A']);
    store.sync(ACCOUNT, [row(undefined, { description: '新的QQ说明' })]);
    assert.deepEqual(store.get(ACCOUNT, row().resId)?.tags, []);
    assert.equal(store.list(ACCOUNT, GROUP, { query: '无奈' }).items.length, 0);
  } finally { store.close(); }
});

test('confirmed description updates are compare-and-set and preserve no stale searchable hints', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row(undefined, { tags: ['旧标签'] })]);
    const ref = store.issue(ACCOUNT, GROUP, row().resId)!;
    assert.equal(store.updateDescription(ACCOUNT, row().resId, '新说明', 999), false);
    assert.equal(store.updateDescription(ACCOUNT, row().resId, '新说明', 1), true);
    assert.deepEqual(store.get(ACCOUNT, row().resId)?.tags, []);
    assert.equal(store.resolve(ref, ACCOUNT, GROUP), undefined);
    assert.equal(store.get(ACCOUNT, row().resId)?.revision, 2);
    assert.equal(store.updateDescription(ACCOUNT, row().resId, '新说明', 2), true);
    assert.equal(store.get(ACCOUNT, row().resId)?.revision, 2);
    assert.equal(store.setLocalTags(ACCOUNT, row().resId, ['错误版本'], 1), false);
    store.retire(ACCOUNT, row().resId, HASH);
    assert.equal(store.updateDescription(ACCOUNT, row().resId, '不应复活'), false);
    assert.equal(store.setLocalTags(ACCOUNT, row().resId, ['不应复活']), false);
  } finally { store.close(); }
});

test('local snapshots remain ordered despite inserted rows and omit retired or changed members', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, ['a', 'c', 'd', 'e'].map(id => row(id, { description: id })));
    const first = store.list(ACCOUNT, GROUP, { limit: 1 });
    assert.equal(first.items[0]?.description, 'a'); assert.equal(first.snapshot_count, 4);
    store.sync(ACCOUNT, [row('b', { description: 'b' })]);
    store.retire(ACCOUNT, 'c', HASH);
    store.updateDescription(ACCOUNT, 'd', 'changed');
    const next = store.list(ACCOUNT, GROUP, { limit: 2, cursor: first.next_cursor });
    assert.deepEqual(next.items.map(item => item.description), ['e']);
    assert.equal(next.snapshot_count, 4); assert.equal(next.stale_omitted, 2); assert.equal(next.next_cursor, undefined);
    assert.deepEqual(store.list(ACCOUNT, GROUP).items.map(item => item.description), ['a', 'b', 'changed', 'e']);
  } finally { store.close(); }
});

test('cursor is authenticated to account, group, query and position', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, ['a', 'b', 'c'].map(id => row(id)));
    const page = store.list(ACCOUNT, GROUP, { query: '猫', limit: 1 });
    assert.ok(page.next_cursor);
    assert.throws(() => store.list(ACCOUNT, OTHER_GROUP, { cursor: page.next_cursor }), /invalid_cursor/);
    assert.throws(() => store.list(OTHER_ACCOUNT, GROUP, { cursor: page.next_cursor }), /invalid_cursor/);
    assert.throws(() => store.list(ACCOUNT, GROUP, { cursor: page.next_cursor, query: '狗' }), /invalid_cursor/);
    assert.throws(() => store.list(ACCOUNT, GROUP, { cursor: page.next_cursor!.replace('_1_', '_2_') }), /invalid_cursor/);
    assert.equal(store.list(ACCOUNT, GROUP, { cursor: page.next_cursor, query: ' 猫 ', limit: 2 }).items.length, 2);
    assert.equal(store.list(ACCOUNT, GROUP, { query: '%' }).items.length, 0);
    assert.equal(store.list(ACCOUNT, GROUP, { query: "' OR 1=1 --" }).items.length, 0);
  } finally { store.close(); }
});

test('references and cursors survive restart without persisting any transport material', () => {
  const fixture = disk(); let store: CustomFaceStore | undefined;
  try {
    store = new CustomFaceStore({ path: fixture.path });
    store.sync(ACCOUNT, [row('a'), row('b')]);
    const first = store.list(ACCOUNT, GROUP, { limit: 1 }); const ref = first.items[0]!.face_ref;
    store.close();
    assert.equal(statSync(fixture.path).mode & 0o777, 0o600);
    chmodSync(fixture.path, 0o644);
    store = new CustomFaceStore({ path: fixture.path });
    assert.equal(statSync(fixture.path).mode & 0o777, 0o600);
    assert.equal(store.resolve(ref, ACCOUNT, GROUP)?.resId, 'a');
    assert.equal(store.list(ACCOUNT, GROUP, { cursor: first.next_cursor }).items.length, 1);
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(custom_faces)').all().map(value => value.name);
      assert.deepEqual(columns, ['account_id', 'res_id', 'resource_id', 'emo_id', 'md5', 'description', 'tags', 'revision', 'retired']);
    } finally { db.close(); }
  } finally { store?.close(); fixture.cleanup(); }
});

test('tombstones survive restart and do not turn an observed stale row into a fresh resource', () => {
  const fixture = disk(); let store: CustomFaceStore | undefined;
  try {
    store = new CustomFaceStore({ path: fixture.path }); store.sync(ACCOUNT, [row()]);
    const ref = store.issue(ACCOUNT, GROUP, row().resId)!;
    store.retire(ACCOUNT, row().resId, HASH); store.close();
    store = new CustomFaceStore({ path: fixture.path }); store.sync(ACCOUNT, [row()]);
    assert.equal(store.resolve(ref, ACCOUNT, GROUP), undefined);
    assert.equal(store.get(ACCOUNT, row().resId)?.retired, true);
    store.revive(ACCOUNT, row());
    assert.equal(store.resolve(ref, ACCOUNT, GROUP), undefined);
  } finally { store?.close(); fixture.cleanup(); }
});

test('a different index cannot accept another index reference even with identical account rows', () => {
  const first = new CustomFaceStore(), second = new CustomFaceStore();
  try {
    first.sync(ACCOUNT, [row()]); second.sync(ACCOUNT, [row()]);
    assert.equal(second.resolve(first.issue(ACCOUNT, GROUP, row().resId)!, ACCOUNT, GROUP), undefined);
  } finally { first.close(); second.close(); }
});

test('foreign group database identity is rejected before chmod or schema mutation', () => {
  const fixture = disk();
  try {
    const db = new DatabaseSync(fixture.path); db.exec("CREATE TABLE world_identity(singleton INTEGER PRIMARY KEY,group_id TEXT); INSERT INTO world_identity VALUES(1,'20001')"); db.close();
    chmodSync(fixture.path, 0o644); const before = readFileSync(fixture.path);
    assert.throws(() => new CustomFaceStore({ path: fixture.path }), /identity_mismatch/);
    assert.deepEqual(readFileSync(fixture.path), before);
    assert.equal(statSync(fixture.path).mode & 0o777, 0o644);
  } finally { fixture.cleanup(); }
});

test('symlinks, hardlinks and symlink sidecars are refused without touching the target', () => {
  const fixture = disk();
  try {
    const store = new CustomFaceStore({ path: fixture.path }); store.close();
    const targetBefore = readFileSync(fixture.path);
    const symlink = join(fixture.dir, 'symlink.sqlite'); symlinkSync(fixture.path, symlink);
    assert.throws(() => new CustomFaceStore({ path: symlink }), /store_unavailable|unsafe_store_file/);
    const hardlink = join(fixture.dir, 'hardlink.sqlite'); linkSync(fixture.path, hardlink);
    assert.throws(() => new CustomFaceStore({ path: hardlink }), /unsafe_store_file/);
    rmSync(hardlink);
    symlinkSync(fixture.path, fixture.path + '-wal');
    assert.throws(() => new CustomFaceStore({ path: fixture.path }), /unsafe_store_file/);
    assert.deepEqual(readFileSync(fixture.path), targetBefore);
  } finally { fixture.cleanup(); }
});

test('metadata validation is all-or-nothing and rejects transport fields, getters and proxies', () => {
  const store = new CustomFaceStore(); let accessed = false;
  try {
    const getter = { ...row('bad') };
    Object.defineProperty(getter, 'description', { enumerable: true, get: () => { accessed = true; return 'bad'; } });
    for (const bad of [
      { ...row('bad'), url: 'https://example.invalid/private?token=secret' },
      { ...row('bad'), file: '/private/file.gif' },
      { ...row('bad'), key: 'secret' },
      { ...row('bad'), md5: 'bad' },
      { ...row('bad'), resId: '/private/file.gif' },
      getter,
      new Proxy(row('bad'), { get: () => { accessed = true; throw new Error('should not run'); } }),
    ]) {
      assert.throws(() => store.sync(ACCOUNT, [row('good'), bad as CustomFaceInput]), /custom_face_/);
      assert.equal(store.get(ACCOUNT, 'good'), undefined);
    }
    assert.equal(accessed, false);
    assert.throws(() => store.sync(ACCOUNT, [row(), row()]), /duplicate_resource/);
    assert.equal(store.list(ACCOUNT, GROUP).snapshot_count, 0);
  } finally { store.close(); }
});

test('query, limits, scope, sparse arrays and oversized fields fail closed', () => {
  const store = new CustomFaceStore();
  try {
    for (const limit of [0, -1, 101, NaN, Infinity, 1.5]) assert.throws(() => store.list(ACCOUNT, GROUP, { limit }), /invalid_limit/);
    for (const id of ['', '0', '01', '../1', '1\n']) assert.throws(() => store.list(id, GROUP), /invalid_scope/);
    assert.throws(() => store.list(ACCOUNT, GROUP, { query: 'x'.repeat(513) }), /invalid_query/);
    assert.throws(() => store.sync(ACCOUNT, new Array(2)), /invalid_metadata/);
    assert.throws(() => store.sync(ACCOUNT, [row(undefined, { description: 'x'.repeat(2049) })]), /invalid_description/);
    assert.throws(() => store.sync(ACCOUNT, [row(undefined, { tags: ['x'.repeat(129)] })]), /invalid_tags/);
    assert.throws(() => store.sync(ACCOUNT, [row(undefined, { tags: new Array(2) })]), /invalid_metadata/);
  } finally { store.close(); }
});

test('expired and evicted local cursors fail explicitly rather than silently changing pagination', () => {
  const fixture = disk(); let store: CustomFaceStore | undefined;
  try {
    store = new CustomFaceStore({ path: fixture.path }); store.sync(ACCOUNT, [row('a'), row('b')]);
    const expired = store.list(ACCOUNT, GROUP, { limit: 1 }).next_cursor!;
    const db = new DatabaseSync(fixture.path);
    try { db.prepare('UPDATE custom_face_snapshots SET created_at=?').run(Date.now() - 2 * 60 * 60 * 1000); } finally { db.close(); }
    assert.throws(() => store!.list(ACCOUNT, GROUP, { cursor: expired }), /invalid_cursor/);
    const old = store.list(ACCOUNT, GROUP, { limit: 1 }).next_cursor!;
    for (let i = 0; i < 130; i++) store.list(ACCOUNT, GROUP, { limit: 1 });
    assert.throws(() => store!.list(ACCOUNT, GROUP, { cursor: old }), /invalid_cursor/);
  } finally { store?.close(); fixture.cleanup(); }
});

test('snapshot churn in another group does not evict this group cursor', () => {
  const store = new CustomFaceStore();
  try {
    store.sync(ACCOUNT, [row('a'), row('b')]);
    const cursor = store.list(ACCOUNT, GROUP, { limit: 1 }).next_cursor!;
    for (let index = 0; index < 130; index++) store.list(ACCOUNT, OTHER_GROUP, { limit: 1 });
    assert.equal(store.list(ACCOUNT, GROUP, { cursor }).items.length, 1);
  } finally { store.close(); }
});

test('scope, native identifiers, hashes and signed tokens require exact strings including final line terminators', () => {
  const store = new CustomFaceStore();
  const suffixes = ['\n', '\r', '\r\n', '\u2028', '\u2029', '\t', ' '];
  try {
    store.sync(ACCOUNT, [row('a', { emoId: 0 }), row('b', { emoId: '0', md5: HASH.toUpperCase() })]);
    const first = store.list(ACCOUNT, GROUP, { limit: 1 });
    const ref = first.items[0]!.face_ref, cursor = first.next_cursor!;
    assert.equal(store.resolve(ref, ACCOUNT, GROUP)?.emoId, 0);
    assert.equal(store.get(ACCOUNT, 'b')?.md5, HASH);
    for (const suffix of suffixes) {
      assert.throws(() => store.sync(ACCOUNT, [row('bad', { emoId: '0' + suffix })]), /invalid_emoji_id/);
      assert.throws(() => store.sync(ACCOUNT, [row('bad', { md5: HASH + suffix })]), /invalid_md5/);
      assert.throws(() => store.sync(ACCOUNT, [row('bad' + suffix)]), /invalid_resource/);
      assert.throws(() => store.sync(ACCOUNT + suffix, [row('bad')]), /invalid_scope/);
      assert.throws(() => store.issue(ACCOUNT, GROUP + suffix, 'a'), /invalid_scope/);
      assert.throws(() => store.resolve(ref, ACCOUNT + suffix, GROUP), /invalid_scope/);
      assert.throws(() => store.resolve(ref, ACCOUNT, GROUP + suffix), /invalid_scope/);
      assert.equal(store.resolve(ref + suffix, ACCOUNT, GROUP), undefined);
      assert.throws(() => store.list(ACCOUNT, GROUP, { cursor: cursor + suffix }), /invalid_cursor/);
      assert.throws(() => store.retire(ACCOUNT, 'a', HASH + suffix), /invalid_md5/);
    }
    assert.equal(store.get(ACCOUNT, 'bad'), undefined);
    assert.equal(store.resolve(ref, ACCOUNT, GROUP)?.retired, false);
    assert.equal(store.list(ACCOUNT, GROUP, { cursor }).items.length, 1);
  } finally { store.close(); }
});

test('persistence identity rejects a signing secret with a final newline before chmod', () => {
  const fixture = disk();
  try {
    const store = new CustomFaceStore({ path: fixture.path }); store.close();
    const db = new DatabaseSync(fixture.path);
    try { db.exec('UPDATE custom_face_identity SET secret=secret||char(10)'); } finally { db.close(); }
    chmodSync(fixture.path, 0o644);
    const before = readFileSync(fixture.path);
    assert.throws(() => new CustomFaceStore({ path: fixture.path }), /identity_mismatch/);
    assert.equal(statSync(fixture.path).mode & 0o777, 0o644);
    assert.deepEqual(readFileSync(fixture.path), before);
  } finally { fixture.cleanup(); }
});

test('returned objects do not mutate stored metadata and closing is idempotent', () => {
  const store = new CustomFaceStore();
  store.sync(ACCOUNT, [row(undefined, { tags: ['原标签'] })]);
  const record = store.get(ACCOUNT, row().resId)!; record.tags.push('伪造'); record.description = '伪造';
  const page = store.list(ACCOUNT, GROUP); page.items[0]!.tags.push('伪造');
  assert.deepEqual(store.get(ACCOUNT, row().resId)?.tags, ['原标签']);
  assert.equal(store.get(ACCOUNT, row().resId)?.description, row().description);
  store.close(); store.close();
  assert.throws(() => store.list(ACCOUNT, GROUP), /store_closed/);
});
