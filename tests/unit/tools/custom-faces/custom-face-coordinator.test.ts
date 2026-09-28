import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CustomFaceCoordinator } from '../../../../src/tools/custom-faces/coordinator.js';
import { CustomFaceStore } from '../../../../src/tools/custom-faces/store.js';
const ACCOUNT = '123456789', OTHER = '100000001';
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const fixture = () => { const directory = mkdtempSync(join(tmpdir(), 'custom-face-journal-test-')); return { directory, path: join(directory, 'operations.sqlite'), clean: () => rmSync(directory, { recursive: true, force: true }) }; };

test('pending dispatch is committed before external work and recovers as unknown after reopen', t => {
  const f = fixture(); t.after(f.clean);
  const first = new CustomFaceCoordinator({ path: f.path });
  const id = first.begin(ACCOUNT, [key('picture')], 'add');
  const inspect = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(inspect.prepare('SELECT state FROM custom_face_operations WHERE id=?').get(id)?.state, 'pending'); inspect.close(); first.close();
  const next = new CustomFaceCoordinator({ path: f.path }); t.after(() => next.close());
  assert.throws(() => next.assertAllowed(ACCOUNT, [key('picture')]), /previous_operation_unresolved/);
  const check = new DatabaseSync(f.path, { readOnly: true }); assert.equal(check.prepare('SELECT state FROM custom_face_operations WHERE id=?').get(id)?.state, 'unknown'); check.close();
  assert.doesNotThrow(() => next.assertAllowed(ACCOUNT, [key('unrelated')]));
  assert.doesNotThrow(() => next.assertAllowed(OTHER, [key('picture')]));
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test('normally submitted but unbound add retains a persistent hold, not a retryable done marker', t => {
  const f = fixture(); t.after(f.clean);
  const first = new CustomFaceCoordinator({ path: f.path });
  const id = first.begin(ACCOUNT, [key('content')], 'add'); first.settle(id, 'hold'); first.close();
  const next = new CustomFaceCoordinator({ path: f.path }); t.after(() => next.close());
  assert.throws(() => next.begin(ACCOUNT, [key('content')], 'add'), /previous_operation_unresolved/);
  const unrelated = next.begin(ACCOUNT, [key('different')], 'description'); next.settle(unrelated, 'done');
  assert.throws(() => next.assertAllowed(ACCOUNT, [key('content')]), /previous_operation_unresolved/);
});

test('settled normal writes allow independent explicit interactions rather than caching successful sends', () => {
  const c = new CustomFaceCoordinator();
  try {
    const first = c.begin(ACCOUNT, [key('x')], 'send'); c.settle(first, 'done');
    const second = c.begin(ACCOUNT, [key('x')], 'send'); assert.notEqual(first, second); c.settle(second, 'done');
    assert.doesNotThrow(() => c.assertAllowed(ACCOUNT, [key('x')]));
  } finally { c.close(); }
});

test('aliases intersect across phases and preserve unknown writes across fresh instances', t => {
  const f = fixture(); t.after(f.clean);
  const first = new CustomFaceCoordinator({ path: f.path });
  const id = first.begin(ACCOUNT, [key('content'), key('resource')], 'delete'); first.settle(id, 'unknown'); first.close();
  const second = new CustomFaceCoordinator({ path: f.path }); t.after(() => second.close());
  assert.throws(() => second.begin(ACCOUNT, [key('content')], 'add'), /previous_operation_unresolved/);
  assert.throws(() => second.begin(ACCOUNT, [key('resource')], 'send'), /previous_operation_unresolved/);
});

test('foreign SQLite and the face index are rejected without chmod or data mutation', t => {
  const f = fixture(); t.after(f.clean);
  const db = new DatabaseSync(f.path); db.exec('CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES (\'do-not-change\')'); db.close();
  chmodSync(f.path, 0o640); const original = readFileSync(f.path);
  assert.throws(() => new CustomFaceCoordinator({ path: f.path }), /identity_mismatch/);
  assert.deepEqual(readFileSync(f.path), original); assert.equal(statSync(f.path).mode & 0o777, 0o640);
  const index = join(f.directory, 'index.sqlite'); const store = new CustomFaceStore({ path: index }); store.close();
  assert.throws(() => new CustomFaceCoordinator({ path: index }), /identity_mismatch/);
});

test('symlinks, hardlinks and linked sidecars cannot redirect the journal', t => {
  const f = fixture(); t.after(f.clean);
  const real = join(f.directory, 'real.sqlite'), c = new CustomFaceCoordinator({ path: real }); c.close();
  const before = readFileSync(real);
  const symbolic = join(f.directory, 'symbolic.sqlite'); symlinkSync(real, symbolic);
  assert.throws(() => new CustomFaceCoordinator({ path: symbolic }));
  const hard = join(f.directory, 'hard.sqlite'); linkSync(real, hard);
  assert.throws(() => new CustomFaceCoordinator({ path: hard }), /unsafe_operation_store/);
  const side = f.path + '-journal'; symlinkSync(real, side);
  assert.throws(() => new CustomFaceCoordinator({ path: f.path }), /unsafe_operation_store/);
  assert.equal(existsSync(f.path), false); assert.deepEqual(readFileSync(real), before);
});

test('file mode is tightened only for a correctly identified existing journal', t => {
  const f = fixture(); t.after(f.clean);
  const first = new CustomFaceCoordinator({ path: f.path }); first.close(); chmodSync(f.path, 0o644);
  const second = new CustomFaceCoordinator({ path: f.path }); t.after(() => second.close());
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test('per-account queue serializes native work while other accounts continue', async () => {
  const c = new CustomFaceCoordinator();
  try {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const events: string[] = [];
    const a = c.run(ACCOUNT, async () => { events.push('a'); await gate; events.push('a-end'); });
    const b = c.run(ACCOUNT, async () => { events.push('b'); });
    const other = c.run(OTHER, async () => { events.push('other'); });
    await other; assert.deepEqual(events, ['a', 'other']); release(); await Promise.all([a, b]); assert.deepEqual(events, ['a', 'other', 'a-end', 'b']);
  } finally { c.close(); }
});

test('normal add holds reconcile only with exact content plus original SHA proofs and survive restart', t => {
  const f = fixture(); t.after(f.clean);
  const proofs = [key('content'), key('original-sha')];
  const first = new CustomFaceCoordinator({ path: f.path });
  const id = first.begin(ACCOUNT, proofs, 'add'); first.settle(id, 'hold'); first.close();
  const next = new CustomFaceCoordinator({ path: f.path }); t.after(() => next.close());
  assert.deepEqual(next.recoverableAddHolds(ACCOUNT, proofs), [id]);
  assert.throws(() => next.recoverableAddHolds(ACCOUNT, [proofs[0]!, key('different-original-sha')]), /previous_operation_unresolved/);
  assert.throws(() => next.completeRecoveredAddHolds(ACCOUNT, proofs, ['wrong-id']), /previous_operation_unresolved/);
  assert.throws(() => next.completeRecoveredAddHolds(OTHER, proofs, [id]), /previous_operation_unresolved/);
  assert.throws(() => next.assertAllowed(ACCOUNT, [proofs[0]!]), /previous_operation_unresolved/);
  next.completeRecoveredAddHolds(ACCOUNT, proofs, [id]);
  assert.doesNotThrow(() => next.assertAllowed(ACCOUNT, [proofs[0]!]));
});

test('pending, unknown, legacy MD5-only and non-add holds cannot be auto-reconciled', () => {
  const proofs = [key('content'), key('original')];
  for (const item of [ { phase: 'add', state: 'pending', keys: proofs }, { phase: 'add', state: 'unknown', keys: proofs }, { phase: 'add', state: 'hold', keys: [proofs[0]!] }, { phase: 'delete', state: 'hold', keys: proofs } ] as const) {
    const c = new CustomFaceCoordinator();
    try {
      const id = c.begin(ACCOUNT, item.keys, item.phase);
      if (item.state !== 'pending') c.settle(id, item.state);
      assert.throws(() => c.recoverableAddHolds(ACCOUNT, proofs), /previous_operation_unresolved/);
      assert.throws(() => c.completeRecoveredAddHolds(ACCOUNT, proofs, [id]), /previous_operation_unresolved/);
      assert.throws(() => c.assertAllowed(ACCOUNT, [proofs[0]!]), /previous_operation_unresolved/);
    } finally { c.close(); }
  }
});

test('recovery CAS cannot clear a hold that changed to unknown during readonly proof gathering', () => {
  const c = new CustomFaceCoordinator(), proofs = [key('content'), key('original')];
  try {
    const id = c.begin(ACCOUNT, proofs, 'add'); c.settle(id, 'hold');
    const observed = c.recoverableAddHolds(ACCOUNT, proofs); c.settle(id, 'unknown');
    assert.throws(() => c.completeRecoveredAddHolds(ACCOUNT, proofs, observed), /previous_operation_unresolved/);
    assert.throws(() => c.assertAllowed(ACCOUNT, [proofs[0]!]), /previous_operation_unresolved/);
  } finally { c.close(); }
});

test('add and description phase receipts remain separately recorded', t => {
  const f = fixture(); t.after(f.clean); const c = new CustomFaceCoordinator({ path: f.path }); t.after(() => c.close());
  const one = c.begin(ACCOUNT, [key('content'), key('original')], 'add'); c.settle(one, 'done');
  const two = c.begin(ACCOUNT, [key('content'), key('resource')], 'description'); c.settle(two, 'unknown');
  const db = new DatabaseSync(f.path, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT phase,state FROM custom_face_operations ORDER BY rowid').all().map(r => ({ ...r })), [{ phase: 'add', state: 'done' }, { phase: 'description', state: 'unknown' }]); db.close();
});

test('closed or malformed scopes fail closed before journal writes', () => {
  const c = new CustomFaceCoordinator();
  assert.throws(() => c.begin('0', [key('x')], 'add'));
  assert.throws(() => c.begin(ACCOUNT, [], 'add'));
  assert.throws(() => c.begin(ACCOUNT, ['native-URL-or-ID'], 'add'));
  c.close(); assert.throws(() => c.assertAllowed(ACCOUNT, [key('x')]));
});
