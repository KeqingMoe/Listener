import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TelemetryStore } from '../../../src/observability/telemetry.js';
import { installRequestChangeLog } from '../../../src/observability/request-change-log.js';

function fixture(run: (path: string, store: TelemetryStore, db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'request-changes-'));
  const path = join(dir, 'telemetry.sqlite');
  const store = new TelemetryStore(path);
  const db = new DatabaseSync(path);
  try { run(path, store, db); } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
}
const meta = (db: DatabaseSync) => ({ ...db.prepare('SELECT * FROM request_change_meta').get()! });
const changes = (db: DatabaseSync) => db.prepare('SELECT * FROM request_changes ORDER BY revision').all().map(row => ({ ...row }));
const usageInsert = `INSERT INTO model_requests(request_id,group_id,started_at,ended_at,duration_ms,transport,model,status) VALUES('u','a',1,2,1,'chat','model','success')`;

test('six triggers capture INSERT/UPDATE/DELETE, old/new groups and keys without payload', () => fixture((_path, _store, db) => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger'").get()!.n, 6);
  db.exec(`BEGIN; ${usageInsert};
    UPDATE model_requests SET request_id='u2',group_id='b',input_tokens=777 WHERE request_id='u';
    DELETE FROM model_requests WHERE request_id='u2';
    INSERT INTO model_request_inspections(request_id,group_id,request_json) VALUES('i',NULL,'private body');
    UPDATE model_request_inspections SET request_id='i2',group_id='c',response_json='private response' WHERE request_id='i';
    DELETE FROM model_request_inspections WHERE request_id='i2'; COMMIT;`);
  assert.deepEqual(changes(db), [
    [null, null, 'a', 'u'], ['a', 'u', 'b', 'u2'], ['b', 'u2', null, null],
    [null, null, null, 'i'], [null, 'i', 'c', 'i2'], ['c', 'i2', null, null],
  ].map((keys, i) => ({ revision: i + 1, old_group_id: keys[0], old_request_id: keys[1], new_group_id: keys[2], new_request_id: keys[3] })));
  assert.deepEqual(db.prepare('PRAGMA table_info(request_changes)').all().map(r => r.name), ['revision', 'old_group_id', 'old_request_id', 'new_group_id', 'new_request_id']);
  assert.equal(meta(db).revision, 6);
  assert.equal(meta(db).floor_revision, 0);
}));

test('ignored duplicate and rolled back transaction produce no phantom revision', () => fixture((_path, _store, db) => {
  db.exec(usageInsert);
  const before = meta(db);
  db.exec(usageInsert.replace('INSERT INTO', 'INSERT OR IGNORE INTO'));
  assert.deepEqual(meta(db), before);
  db.exec("BEGIN; UPDATE model_requests SET group_id='rolled-back'; DELETE FROM model_requests; ROLLBACK;");
  assert.deepEqual(meta(db), before);
  assert.equal(changes(db).length, 1);
}));

test('normal restart keeps epoch/revision and recovery is logged before new running row', () => fixture((path, store, db) => {
  store.beginRequest({ requestId: 'old', groupId: 'group', startedAt: Date.now(), transport: 'chat', model: 'model' });
  const before = meta(db);
  store.close();
  const reopened = new TelemetryStore(path);
  try {
    assert.deepEqual(meta(db), before);
    reopened.beginRequest({ requestId: 'new', startedAt: Date.now(), transport: 'chat', model: 'model' });
    assert.equal(meta(db).revision, 3);
    assert.equal(db.prepare("SELECT status FROM model_request_inspections WHERE request_id='old'").get()!.status, 'interrupted');
    assert.equal(changes(db)[1]!.old_request_id, 'old');
    assert.equal(changes(db)[1]!.new_request_id, 'old');
  } finally { reopened.close(); }
}));

test('retention is exactly last 50000; cursor equal to floor is resumable; rollback restores pruning', () => fixture((_path, _store, db) => {
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO model_request_inspections(request_id) VALUES(?)');
  for (let i = 0; i < 50_003; i++) insert.run(String(i));
  db.exec('COMMIT');
  const before = meta(db);
  assert.equal(before.revision, 50_003);
  assert.equal(before.floor_revision, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_changes WHERE revision>?').get(3)!.n, 50_000);
  assert.equal(db.prepare('SELECT MIN(revision) AS n FROM request_changes').get()!.n, 4);
  db.exec("BEGIN; DELETE FROM model_request_inspections WHERE request_id='0'; ROLLBACK;");
  assert.deepEqual(meta(db), before);
  assert.equal(db.prepare('SELECT MIN(revision) AS n FROM request_changes').get()!.n, 4);
  assert.equal(installRequestChangeLog(db), true);
  assert.deepEqual(meta(db), before);
}));

for (const defect of ['trigger', 'log', 'hole', 'wrong-trigger', 'meta'] as const) {
  test(`incomplete ${defect} installation resets epoch atomically and preserves usage`, () => fixture((_path, _store, db) => {
    db.exec(usageInsert);
    const before = meta(db);
    if (defect === 'trigger') db.exec('DROP TRIGGER request_changes_model_requests_update');
    if (defect === 'log') db.exec('DROP TABLE request_changes');
    if (defect === 'hole') db.exec('DELETE FROM request_changes WHERE revision=1');
    if (defect === 'meta') db.exec('UPDATE request_change_meta SET schema_version=0');
    if (defect === 'wrong-trigger') db.exec(`DROP TRIGGER request_changes_model_requests_update;
      CREATE TRIGGER request_changes_model_requests_update AFTER UPDATE ON model_requests BEGIN SELECT 1; END;`);
    assert.equal(installRequestChangeLog(db), true);
    assert.notEqual(meta(db).epoch, before.epoch);
    assert.equal(meta(db).revision, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()!.n, 1);
    db.exec("UPDATE model_requests SET group_id='new'");
    assert.equal(meta(db).revision, 1);
  }));
}

test('missing source invalidates metadata and removes log triggers without disabling usage', () => fixture((_path, _store, db) => {
  db.exec('DROP TABLE model_request_inspections');
  assert.equal(installRequestChangeLog(db), false);
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='request_change_meta'").get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger'").get()!.n, 0);
  assert.doesNotThrow(() => db.exec(usageInsert));
}));

test('failed rebuilding invalidates old valid-looking metadata and leaves usage writable', () => fixture((_path, _store, db) => {
  db.exec('DROP TABLE request_changes; CREATE VIEW request_changes AS SELECT 1 AS revision');
  assert.equal(installRequestChangeLog(db), false);
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='request_change_meta'").get(), undefined);
  assert.doesNotThrow(() => db.exec(usageInsert));
}));

test('inspection retention deletes emit dirty keys', () => fixture((_path, store, db) => {
  db.prepare('INSERT INTO model_request_inspections(request_id,group_id,started_at,status) VALUES(?,?,?,?)').run('expired', 'old-group', 1, 'success');
  store.beginRequest({ requestId: 'live', startedAt: Date.now(), transport: 'chat', model: 'model' });
  const rows = changes(db);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2], { revision: 3, old_group_id: 'old-group', old_request_id: 'expired', new_group_id: null, new_request_id: null });
}));

test('TelemetryStore completion logs upsert and ignored duplicate keeps old semantics', () => fixture((_path, store, db) => {
  const value = { requestId: 'one', groupId: 'g', startedAt: Date.now(), transport: 'chat' as const, model: 'model' };
  store.beginRequest(value);
  const end = { ...value, endedAt: value.startedAt + 1, durationMs: 1, status: 'success' as const, usage: { inputTokens: 10 } };
  store.record(end);
  assert.equal(meta(db).revision, 3);
  store.record(end);
  assert.equal(meta(db).revision, 3);
  assert.equal(store.summarize({ since: 0, until: Date.now() + 100 }).inputTokens, 10);
}));
