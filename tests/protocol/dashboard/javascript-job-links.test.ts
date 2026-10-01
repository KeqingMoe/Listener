import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../../src/dashboard/server/app.ts';
import { AuthStore } from '../../../src/dashboard/server/auth.ts';
import {
  isJavascriptJobId,
  type JavascriptJobLinksResponse,
} from '../../../src/dashboard/contracts/javascript-jobs.ts';

function fixture(groupId = '11') {
  const dir = mkdtempSync(join(tmpdir(), 'javascript-links-'));
  const path = join(dir, 'session.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE model_session_meta(singleton INTEGER PRIMARY KEY,group_id TEXT);
    INSERT INTO model_session_meta VALUES(1,'11');
    CREATE TABLE model_session_journal(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,kind TEXT,payload TEXT,created_at INTEGER);
    CREATE INDEX model_session_journal_kind_time ON model_session_journal(kind,created_at,wake_id);
    CREATE INDEX model_session_journal_wake ON model_session_journal(wake_id,seq);
    CREATE TABLE model_session_messages(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,request_id TEXT,message TEXT);
    CREATE TABLE model_tool_ledger(ordinal INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,assistant_seq INTEGER,call_id TEXT,name TEXT,arguments TEXT,state TEXT,result TEXT);
    CREATE TABLE model_external_events(event_id TEXT PRIMARY KEY,self_id TEXT,payload TEXT,received_at INTEGER,projected_at INTEGER);
  `);
  let seq = 0;
  const journal = (
    kind: string,
    payload: unknown,
    time = 100,
    wake = 'wake-one',
    session = 'session',
  ) =>
    db
      .prepare('INSERT INTO model_session_journal VALUES(?,?,?,?,?,?)')
      .run(++seq, session, wake, kind, JSON.stringify(payload), time);
  journal('wake_begin', {}, 1);
  journal('wake_begin', {}, 2, 'wake-two');
  const tool = (
    ordinal: number,
    name: string,
    args: unknown,
    result: unknown,
    wake = 'wake-one',
    time = 100,
  ) => {
    db.prepare('INSERT INTO model_session_messages VALUES(?,?,?,?,?)').run(
      ordinal,
      'session',
      wake,
      `request-${ordinal}`,
      JSON.stringify({ role: 'assistant' }),
    );
    db.prepare('INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)').run(
      ordinal,
      'session',
      wake,
      ordinal,
      `call-${ordinal}`,
      name,
      JSON.stringify(args),
      'finished',
      result === null ? null : JSON.stringify(result),
    );
    journal(
      'tool_intent',
      { ordinal, assistant_seq: ordinal, call_id: `call-${ordinal}` },
      time,
      wake,
    );
    journal('tool_result', { ordinal, state: 'finished' }, time, wake);
  };
  const notify = (
    job = 'js_target',
    projected: number | null = 120,
    account = '987654321',
    time = 110,
  ) => {
    const id = `${account}:${job}`;
    db.prepare('INSERT INTO model_external_events VALUES(?,?,?,?,?)').run(
      id,
      account,
      JSON.stringify({
        job_id: job,
        status: 'completed',
        description: 'PRIVATE_BODY',
        value: 'PRIVATE_BODY',
      }),
      time,
      projected,
    );
    if (projected !== null) {
      journal(
        'external_event_received',
        { event_id: id },
        projected,
        'wake-two',
      );
    }
  };
  const auth = new AuthStore({
    path: join(dir, 'auth.sqlite'),
    password: 'test-password-long',
  });
  const login = auth.login('test-password-long', '127.0.0.1');
  assert.equal(login.status, 'ok');
  const headers = {
    cookie: `dashboard_session=${login.status === 'ok' ? login.token : ''}`,
  };
  db.prepare('UPDATE model_session_meta SET group_id=?').run(groupId);
  let groups = [{ groupId, sessionPath: path }];
  const app = buildApp({
    auth,
    groups,
    getGroups: () => groups,
    telemetryPath: join(dir, 'absent.sqlite'),
    inspectionSecrets: ['PRIVATE_SECRET'],
    now: () => 200,
  });
  const get = (
    query = `groupId=${groupId}&since=0&until=200`,
    job = 'js_target',
  ) =>
    app.inject({ url: `/api/javascript-jobs/${job}/links?${query}`, headers });
  return {
    app,
    db,
    path,
    journal,
    tool,
    notify,
    get,
    sync: (resource: string, cursor?: string) =>
      app.inject({
        url: `/api/resource-sync?resource=${encodeURIComponent(resource)}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        headers,
      }),
    revoke: () => {
      groups = [];
    },
    close: async () => {
      await app.close();
      db.close();
      auth.close();
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

test('job link resource-sync snapshots and unchanged cursors preserve authorization', async () => {
  const f = fixture();
  try {
    f.tool(
      1,
      'execute_javascript',
      {},
      { job_id: 'js_target', status: 'pending' },
    );
    const resource =
      '/api/javascript-jobs/js_target/links?groupId=11&since=0&until=200';
    const first = await f.sync(resource);
    assert.equal(first.statusCode, 200, first.body);
    const snapshot = first.json<{
      mode: string;
      cursor: string;
      data: JavascriptJobLinksResponse;
    }>();
    assert.equal(snapshot.mode, 'snapshot');
    assert.equal(snapshot.data.items[0]!.ordinal, 1);
    const next = await f.sync(resource, snapshot.cursor);
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json<{ mode: string }>().mode, 'unchanged');
    assert.equal(
      (
        await f.sync(
          resource.replace('groupId=11', 'groupId=22'),
          snapshot.cursor,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject(
          `/api/resource-sync?resource=${encodeURIComponent(resource)}`,
        )
      ).statusCode,
      401,
    );
    f.revoke();
    assert.equal((await f.sync(resource, snapshot.cursor)).statusCode, 400);
  } finally {
    await f.close();
  }
});

test('resource-sync rejects forged job paths and unsupported job queries', async () => {
  const f = fixture();
  try {
    for (const resource of [
      '/api/javascript-jobs/js_target/links/extra?groupId=11',
      '/api/javascript-jobs/js_target/other?groupId=11',
      '/api/javascript-jobs/js_target%2Fother/links?groupId=11',
      '/api/javascript-jobs/js_target/links?groupId=11&code=evil',
      '/api/javascript-jobs/js_target/links',
    ]) {
      assert.equal((await f.sync(resource)).statusCode, 400, resource);
    }
  } finally {
    await f.close();
  }
});

test('job id contract is exact and bounded', () => {
  for (const id of ['js_a', 'js_A-1_', `js_${'a'.repeat(97)}`]) {
    assert.equal(isJavascriptJobId(id), true);
  }
  for (const id of [
    null,
    1,
    {},
    'js_',
    'xjs_a',
    'js_a/b',
    'js_a\n',
    `js_${'a'.repeat(98)}`,
  ]) {
    assert.equal(isJavascriptJobId(id), false);
  }
});

test('exact host links, cross-wake requests, list observations, camel history and no code/value recursion', async () => {
  const f = fixture();
  try {
    f.tool(
      1,
      'execute_javascript',
      { code: 'PRIVATE_BODY' },
      { status: 'submitted', job_id: 'js_target' },
    );
    f.tool(
      2,
      'query_javascript_jobs',
      { job_id: 'js_target' },
      { status: 'error', error: 'PRIVATE_BODY' },
      'wake-two',
    );
    f.tool(
      3,
      'query_javascript_jobs',
      {},
      { status: 'ok', jobs: [{ jobId: 'js_target', status: 'running' }] },
    );
    f.tool(
      4,
      'cancel_javascript_job',
      {},
      { status: 'ok', job: { jobId: 'js_target', status: 'cancelled' } },
    );
    f.tool(5, 'execute_javascript', {}, { jobId: 'js_target', status: 'ok' });
    f.tool(
      6,
      'execute_javascript',
      { code: 'js_target', job_id: 'js_target' },
      { status: 'ok', value: { job_id: 'js_target' } },
    );
    f.tool(7, 'query_javascript_jobs', { code: 'js_target' }, 'js_target');
    f.tool(
      8,
      'untrusted_tool',
      { job_id: 'js_target' },
      { job_id: 'js_target' },
    );
    const before = readFileSync(f.path);
    const r = await f.get();
    assert.equal(r.statusCode, 200);
    const body = r.json<JavascriptJobLinksResponse>();
    assert.equal(body.unavailable, false);
    assert.deepEqual(
      body.items.map((i) => i.ordinal),
      [1, 2, 3, 4, 5],
    );
    assert.equal(body.items[1]!.requestId, 'request-2');
    assert.equal(body.items[1]!.wakeId, 'wake-two');
    assert.deepEqual(
      body.items.map((i) => i.taskStatus),
      [null, null, 'running', 'cancelled', null],
    );
    assert.deepEqual(
      body.items.map((i) => i.status),
      ['submitted', 'error', 'ok', 'ok', 'ok'],
    );
    assert.equal(r.body.includes('PRIVATE_BODY'), false);
    assert.deepEqual(readFileSync(f.path), before);
  } finally {
    await f.close();
  }
});

test('notifications are exact inbox/journal facts, never user host_event or summaries', async () => {
  const f = fixture();
  try {
    f.notify();
    f.notify('js_other');
    f.notify('js_target', null, '876543210', 115);
    f.journal('javascript_job_summary', {
      job_id: 'js_target',
      status: 'completed',
    });
    f.db.prepare('INSERT INTO model_session_messages VALUES(99,?,?,?,?)').run(
      'session',
      'wake-one',
      'fake',
      JSON.stringify({
        role: 'user',
        content: JSON.stringify({ host_event: { job_id: 'js_target' } }),
      }),
    );
    const r = await f.get();
    const body = r.json<JavascriptJobLinksResponse>();
    assert.deepEqual(
      body.items.map((i) => i.kind),
      [
        'notification_received',
        'notification_received',
        'notification_projected',
      ],
    );
    assert.equal(new Set(body.items.map((i) => i.key)).size, 3);
    assert.ok(
      body.items.every(
        (i) => i.requestId === null && i.taskStatus === 'completed',
      ),
    );
    assert.equal(body.items[2]!.wakeId, 'wake-two');
    assert.ok(
      !/PRIVATE|self_id|value|description|987654321|876543210/.test(r.body),
    );
    f.db.exec('DELETE FROM model_external_events');
    const missing = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(missing.items.length, 1);
    assert.equal(missing.items[0]!.taskStatus, null);
    assert.equal(missing.truncated, true);
    assert.deepEqual(missing.limitations, ['linked_record_missing']);
  } finally {
    await f.close();
  }
});

test('authorization, changing group authorization, allowed query keys and encoded paths', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.app.inject('/api/javascript-jobs/js_target/links?groupId=11'))
        .statusCode,
      401,
    );
    for (const query of [
      '',
      'groupId=22',
      'groupId=11&extra=1',
      'groupId=11&since=2&until=1',
      'groupId=11&since=0&until=2678400001',
      'groupId=11&groupId=11',
    ]) {
      assert.equal((await f.get(query)).statusCode, 400, query);
    }
    for (const job of ['wrong', 'js_a%2Fb', 'js_a%00', 'js_a%20']) {
      assert.equal((await f.get('groupId=11', job)).statusCode, 400, job);
    }
    assert.equal(
      (await f.get('groupId=11', `js_${'x'.repeat(98)}`)).statusCode,
      414,
    );
    assert.equal(
      (await f.get('groupId=11', `js_${'x'.repeat(97)}`)).statusCode,
      200,
    );
    f.revoke();
    assert.equal((await f.get()).statusCode, 400);
  } finally {
    await f.close();
  }
});

test('schema/index fail closed and primary key/session/request proofs', async () => {
  const f = fixture();
  try {
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target', status: 'ok' });
    f.db.exec("UPDATE model_session_messages SET session_id='foreign'");
    assert.equal(
      (await f.get()).json<JavascriptJobLinksResponse>().items[0]!.requestId,
      null,
    );
    f.db.exec("UPDATE model_tool_ledger SET session_id='foreign'");
    const mismatch = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(mismatch.items.length, 0);
    assert.equal(mismatch.truncated, true);
    f.db.exec('DROP INDEX model_session_journal_kind_time');
    assert.equal(
      (await f.get()).json<JavascriptJobLinksResponse>().unavailable,
      true,
    );
    f.db.exec(
      'CREATE INDEX model_session_journal_kind_time ON model_session_journal(wake_id)',
    );
    assert.equal(
      (await f.get()).json<JavascriptJobLinksResponse>().unavailable,
      true,
    );
    f.db.exec('DROP TABLE model_external_events');
    assert.equal(
      (await f.get()).json<JavascriptJobLinksResponse>().unavailable,
      true,
    );
  } finally {
    await f.close();
  }
});

for (const definition of [
  'kind COLLATE NOCASE,created_at,wake_id',
  'kind,created_at,wake_id DESC',
]) {
  test(`journal index rejects incompatible collation or ordering: ${definition}`, async () => {
    const f = fixture();
    try {
      f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' });
      f.db.exec(
        `DROP INDEX model_session_journal_kind_time; CREATE INDEX model_session_journal_kind_time ON model_session_journal(${definition})`,
      );
      const r = (await f.get()).json<JavascriptJobLinksResponse>();
      assert.equal(r.unavailable, true);
      assert.deepEqual(r.items, []);
    } finally {
      await f.close();
    }
  });
}

test('explicit BINARY comparisons retain bounded indexed plans for differently collated columns', async () => {
  const f = fixture();
  try {
    f.db.exec(`DROP TABLE model_session_journal;
      CREATE TABLE model_session_journal(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT COLLATE NOCASE,kind TEXT COLLATE NOCASE,payload TEXT,created_at INTEGER);
      CREATE INDEX model_session_journal_kind_time ON model_session_journal(kind COLLATE BINARY,created_at,wake_id COLLATE BINARY);
      CREATE INDEX model_session_journal_wake ON model_session_journal(wake_id COLLATE BINARY,seq);`);
    f.journal('wake_begin', {}, 1);
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' });
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(r.unavailable, false);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.wakeId, 'wake-one');
    assert.deepEqual(r.limitations, []);
    const plan = f.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT seq FROM model_session_journal INDEXED BY model_session_journal_kind_time WHERE kind COLLATE BINARY=? AND created_at COLLATE BINARY>=? AND created_at COLLATE BINARY<=? ORDER BY created_at COLLATE BINARY DESC,wake_id COLLATE BINARY DESC LIMIT 2001',
      )
      .all('tool_result', 0, 200);
    assert.ok(plan.some((row) => String(row.detail).includes('SEARCH')));
    assert.ok(
      plan.every((row) => !/SCAN|TEMP B-TREE/.test(String(row.detail))),
    );
  } finally {
    await f.close();
  }
});

test('redacted or malformed existing IDs explicitly mark incomplete observations', async () => {
  const f = fixture();
  try {
    f.tool(
      1,
      'execute_javascript',
      {},
      { job_id: 'js_target', status: 'pending' },
    );
    assert.equal(
      (await f.get()).json<JavascriptJobLinksResponse>().truncated,
      false,
    );
    f.db.exec(
      "UPDATE model_session_messages SET request_id='PRIVATE_SECRET'; UPDATE model_tool_ledger SET call_id='PRIVATE_SECRET'",
    );
    const redacted = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(redacted.items.length, 1);
    assert.equal(redacted.items[0]!.requestId, null);
    assert.equal(redacted.items[0]!.callId, null);
    assert.equal(redacted.truncated, true);
    f.db.exec(
      'UPDATE model_session_messages SET request_id=NULL; UPDATE model_tool_ledger SET call_id=NULL',
    );
    assert.equal(
      (await f.get()).json<JavascriptJobLinksResponse>().truncated,
      false,
    );
    for (const value of ['x'.repeat(257), 'control\u0001id']) {
      f.db.prepare('UPDATE model_tool_ledger SET call_id=?').run(value);
      const invalid = (await f.get()).json<JavascriptJobLinksResponse>();
      assert.equal(invalid.items[0]!.callId, null);
      assert.equal(invalid.truncated, true);
    }
    f.db.exec(
      "UPDATE model_tool_ledger SET call_id=NULL,wake_id='PRIVATE_SECRET'; UPDATE model_session_messages SET wake_id='PRIVATE_SECRET'; UPDATE model_session_journal SET wake_id='PRIVATE_SECRET'",
    );
    const wake = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(wake.items[0]!.wakeId, null);
    assert.equal(wake.truncated, true);
  } finally {
    await f.close();
  }
});

test('time boundaries, output cap, payload cap, secret identifiers and stable keys', async () => {
  const f = fixture();
  try {
    f.tool(
      1,
      'execute_javascript',
      {},
      { job_id: 'js_target' },
      'wake-one',
      100,
    );
    f.tool(
      2,
      'execute_javascript',
      {},
      { job_id: 'js_target' },
      'wake-one',
      101,
    );
    f.tool(
      3,
      'execute_javascript',
      {},
      { job_id: 'js_target', value: 'x'.repeat(1024 * 1024) },
    );
    f.db.exec(
      "UPDATE model_tool_ledger SET call_id='PRIVATE_SECRET' WHERE ordinal=1;UPDATE model_session_messages SET request_id='PRIVATE_SECRET' WHERE seq=1",
    );
    const r = (
      await f.get('groupId=11&since=100&until=100')
    ).json<JavascriptJobLinksResponse>();
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.callId, null);
    assert.equal(r.items[0]!.requestId, null);
    assert.equal(r.truncated, true);
    for (let i = 4; i <= 205; i++) {
      f.tool(i, 'execute_javascript', {}, { job_id: 'js_target' });
    }
    const a = (await f.get()).json<JavascriptJobLinksResponse>();
    const b = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(a.items.length, 200);
    assert.equal(a.truncated, true);
    assert.deepEqual(a, b);
  } finally {
    await f.close();
  }
});

test('same job id in different group databases never crosses authorization', async () => {
  const a = fixture(),
    b = fixture('22');
  try {
    a.tool(
      1,
      'execute_javascript',
      {},
      { job_id: 'js_target', status: 'submitted' },
    );
    b.tool(
      99,
      'cancel_javascript_job',
      { job_id: 'js_target' },
      { status: 'error' },
    );
    assert.deepEqual(
      (await a.get())
        .json<JavascriptJobLinksResponse>()
        .items.map((i) => i.ordinal),
      [1],
    );
    assert.deepEqual(
      (await b.get())
        .json<JavascriptJobLinksResponse>()
        .items.map((i) => i.ordinal),
      [99],
    );
    assert.equal((await a.get('groupId=22')).statusCode, 400);
  } finally {
    await a.close();
    await b.close();
  }
});

test('execute records explicit task_status without inferring it from outer ok', async () => {
  const f = fixture();
  try {
    f.tool(
      1,
      'execute_javascript',
      {},
      { job_id: 'js_target', status: 'ok', task_status: 'completed' },
    );
    f.tool(
      2,
      'execute_javascript',
      {},
      { jobId: 'js_target', status: 'error', taskStatus: 'timeout' },
    );
    f.tool(3, 'execute_javascript', {}, { job_id: 'js_target', status: 'ok' });
    f.tool(
      4,
      'execute_javascript',
      {},
      { job_id: 'js_target', status: 'cancelled' },
    );
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.deepEqual(
      r.items.map((i) => i.taskStatus),
      ['completed', 'timeout', null, null],
    );
  } finally {
    await f.close();
  }
});

test('large valid host bodies retain links without returning private content', async () => {
  const f = fixture();
  try {
    const value = 'PRIVATE_BODY'.repeat(5000);
    f.tool(
      1,
      'execute_javascript',
      { code: 'x'.repeat(16000) },
      { job_id: 'js_target', status: 'ok', task_status: 'completed', value },
    );
    f.db.prepare('UPDATE model_session_messages SET message=? WHERE seq=1').run(
      JSON.stringify({
        role: 'assistant',
        content: 'PRIVATE_BODY'.repeat(2000),
      }),
    );
    f.notify();
    f.db.prepare('UPDATE model_external_events SET payload=?').run(
      JSON.stringify({
        job_id: 'js_target',
        status: 'completed',
        value: 'PRIVATE_BODY'.repeat(40000),
      }),
    );
    f.tool(2, 'ordinary_tool', {}, { value: 'PRIVATE_BODY'.repeat(200000) });
    const result = await f.get();
    const r = result.json<JavascriptJobLinksResponse>();
    assert.equal(r.truncated, false);
    assert.equal(r.unavailable, false);
    assert.deepEqual(
      r.items.map((i) => i.kind),
      ['execution', 'notification_received', 'notification_projected'],
    );
    assert.equal(r.items[0]!.requestId, 'request-1');
    assert.ok(r.items.every((i) => i.taskStatus === 'completed'));
    assert.equal(result.body.includes('PRIVATE_BODY'), false);
  } finally {
    await f.close();
  }
});

test('snake-case aliases take precedence and cancellation ignores query-list snapshots', async () => {
  const f = fixture();
  try {
    const conflict = {
      job_id: 'js_other',
      jobId: 'js_target',
      status: 'completed',
    };
    f.tool(1, 'execute_javascript', {}, conflict);
    f.tool(2, 'query_javascript_jobs', {}, { status: 'ok', job: conflict });
    f.tool(3, 'query_javascript_jobs', {}, { status: 'ok', jobs: [conflict] });
    f.tool(
      4,
      'query_javascript_jobs',
      { job_id: 'js_target' },
      { status: 'ok', job: conflict },
    );
    f.tool(
      5,
      'cancel_javascript_job',
      { job_id: 'js_target' },
      { status: 'ok', jobs: [{ job_id: 'js_target', status: 'cancelled' }] },
    );
    f.tool(
      6,
      'cancel_javascript_job',
      {},
      { status: 'ok', jobs: [{ job_id: 'js_target', status: 'cancelled' }] },
    );
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.deepEqual(
      r.items.map((i) => i.ordinal),
      [4, 5],
    );
    assert.ok(r.items.every((i) => i.taskStatus === null));
  } finally {
    await f.close();
  }
});

test('large ledger bodies still share the aggregate eight MiB budget', async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 12; i++) {
      f.tool(
        i,
        'execute_javascript',
        {},
        { job_id: 'js_other', value: 'x'.repeat(800000) },
      );
    }
    f.tool(
      13,
      'execute_javascript',
      {},
      { job_id: 'js_target' },
      'wake-one',
      101,
    );
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(r.truncated, true);
    assert.equal(r.unavailable, false);
    assert.equal(r.items[0]!.ordinal, 13);
    assert.ok(r.limitations?.includes('byte_limit'));
  } finally {
    await f.close();
  }
});

test('aggregate byte budget is independent of candidate and output limits', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 1100; i++) {
      f.journal('tool_intent', {
        ordinal: 9000 + i,
        padding: 'x'.repeat(8000),
      });
    }
    f.tool(
      1,
      'execute_javascript',
      {},
      { job_id: 'js_target' },
      'wake-one',
      101,
    );
    // Remove result candidates so all associations must traverse the byte-limited intent stream.
    f.db.exec("DELETE FROM model_session_journal WHERE kind='tool_result'");
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(r.unavailable, false);
    assert.equal(r.truncated, true);
    assert.equal(r.items[0]!.ordinal, 1);
    assert.ok(r.limitations?.includes('byte_limit'));
  } finally {
    await f.close();
  }
});

test('journal follows inbox primary key beyond latest metadata candidates', async () => {
  const f = fixture();
  try {
    f.notify();
    for (let i = 0; i < 501; i++) {
      f.notify(`js_other_${i}`, null, '123456789');
    }
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(r.truncated, true);
    assert.deepEqual(r.limitations, ['inbox_limit']);
    assert.deepEqual(
      r.items.map((i) => i.kind),
      ['notification_received', 'notification_projected'],
    );
    assert.ok(
      r.items.every(
        (i) => i.taskStatus === 'completed' && i.requestId === null,
      ),
    );
  } finally {
    await f.close();
  }
});

test('anchor bypasses candidate coverage and unrelated wake history is not truncation', async () => {
  const f = fixture();
  try {
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' }, 'wake-one', 1);
    for (let i = 0; i < 2001; i++) {
      f.journal('wake_begin', {}, 10, `unrelated-${i}`);
    }
    const clean = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(clean.items[0]!.wakeId, 'wake-one');
    assert.deepEqual(clean.limitations, []);
    for (let i = 0; i < 2001; i++) {
      f.journal('tool_result', { ordinal: 9000 + i });
    }
    const r = (
      await f.get('groupId=11&since=0&until=200&anchorOrdinal=1')
    ).json<JavascriptJobLinksResponse>();
    assert.equal(r.items[0]!.anchor, true);
    assert.equal(r.items[0]!.requestId, 'request-1');
    assert.equal(r.items[0]!.wakeId, 'wake-one');
    assert.deepEqual(r.limitations, [
      'candidate_record_unreadable',
      'tool_result_limit',
    ]);
  } finally {
    await f.close();
  }
});

test('unmatched tool candidates are parsed once across result and intent streams', async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 6; i++) {
      f.tool(
        i,
        'execute_javascript',
        {},
        { job_id: 'js_other', value: 'x'.repeat(800000) },
      );
    }
    f.tool(
      7,
      'execute_javascript',
      {},
      { job_id: 'js_target' },
      'wake-one',
      101,
    );
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(r.items[0]!.ordinal, 7);
    assert.deepEqual(r.limitations, []);
  } finally {
    await f.close();
  }
});

test('busy histories prefer recent execution and prove only matched wakes', async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 2001; i++) {
      f.tool(i, 'ordinary_tool', {}, { value: 'ignored' }, 'wake-one', 10);
      f.journal('wake_begin', {}, 20, `unrelated-${i}`);
    }
    f.tool(
      3000,
      'execute_javascript',
      {},
      { job_id: 'js_target' },
      'wake-one',
      100,
    );
    f.notify();
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.deepEqual(
      r.items.map((i) => i.kind),
      ['execution', 'notification_received', 'notification_projected'],
    );
    assert.equal(r.items[0]!.wakeId, 'wake-one');
    assert.deepEqual(r.limitations, ['tool_result_limit', 'tool_intent_limit']);
  } finally {
    await f.close();
  }
});

test('output limit retains old anchor and newest notifications over old queries', async () => {
  const f = fixture();
  try {
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' }, 'wake-one', 1);
    for (let i = 2; i <= 205; i++) {
      f.tool(
        i,
        'query_javascript_jobs',
        { job_id: 'js_target' },
        { status: 'ok' },
        'wake-one',
        100,
      );
    }
    f.notify();
    for (const anchor of [false, true]) {
      const r = (
        await f.get(
          `groupId=11&since=0&until=200${anchor ? '&anchorOrdinal=1' : ''}`,
        )
      ).json<JavascriptJobLinksResponse>();
      assert.equal(r.items.length, 200);
      assert.deepEqual(r.limitations, ['output_limit']);
      assert.deepEqual(
        r.items.slice(-2).map((item) => item.kind),
        ['notification_received', 'notification_projected'],
      );
      assert.equal(
        r.items.some((item) => item.ordinal === 1),
        anchor,
      );
      if (anchor) {
        assert.equal(r.items[0]!.anchor, true);
        assert.equal(r.items[0]!.requestId, 'request-1');
      }
      assert.ok(
        r.items.every(
          (item, index) =>
            index === 0 || (r.items[index - 1]!.time ?? 0) <= (item.time ?? 0),
        ),
      );
    }
  } finally {
    await f.close();
  }
});

test('anchor is exact, outside range, prioritized and retained under output limits', async () => {
  const f = fixture();
  try {
    f.tool(
      1,
      'execute_javascript',
      {},
      { job_id: 'js_target' },
      'wake-two',
      100,
    );
    let r = (
      await f.get('groupId=11&since=150&until=200&anchorOrdinal=1')
    ).json<JavascriptJobLinksResponse>();
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.anchor, true);
    assert.equal(r.items[0]!.time, null); // old schema: never substitute journal time
    assert.equal(r.items[0]!.requestId, 'request-1');
    assert.equal(r.items[0]!.wakeId, 'wake-two');
    assert.deepEqual(r.limitations, []);
    f.db.exec(
      'ALTER TABLE model_tool_ledger ADD COLUMN finished_at INTEGER; ALTER TABLE model_tool_ledger ADD COLUMN started_at INTEGER; ALTER TABLE model_tool_ledger ADD COLUMN proposed_at INTEGER; UPDATE model_tool_ledger SET finished_at=999,started_at=80,proposed_at=70',
    );
    r = (
      await f.get('groupId=11&since=150&until=200&anchorOrdinal=1')
    ).json<JavascriptJobLinksResponse>();
    assert.equal(r.items[0]!.time, 999);
    // Add many matched candidates without using the old-schema fixture inserter.
    for (let i = 2; i < 205; i++) {
      f.db
        .prepare(
          'INSERT INTO model_tool_ledger(ordinal,session_id,wake_id,name,state,result) VALUES(?,?,?,?,?,?)',
        )
        .run(
          i,
          'session',
          'wake-one',
          'execute_javascript',
          'finished',
          JSON.stringify({ job_id: 'js_target' }),
        );
      f.journal('tool_result', { ordinal: i });
    }
    r = (
      await f.get('groupId=11&since=0&until=200&anchorOrdinal=1')
    ).json<JavascriptJobLinksResponse>();
    assert.equal(r.items.length, 200);
    assert.ok(
      r.items.some((i) => i.anchor && i.ordinal === 1 && i.time === 999),
    );
    assert.deepEqual(r.limitations, ['output_limit']);
    const wrong = (
      await f.get('groupId=11&since=150&until=200&anchorOrdinal=1', 'js_other')
    ).json<JavascriptJobLinksResponse>();
    assert.deepEqual(wrong.items, []);
    assert.deepEqual(wrong.limitations, ['anchor_unmatched']);
    const missing = (
      await f.get('groupId=11&since=150&until=200&anchorOrdinal=9000')
    ).json<JavascriptJobLinksResponse>();
    assert.deepEqual(missing.items, []);
    assert.deepEqual(missing.limitations, ['anchor_unmatched']);
    assert.equal((await f.get('groupId=22&anchorOrdinal=1')).statusCode, 400);
  } finally {
    await f.close();
  }
});

test('anchor and notification facts receive budget before unrelated large tool bodies', async () => {
  const f = fixture();
  try {
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' }, 'wake-one', 1);
    f.notify();
    // Also retain inbox-only evidence with a distinct account, without assuming uniqueness.
    f.notify('js_target', null, '123456789', 115);
    for (let i = 2; i < 15; i++) {
      f.tool(
        i,
        'execute_javascript',
        {},
        { job_id: 'js_other', value: 'x'.repeat(800000) },
      );
    }
    const r = (
      await f.get('groupId=11&since=0&until=200&anchorOrdinal=1')
    ).json<JavascriptJobLinksResponse>();
    assert.equal(r.items[0]!.anchor, true);
    assert.equal(r.items[0]!.requestId, 'request-1');
    assert.deepEqual(
      r.items.map((item) => item.kind),
      [
        'execution',
        'notification_received',
        'notification_received',
        'notification_projected',
      ],
    );
    assert.equal(r.items[3]!.wakeId, 'wake-two');
    assert.deepEqual(r.limitations, ['byte_limit']);
  } finally {
    await f.close();
  }
});

test('anchor receives byte budget before newer unrelated candidates', async () => {
  const f = fixture();
  try {
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' }, 'wake-one', 1);
    for (let i = 2; i < 15; i++) {
      f.tool(
        i,
        'execute_javascript',
        {},
        { job_id: 'js_other', value: 'x'.repeat(800000) },
      );
    }
    const r = (
      await f.get('groupId=11&since=0&until=200&anchorOrdinal=1')
    ).json<JavascriptJobLinksResponse>();
    assert.equal(r.items[0]!.anchor, true);
    assert.equal(r.items[0]!.requestId, 'request-1');
    assert.ok(r.limitations?.includes('byte_limit'));
  } finally {
    await f.close();
  }
});

for (const definition of [
  null,
  'wake_id COLLATE NOCASE,seq',
  'wake_id,seq DESC',
]) {
  test(`wake navigation fails closed without canonical index: ${definition}`, async () => {
    const f = fixture();
    try {
      f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' });
      f.db.exec('DROP INDEX model_session_journal_wake');
      if (definition) {
        f.db.exec(
          `CREATE INDEX model_session_journal_wake ON model_session_journal(${definition})`,
        );
      }
      const r = (await f.get()).json<JavascriptJobLinksResponse>();
      assert.equal(r.unavailable, false);
      assert.equal(r.items[0]!.wakeId, null);
      assert.deepEqual(r.limitations, ['wake_lookup_unavailable']);
    } finally {
      await f.close();
    }
  });
}

test('wake proof uses bounded BINARY index search and stops on first evidence', async () => {
  const f = fixture();
  try {
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' });
    for (let i = 0; i < 600; i++) {
      f.journal('other', {});
    }
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(r.items[0]!.wakeId, 'wake-one');
    assert.deepEqual(r.limitations, []);
    const plan = f.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT session_id,kind FROM model_session_journal INDEXED BY model_session_journal_wake WHERE wake_id COLLATE BINARY=? ORDER BY seq COLLATE BINARY LIMIT 501',
      )
      .all('wake-one');
    assert.ok(plan.some((row) => /SEARCH/.test(String(row.detail))));
    assert.ok(
      plan.every((row) => !/SCAN|TEMP B-TREE/.test(String(row.detail))),
    );
    f.db.exec(
      "UPDATE model_session_journal SET session_id='other' WHERE kind='wake_begin'",
    );
    const limited = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(limited.items[0]!.wakeId, null);
    assert.deepEqual(limited.limitations, ['wake_lookup_limit']);
  } finally {
    await f.close();
  }
});

test('anchor query validates integers and binds resource-sync cursors', async () => {
  const f = fixture();
  try {
    for (const value of [
      '0',
      '-1',
      '1.5',
      '9007199254740992',
      'x',
      '1&anchorOrdinal=2',
    ]) {
      assert.equal(
        (await f.get(`groupId=11&anchorOrdinal=${value}`)).statusCode,
        400,
      );
    }
    f.tool(1, 'execute_javascript', {}, { job_id: 'js_target' });
    const resource =
      '/api/javascript-jobs/js_target/links?groupId=11&since=0&until=200&anchorOrdinal=1';
    const first = await f.sync(resource);
    assert.equal(first.statusCode, 200, first.body);
    const snapshot = first.json<{
      cursor: string;
      data: JavascriptJobLinksResponse;
    }>();
    assert.equal(snapshot.data.items[0]!.anchor, true);
    const changed = await f.sync(
      resource.replace('anchorOrdinal=1', 'anchorOrdinal=2'),
      snapshot.cursor,
    );
    assert.equal(changed.statusCode, 200);
    const changedSnapshot = changed.json<{
      mode: string;
      data: JavascriptJobLinksResponse;
    }>();
    assert.equal(changedSnapshot.mode, 'snapshot');
    assert.ok(changedSnapshot.data.items.every((item) => !item.anchor));
    assert.deepEqual(changedSnapshot.data.limitations, ['anchor_unmatched']);
    f.revoke();
    assert.equal((await f.sync(resource, snapshot.cursor)).statusCode, 400);
  } finally {
    await f.close();
  }
});

test('bounded journal and inbox candidates explicitly report truncation', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2001; i++) {
      f.journal('tool_intent', { ordinal: i + 1 });
    }
    for (let i = 0; i < 501; i++) {
      f.notify(`js_other_${i}`, null, '123456789');
    }
    const r = (await f.get()).json<JavascriptJobLinksResponse>();
    assert.equal(r.items.length, 0);
    assert.equal(r.truncated, true);
    assert.equal(r.unavailable, false);
  } finally {
    await f.close();
  }
});
