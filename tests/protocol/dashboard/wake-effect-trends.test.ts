import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { EventOrigin } from '../../../src/contracts/visible-effect.ts';
import { WakeEffectWaitStore } from '../../../src/observability/wake-effect-waits.ts';
import {
  Repository,
  ResourceLimit,
} from '../../../src/dashboard/server/repository.ts';
import { wakeEffectTrends } from '../../../src/dashboard/server/wake-effect-trends.ts';
import { buildApp } from '../../../src/dashboard/server/app.ts';
import { AuthStore } from '../../../src/dashboard/server/auth.ts';

const range = { since: 0, until: 300 };
const origin = (
  turnId: string,
  groupId = '11',
  receivedAt = 100,
): EventOrigin => ({
  selfId: '1',
  groupId,
  turnId,
  receipt: { receivedAt, receivedMonotonic: 10 },
});

function fixture(mode: 'current' | 'old' | 'missing' = 'current') {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-wake-effects-'));
  const path = join(dir, 'telemetry.sqlite');
  const db = mode === 'missing' ? undefined : new DatabaseSync(path);
  db?.exec('CREATE TABLE model_requests(request_id TEXT)');
  const store = mode === 'current' ? new WakeEffectWaitStore(path) : undefined;
  if (store) {
    db!.exec('UPDATE wake_effect_wait_meta SET collection_started_at=50');
  }
  let groups = ['11', '22'].map((groupId) => ({
    groupId,
    sessionPath: join(dir, `session-${groupId}.sqlite`),
  }));
  const sources = { telemetryPath: path, getGroups: () => groups };
  const repository = new Repository(sources);
  return {
    dir,
    path,
    db,
    store,
    sources,
    repository,
    read: (groupId?: string, selected = range) =>
      wakeEffectTrends(repository, selected, groupId),
    revoke() {
      groups = [];
      repository.refreshGroups();
    },
    cleanup() {
      repository.close();
      store?.close();
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('missing and old sources remain read-only and explicitly uncollected', () => {
  for (const mode of ['old', 'missing'] as const) {
    const f = fixture(mode);
    try {
      const before = f.db
        ?.prepare('SELECT name FROM sqlite_schema ORDER BY name')
        .all();
      const result = f.read();
      assert.equal(result.availability.telemetry, mode === 'old');
      assert.equal(result.collectionStartedAt, null);
      assert.deepEqual(result.points, []);
      assert.equal(existsSync(f.path), mode !== 'missing');
      assert.deepEqual(
        f.db?.prepare('SELECT name FROM sqlite_schema ORDER BY name').all(),
        before,
      );
    } finally {
      f.cleanup();
    }
  }
});

test('wake samples use receipt time, explicit confirmation and monotonic wait, not requests or wall differences', () => {
  const f = fixture();
  try {
    for (const [id, receivedAt] of [
      ['confirmed', 100],
      ['zero', 110],
      ['silent', 120],
      ['interrupted', 130],
      ['pending', 140],
    ] as const) {
      f.store!.begin(origin(id, '11', receivedAt), 1000);
    }
    f.store!.confirm(origin('confirmed'), {
      kind: 'message_sent',
      confirmedAt: 90,
      confirmedMonotonic: 22.5,
    });
    f.store!.confirm(origin('zero', '11', 110), {
      kind: 'message_sent',
      confirmedAt: 115,
      confirmedMonotonic: 10,
    });
    f.store!.finish(origin('silent', '11', 120), 'silent', 200);
    f.db!.exec(
      "UPDATE wake_effect_waits SET wake_outcome='interrupted' WHERE turn_id='interrupted'",
    );
    const result = f.read();
    assert.equal(result.collectionStartedAt, 50);
    assert.deepEqual(
      result.points.map((p) => [p.receivedAt, p.firstEffectWaitMs, p.outcome]),
      [
        [100, 12.5, 'confirmed'],
        [110, 0, 'confirmed'],
        [120, null, 'unconfirmed'],
        [130, null, 'interrupted'],
        [140, null, 'pending'],
      ],
    );
    assert.equal(result.points[0]!.key, JSON.stringify(['11', 'confirmed']));
    assert.equal(f.read('11', { since: 100, until: 100 }).points.length, 1);
    assert.equal(f.read('11', { since: 141, until: 1000 }).points.length, 0);
    assert.throws(() =>
      f.repository.telemetry()!.exec('CREATE TABLE forbidden(x)'),
    );
  } finally {
    f.cleanup();
  }
});

test('late confirmation updates the original finished wake without creating another sample', () => {
  const f = fixture();
  try {
    const first = origin('first');
    f.store!.begin(first, 101);
    f.store!.finish(first, 'silent', 105);
    f.store!.begin(origin('second'), 106);
    assert.equal(
      f.read().points.find((p) => p.key.includes('first'))!.outcome,
      'unconfirmed',
    );
    f.store!.confirm(first, {
      kind: 'message_sent',
      confirmedAt: 120,
      confirmedMonotonic: 30,
    });
    const points = f.read().points;
    assert.equal(points.length, 2);
    assert.equal(
      points.find((p) => p.key.includes('first'))!.firstEffectWaitMs,
      20,
    );
    assert.equal(
      points.find((p) => p.key.includes('second'))!.outcome,
      'pending',
    );
  } finally {
    f.cleanup();
  }
});

test('scope filtering is applied before limits and never reads message contents', () => {
  const f = fixture();
  try {
    for (const group of ['11', '22', '33']) {
      f.store!.begin(origin('same-id', group), 101);
    }
    f.db!.exec(
      "ALTER TABLE wake_effect_waits ADD COLUMN private_text TEXT; UPDATE wake_effect_waits SET private_text='PRIVATE-MESSAGE-CONTENT'",
    );
    const all = f.read();
    assert.equal(all.points.length, 2);
    assert.equal(new Set(all.points.map((p) => p.key)).size, 2);
    assert.equal(f.read('11').points.length, 1);
    assert.equal(
      JSON.stringify(all).includes('PRIVATE-MESSAGE-CONTENT'),
      false,
    );
    assert.deepEqual(Object.keys(all.points[0]!).sort(), [
      'firstEffectWaitMs',
      'key',
      'outcome',
      'receivedAt',
    ]);
    f.revoke();
    assert.deepEqual(f.read().points, []);
  } finally {
    f.cleanup();
  }
});

test('invalid or future schemas fail rather than masquerading as zero samples', () => {
  for (const sql of [
    'DROP TABLE wake_effect_wait_meta',
    'UPDATE wake_effect_wait_meta SET schema_version=99',
    "UPDATE wake_effect_wait_meta SET collection_started_at='invalid'",
    'ALTER TABLE wake_effect_waits RENAME COLUMN trigger_received_at TO old_time',
  ]) {
    const f = fixture();
    try {
      f.db!.exec(sql);
      assert.throws(() => f.read());
    } finally {
      f.cleanup();
    }
  }
});

test('invalid duration or unsupported confirmation kind is never a zero wait', () => {
  const f = fixture();
  try {
    f.store!.begin(origin('invalid'), 101);
    f.store!.finish(origin('invalid'), 'silent', 110);
    f.db!.exec(
      "UPDATE wake_effect_waits SET first_effect_at=110,first_effect_wait_ms=-1,first_effect_kind='message_sent'",
    );
    assert.equal(f.read().points[0]!.firstEffectWaitMs, null);
    f.db!.exec(
      "UPDATE wake_effect_waits SET first_effect_wait_ms=0,first_effect_kind='local_artifact'",
    );
    assert.equal(f.read().points[0]!.outcome, 'unconfirmed');
    assert.equal(f.read().points[0]!.firstEffectWaitMs, null);
  } finally {
    f.cleanup();
  }
});

test('10000 points are retained; cross-group overflow rejects instead of sampling', () => {
  const f = fixture();
  try {
    f.db!
      .exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO wake_effect_waits(group_id,turn_id,self_id,trigger_received_at,wake_started_at)
      SELECT CASE WHEN x<=6000 THEN '11' ELSE '22' END,'bulk-'||x,'1',100,101 FROM n`);
    assert.equal(f.read('11').points.length, 6000);
    assert.throws(() => f.read(), ResourceLimit);
    f.db!.exec("DELETE FROM wake_effect_waits WHERE turn_id='bulk-10001'");
    assert.equal(f.read().points.length, 10000);
  } finally {
    f.cleanup();
  }
});

test('wake metric API authenticates, validates range and refreshes group authorization', async () => {
  const f = fixture();
  const auth = new AuthStore({
    path: join(f.dir, 'auth.sqlite'),
    password: 'test-password-long',
  });
  const app = buildApp({ ...f.sources, auth, now: () => 300 });
  try {
    f.store!.begin(origin('first'), 101);
    assert.equal(
      (await app.inject('/api/wake-effect-trends?since=0&until=300'))
        .statusCode,
      401,
    );
    const login = auth.login('test-password-long', '127.0.0.1');
    assert.equal(login.status, 'ok');
    if (login.status !== 'ok') {
      return;
    }
    const headers = { cookie: `dashboard_session=${login.token}` };
    const url = '/api/wake-effect-trends?since=0&until=300';
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().points.length, 1);
    for (const invalid of [
      url + '&groupId=33',
      url + '&cursor=old',
      '/api/wake-effect-trends?since=0&until=2678400001',
    ]) {
      assert.equal(
        (await app.inject({ url: invalid, headers })).statusCode,
        400,
      );
    }
    f.revoke();
    assert.equal((await app.inject({ url, headers })).json().points.length, 0);
    assert.equal(
      (await app.inject({ url: url + '&groupId=11', headers })).statusCode,
      400,
    );
  } finally {
    await app.close();
    auth.close();
    f.cleanup();
  }
});
