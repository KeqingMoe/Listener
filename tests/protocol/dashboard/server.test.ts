import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp as rawBuildApp } from '../../../src/dashboard/server/app.ts';
import { AuthStore } from '../../../src/dashboard/server/auth.ts';

function buildApp(options: Parameters<typeof rawBuildApp>[0]) {
  const app = rawBuildApp(options);
  const login = options.auth!.login('test-password-long', '127.0.0.1');
  assert.equal(login.status, 'ok');
  const token = login.status === 'ok' ? login.token : '';
  const inject = app.inject.bind(app);
  app.inject = ((value: any) =>
    inject(
      typeof value === 'string'
        ? { url: value, headers: { cookie: `dashboard_session=${token}` } }
        : {
            ...value,
            headers: { cookie: `dashboard_session=${token}`, ...value.headers },
          },
    )) as typeof app.inject;
  return app;
}

import { status as statusLabel } from '../../../src/dashboard/web/src/api/client.ts';

const sentinel = 'PRIVATE_ARGUMENT_RESULT_MESSAGE_CHECKPOINT_PATH';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-'));
  const auth = new AuthStore({
    path: join(dir, 'auth.sqlite'),
    password: 'test-password-long',
  });
  const telemetryPath = join(dir, 'telemetry.sqlite'),
    sessionPath = join(dir, 'session.sqlite');
  const t = new DatabaseSync(telemetryPath);
  t.exec(
    'CREATE TABLE model_requests(request_id TEXT,group_id TEXT,turn_id TEXT,started_at INTEGER,ended_at INTEGER,duration_ms REAL,status TEXT,transport TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER)',
  );
  const insert = t.prepare(
    'INSERT INTO model_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  // 各自独立的物理turn，均不等于持久化的会话wake ID。
  // 共享turn ID有意用于关联重试与会话轮换。
  insert.run(
    'request-one',
    '11',
    'NOT_WAKE_ID-one',
    100,
    120,
    20,
    'success',
    'responses',
    100,
    10,
    50,
  );
  insert.run(
    'request-two',
    '11',
    'NOT_WAKE_ID-two',
    200,
    240,
    40,
    'error',
    'responses',
    900,
    20,
    810,
  );
  insert.run(
    'request-three',
    '11',
    'NOT_WAKE_ID-three',
    250,
    300,
    50,
    'success',
    'responses',
    100,
    null,
    null,
  );
  insert.run(
    'foreign',
    '22',
    'wake-one',
    100,
    120,
    20,
    'success',
    'responses',
    100000,
    10,
    100000,
  );
  t.close();
  const s = new DatabaseSync(sessionPath);
  s.exec(
    'CREATE TABLE model_session_meta(singleton INTEGER,group_id TEXT,checkpoint TEXT);CREATE TABLE model_session_journal(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,kind TEXT,payload TEXT,created_at INTEGER);CREATE TABLE model_session_messages(seq INTEGER,session_id TEXT,wake_id TEXT,request_id TEXT,message TEXT);CREATE TABLE model_tool_ledger(ordinal INTEGER,name TEXT,wake_id TEXT,state TEXT,arguments TEXT,result TEXT,proposed_at INTEGER,started_at INTEGER,finished_at INTEGER)',
  );
  s.prepare('INSERT INTO model_session_meta VALUES(1,?,?)').run('11', sentinel);
  s.prepare('INSERT INTO model_session_journal VALUES(1,?,?,?,?,?)').run(
    'session',
    'wake-one',
    'wake_begin',
    JSON.stringify({ private: sentinel }),
    90,
  );
  s.prepare('INSERT INTO model_session_journal VALUES(2,?,?,?,?,?)').run(
    'session',
    'wake-one',
    'wake_finish',
    JSON.stringify({ reason: 'completed', private: sentinel }),
    130,
  );
  s.prepare('INSERT INTO model_session_journal VALUES(3,?,?,?,?,?)').run(
    'session',
    'wake-two',
    'wake_begin',
    '{}',
    190,
  );
  s.prepare('INSERT INTO model_session_messages VALUES(1,?,?,?,?)').run(
    'session',
    'wake-one',
    'request-one',
    sentinel,
  );
  s.prepare('INSERT INTO model_session_messages VALUES(2,?,?,?,?)').run(
    'session',
    'wake-two',
    'request-two',
    sentinel,
  );
  s.prepare('INSERT INTO model_tool_ledger VALUES(1,?,?,?,?,?,?,?,?)').run(
    'read_events',
    'wake-one',
    'finished',
    sentinel,
    JSON.stringify({ status: 'ok', private: sentinel }),
    105,
    106,
    110,
  );
  s.close();
  return {
    dir,
    sessionPath,
    telemetryPath,
    options: {
      auth,
      groups: [{ groupId: '11', sessionPath }],
      telemetryPath,
      now: () => 300,
    },
    cleanup: () => {
      auth.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const [outcome, label] of [
  ['operation_submitted', '操作已提交'],
  ['message_submitted', '消息已提交'],
  ['reaction_submitted', '回应已提交'],
]) {
  test(`normal ${outcome} remains submitted rather than unknown in dashboard projection`, async () => {
    const f = fixture();
    const db = new DatabaseSync(f.sessionPath);
    db.prepare(
      "UPDATE model_session_journal SET payload=? WHERE kind='wake_finish'",
    ).run(JSON.stringify({ reason: outcome, private: sentinel }));
    db.close();
    const app = buildApp(f.options);
    try {
      const response = await app.inject('/api/wakes/wake-one?groupId=11');
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().wake.outcome, outcome);
      assert.equal(statusLabel(outcome!), label);
      assert.doesNotMatch(response.body, new RegExp(sentinel));
    } finally {
      await app.close();
      f.cleanup();
    }
  });
}

test('safe metadata, weighted usage, missing usage, and enabled-group isolation', async () => {
  const f = fixture(),
    app = buildApp(f.options);
  try {
    const r = await app.inject('/api/overview?since=0&until=300');
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.summary.requests, 3);
    assert.equal(b.summary.inputTokens, 1100);
    assert.equal(b.summary.cacheHitRate, 0.86);
    assert.equal(b.summary.cachedInputTokens, 860);
    assert.equal(b.summary.uncachedInputTokens, 140);
    assert.equal(b.summary.tps, null); // 历史请求缺少流式计时数据。
    assert.equal(b.summary.ttftMs, null);
    assert.equal(b.groups.length, 1);
    assert.doesNotMatch(r.body, new RegExp(sentinel + '|NOT_WAKE_ID|foreign'));
    assert.equal(
      (await app.inject('/api/overview?groupId=22')).statusCode,
      400,
    );
    assert.equal(
      (await app.inject('/api/meta')).json().groups[0].groupId,
      '11',
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('wake list summarizes only executed bot replies in order with folded whitespace', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.sessionPath);
  const send = db.prepare(
    'INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)',
  );
  const message = (ordinal: number, state: string, segments: unknown[]) =>
    send.run(
      ordinal,
      'send_message',
      'wake-one',
      state,
      JSON.stringify({ segments }),
      JSON.stringify({ status: 'ok' }),
      111,
      112,
      113,
    );
  message(2, 'finished', [
    { type: 'at', user_id: '1' },
    { type: 'text', text: ' 你好\n世界 ' },
    { type: 'face', id: 1, name: '微笑' },
  ]);
  message(3, 'proposed', [{ type: 'text', text: '未执行' }]);
  message(4, 'finished', [{ type: 'text', text: '第二条' }]);
  db.close();
  const app = buildApp(f.options);
  try {
    const d = (await app.inject('/api/wakes/wake-one?groupId=11')).json();
    assert.equal(d.wake.reply, '@ 你好 世界 [微笑] / 第二条');
    const list = (await app.inject('/api/wakes?since=0&until=300')).json();
    const other = list.items.find(
      (w: { wakeId: string }) => w.wakeId === 'wake-two',
    );
    assert.equal(other.reply, null);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('wake correlation uses request IDs, safe detail projection, bound pagination', async () => {
  const f = fixture(),
    app = buildApp(f.options);
  try {
    const r = await app.inject('/api/wakes?since=0&until=300&limit=1'),
      b = r.json();
    assert.equal(r.statusCode, 200);
    assert.equal(b.items[0].wakeId, 'wake-two');
    assert.equal(b.items[0].modelRequests, 1);
    assert.equal(b.items[0].inputTokens, 900);
    assert.ok(b.nextCursor);
    const next = (
      await app.inject(
        `/api/wakes?since=0&until=300&limit=1&cursor=${b.nextCursor}`,
      )
    ).json();
    assert.equal(next.items[0].wakeId, 'wake-one');
    assert.equal(next.nextCursor, null);
    assert.equal(
      (await app.inject(`/api/wakes?since=1&until=300&cursor=${b.nextCursor}`))
        .statusCode,
      400,
    );
    const detail = await app.inject('/api/wakes/wake-one?groupId=11');
    assert.equal(detail.statusCode, 200);
    const d = detail.json();
    assert.equal(d.wake.outcome, 'completed');
    assert.equal(d.wake.reply, null);
    assert.equal(d.requests[0].requestId, 'request-one');
    assert.equal(d.requests[0].errorCode, null);
    assert.equal(d.requests[0].httpStatus, null);
    assert.equal(d.requests[0].diagnostics, null);
    assert.equal(d.requests[0].outcome, 'success');
    assert.equal(d.tools[0].name, 'read_events');
    assert.equal(d.wake.durationMs, 40);
    assert.doesNotMatch(
      detail.body,
      new RegExp(sentinel + '|arguments|checkpoint|NOT_WAKE_ID'),
    );
    assert.equal((await app.inject('/api/wakes/wake-one')).statusCode, 400);
    assert.equal(
      (await app.inject('/api/wakes/nope?groupId=11')).statusCode,
      404,
    );
    const tools = (await app.inject('/api/tools?since=0&until=300')).json();
    assert.equal(tools.items[0].calls, 1);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('read-only connections do not mutate files and missing files are not created', async () => {
  const f = fixture(),
    before = readFileSync(f.sessionPath),
    app = buildApp({
      ...f.options,
      groups: [
        ...f.options.groups,
        { groupId: '33', sessionPath: join(f.dir, 'missing.sqlite') },
      ],
    });
  try {
    assert.equal(
      (await app.inject('/api/meta')).json().availability.sessions[1].available,
      false,
    );
    assert.equal(
      (await app.inject('/api/wakes/any?groupId=33')).statusCode,
      503,
    );
    assert.equal(existsSync(join(f.dir, 'missing.sqlite')), false);
    assert.deepEqual(readFileSync(f.sessionPath), before);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('rejects DNS rebinding, foreign origins, mutation and invalid range parameters', async () => {
  const f = fixture(),
    app = buildApp(f.options);
  try {
    for (const headers of [
      { host: 'evil.example' },
      { host: 'localhost.evil.example' },
      { host: '127.0.0.1', origin: 'http://evil.example' },
      { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' },
    ]) {
      assert.equal(
        (await app.inject({ url: '/api/meta', headers })).statusCode,
        403,
      );
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/meta' })).statusCode,
      403,
    );
    for (const query of [
      'since=-1',
      'until=Infinity',
      'since=2&until=1',
      'since=0&until=2678400001',
      'groupId=11%27',
      'limit=101',
      'limit=0',
      'cursor=bad',
      'foo=bar',
    ]) {
      assert.equal(
        (await app.inject('/api/wakes?' + query)).statusCode,
        400,
        query,
      );
    }
    const r = await app.inject('/api/meta');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('text responses are gzip-compressed only when the client accepts it and the body is large enough', async () => {
  const f = fixture(),
    web = join(f.dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>x</title>');
  const script = `console.log(${JSON.stringify('x'.repeat(4096))});`;
  writeFileSync(join(web, 'assets', 'app.js'), script);
  const app = buildApp({ ...f.options, webRoot: web });
  try {
    const gz = { 'accept-encoding': 'gzip, br' };
    const asset = await app.inject({ url: '/assets/app.js', headers: gz });
    assert.equal(asset.headers['content-encoding'], 'gzip');
    assert.equal(asset.headers.vary, 'Accept-Encoding');
    assert.equal(gunzipSync(asset.rawPayload).toString(), script);
    const plain = await app.inject('/assets/app.js');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body, script);
    // 小响应不压缩；JSON接口与静态文件走同一钩子。
    const small = await app.inject({ url: '/', headers: gz });
    assert.equal(small.headers['content-encoding'], undefined);
    const api = await app.inject({
      url: '/api/wakes/wake-one?groupId=11',
      headers: gz,
    });
    assert.equal(api.statusCode, 200);
    const body = JSON.parse(
      api.headers['content-encoding'] === 'gzip'
        ? gunzipSync(api.rawPayload).toString()
        : api.body,
    );
    assert.equal(body.wake.wakeId, 'wake-one');
    assert.equal(api.headers['content-encoding'], 'gzip');
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('static SPA stays same-origin and unknown APIs do not return HTML', async () => {
  const f = fixture(),
    web = join(f.dir, 'web');
  mkdirSync(web);
  writeFileSync(
    join(web, 'index.html'),
    '<!doctype html><title>Dashboard fixture</title>',
  );
  writeFileSync(join(web, '.secret'), 'SENTINEL');
  const app = buildApp({ ...f.options, webRoot: web });
  try {
    const r = await app.inject({
      url: '/wakes',
      headers: { host: 'localhost:3210', origin: 'http://localhost:3210' },
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Dashboard fixture/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await app.inject('/api/unknown')).statusCode, 404);
    assert.equal((await app.inject('/.secret')).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          url: '/api/meta',
          headers: { host: 'localhost:3210', origin: 'http://localhost:9999' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('query resource bounds report unavailable rather than partial totals', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.telemetryPath);
  db.exec(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO model_requests SELECT 'bulk-'||x,'11','private',100,101,1,'success','chat',1,1,0 FROM n",
  );
  db.close();
  const app = buildApp(f.options);
  try {
    const r = await app.inject('/api/overview?since=0&until=300');
    assert.equal(r.statusCode, 503);
    assert.match(r.json().message, /narrower/);
    assert.doesNotMatch(r.body, /sqlite|SELECT|private/);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('terminal tool outcomes distinguish finished unknown, skipped, errors and future statuses', async () => {
  const f = fixture(),
    db = new DatabaseSync(f.sessionPath);
  const insert = db.prepare(
    'INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)',
  );
  for (const [i, status] of [
    'unknown',
    'skipped',
    'error',
    'future',
    'executed',
  ].entries()) {
    insert.run(
      i + 2,
      'read_events',
      'wake-one',
      'finished',
      sentinel,
      JSON.stringify({ status }),
      110,
      111,
      112,
    );
  }
  db.close();
  const app = buildApp(f.options);
  try {
    const summary = (await app.inject('/api/tools?since=0&until=300')).json()
      .items[0];
    assert.equal(summary.calls, 6);
    assert.equal(summary.finished, 6);
    assert.equal(summary.unknown, 2);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.errors, 1);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('safe model diagnoses distinguish failures, cancellations and timeouts on migrated and old databases', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.telemetryPath);
  db.exec(
    'ALTER TABLE model_requests ADD COLUMN error_code TEXT; ALTER TABLE model_requests ADD COLUMN http_status INTEGER; ALTER TABLE model_requests ADD COLUMN diagnostics TEXT',
  );
  db.prepare(
    "UPDATE model_requests SET status='error',error_code='cancelled',http_status=499,diagnostics=? WHERE request_id='request-one'",
  ).run(
    JSON.stringify({
      abortSource: 'reset',
      failureStage: 'request',
      requestMode: 'continue_restored',
      requestTimeoutMs: 1000,
      providerParameter: sentinel,
      private: sentinel,
    }),
  );
  db.exec(
    "UPDATE model_requests SET error_code='timeout' WHERE request_id='request-two'; UPDATE model_requests SET status='error',error_code='http_error',http_status=503 WHERE request_id='request-three'",
  );
  db.close();
  const app = buildApp(f.options);
  try {
    const summary = (await app.inject('/api/overview?since=0&until=300')).json()
      .summary;
    assert.equal(summary.errors, 1);
    assert.equal(summary.timeouts, 1);
    assert.equal(summary.cancelled, 1);
    assert.equal(summary.successes, 0);
    assert.equal(summary.unknown, 0);
    const detail = await app.inject('/api/wakes/wake-one?groupId=11');
    const request = detail.json().requests[0];
    assert.equal(request.status, 'error');
    assert.equal(request.outcome, 'cancelled');
    assert.equal(request.errorCode, 'cancelled');
    assert.equal(request.httpStatus, 499);
    assert.deepEqual(request.diagnostics, {
      abortSource: 'reset',
      failureStage: 'request',
      requestMode: 'continue_restored',
      requestTimeoutMs: 1000,
    });
    assert.doesNotMatch(detail.body, new RegExp(sentinel));
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('tool reasons safely distinguish barriers, rejection, cancellation, failure and unknown', async () => {
  const f = fixture(),
    db = new DatabaseSync(f.sessionPath);
  const cases = [
    [
      { status: 'error', reason_code: 'image_first', error: sentinel },
      'deferred',
      'image_first',
    ],
    [
      {
        status: 'error',
        error: '先接收本轮图片内容，再在下一轮决定回复或操作。',
      },
      'deferred',
      'image_first',
    ],
    [
      {
        status: 'error',
        error: '先接收本轮转发读取结果，再在下一轮决定回复或操作。',
      },
      'deferred',
      'forward_first',
    ],
    [
      { status: 'error', reason_code: 'management_result_review_required' },
      'deferred',
      'management_result_review_required',
    ],
    [
      { status: 'error', error: 'invalid_arguments' },
      'rejected',
      'invalid_arguments',
    ],
    [{ status: 'error', error: 'tool_disabled' }, 'rejected', 'tool_disabled'],
    [
      { status: 'error', error: 'permission_denied' },
      'rejected',
      'permission_denied',
    ],
    [{ status: 'error', reason: 'cancelled' }, 'cancelled', 'cancelled'],
    [{ status: 'error', error: sentinel }, 'failed', null],
    [
      {
        status: 'error',
        error: '先接收本轮图片内容，再在下一轮决定回复或操作。' + sentinel,
      },
      'failed',
      null,
    ],
    [{ status: 'unknown', error: sentinel }, 'unknown', null],
    [{ status: 'skipped' }, 'skipped', null],
  ] as const;
  const insert = db.prepare(
    'INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)',
  );
  cases.forEach(([result], i) =>
    insert.run(
      i + 2,
      'read_events',
      'wake-one',
      'finished',
      sentinel,
      JSON.stringify({ ...result, private: sentinel }),
      110,
      111,
      112,
    ),
  );
  db.prepare(
    "UPDATE model_session_journal SET payload=? WHERE kind='wake_finish'",
  ).run(
    JSON.stringify({
      reason: 'finished',
      reason_code: 'turn_timeout',
      duration_ms: 50,
      model_rounds: 2,
      tool_calls: -1,
      sent_messages: 1.5,
      private: sentinel,
    }),
  );
  db.close();
  const app = buildApp(f.options);
  try {
    const detail = await app.inject('/api/wakes/wake-one?groupId=11'),
      body = detail.json();
    assert.equal(body.wake.outcome, 'finished');
    assert.equal(body.wake.reasonCode, 'turn_timeout');
    assert.deepEqual(body.wake.diagnostics, {
      duration_ms: 50,
      model_rounds: 2,
    });
    cases.forEach(([, outcome, reason], i) => {
      assert.equal(body.tools[i + 1].outcome, outcome);
      assert.equal(body.tools[i + 1].reasonCode, reason);
      assert.equal(body.tools[i + 1].state, 'finished');
    });
    assert.equal(body.tools[1].status, 'error');
    assert.doesNotMatch(detail.body, new RegExp(sentinel + '|先接收'));
    const summary = (await app.inject('/api/tools?since=0&until=300')).json()
      .items[0];
    assert.equal(summary.deferred, 4);
    assert.equal(summary.rejected, 3);
    assert.equal(summary.cancelled, 1);
    assert.equal(summary.errors, 2);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.handled, 1);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('custom-face fixed diagnostic codes preserve unknown effects and storage failures without exposing text', async () => {
  const f = fixture(),
    db = new DatabaseSync(f.sessionPath);
  const cases = [
    ['unknown', 'previous_operation_unresolved', 'unknown'],
    ['unknown', 'message_ack_unverified', 'unknown'],
    ...[
      'storage_configuration',
      'storage_unavailable',
      'storage_integrity',
      'storage_capacity',
      'storage_invalid_image',
      'invalid_face_ref',
      'resource_not_verified',
      'identity_unverified',
      'source_changed',
      'collection_content_unverified',
    ].map((code) => ['error', code, 'failed']),
    ['unknown', sentinel, 'unknown'],
    ['error', 'storage_capacity:' + sentinel, 'failed'],
  ];
  const insert = db.prepare(
    'INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)',
  );
  cases.forEach(([status, error], i) =>
    insert.run(
      i + 2,
      'send_custom_face',
      'wake-one',
      'finished',
      sentinel,
      JSON.stringify({ status, error, private: sentinel }),
      110,
      111,
      112,
    ),
  );
  db.close();
  const app = buildApp(f.options);
  try {
    const response = await app.inject('/api/wakes/wake-one?groupId=11');
    cases.forEach(([status, code, outcome], i) => {
      const tool = response.json().tools[i + 1];
      assert.equal(tool.status, status);
      assert.equal(tool.outcome, outcome);
      assert.equal(tool.reasonCode, code!.includes(sentinel) ? null : code);
    });
    assert.doesNotMatch(response.body, new RegExp(sentinel));
    const summary = (await app.inject('/api/tools?since=0&until=300'))
      .json()
      .items.find((item: any) => item.name === 'send_custom_face');
    assert.equal(summary.unknown, 3);
    assert.equal(summary.errors, 11);
    assert.equal(summary.handled, 0);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('specific cursor diagnostic preserves invalid-arguments rejection without leaking correction hints', async () => {
  const f = fixture(),
    db = new DatabaseSync(f.sessionPath);
  db.prepare('INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)').run(
    2,
    'read_messages',
    'wake-one',
    'finished',
    sentinel,
    JSON.stringify({
      status: 'error',
      error: 'invalid_arguments',
      reason_code: 'cursor_with_filters',
      hint: sentinel,
    }),
    110,
    111,
    112,
  );
  db.close();
  const app = buildApp(f.options);
  try {
    const response = await app.inject('/api/wakes/wake-one?groupId=11');
    const tool = response.json().tools[1];
    assert.equal(tool.state, 'finished');
    assert.equal(tool.status, 'error');
    assert.equal(tool.outcome, 'rejected');
    assert.equal(tool.reasonCode, 'cursor_with_filters');
    assert.equal(statusLabel(tool.reasonCode), '分页游标不能同时携带查询条件');
    assert.doesNotMatch(response.body, new RegExp(sentinel + '|hint'));
    const summary = (await app.inject('/api/tools?since=0&until=300'))
      .json()
      .items.find((item: any) => item.name === 'read_messages');
    assert.equal(summary.rejected, 1);
    assert.equal(summary.errors, 0);
    assert.equal(summary.handled, 0);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('rotation tool reasons preserve raw unknown state and fixed diagnostics', async () => {
  const f = fixture(),
    db = new DatabaseSync(f.sessionPath);
  const reasons = [
    'owner_reset',
    'recovered_after_crash',
    'configuration_changed',
    'transient_images_lost',
    'transcript_resource_boundary',
    'response_state_expired',
  ];
  const insert = db.prepare(
    'INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)',
  );
  reasons.forEach((reason, i) =>
    insert.run(
      i + 2,
      'read_events',
      'wake-one',
      'unknown',
      sentinel,
      JSON.stringify({ status: 'unknown', reason }),
      110,
      111,
      112,
    ),
  );
  db.close();
  const app = buildApp(f.options);
  try {
    const response = await app.inject('/api/wakes/wake-one?groupId=11');
    reasons.forEach((reason, i) => {
      const tool = response.json().tools[i + 1];
      assert.equal(tool.reasonCode, reason);
      assert.equal(tool.state, 'unknown');
      assert.equal(tool.status, 'unknown');
      assert.equal(tool.outcome, 'unknown');
      assert.notEqual(statusLabel(reason), reason);
    });
    assert.doesNotMatch(response.body, new RegExp(sentinel));
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('old-scope wake session reset projects safe rotation reasons without completing the new wake', async () => {
  const f = fixture(),
    db = new DatabaseSync(f.sessionPath);
  db.prepare(
    "UPDATE model_session_journal SET session_id='new-session' WHERE wake_id='wake-two'",
  ).run();
  const app = buildApp(f.options);
  try {
    for (const reasonCode of [
      'reset',
      'session_rotated',
      'response_state_expired',
      'configuration_changed',
      'transcript_resource_boundary',
      'transient_images_lost',
      'recovered_after_crash',
    ]) {
      db.prepare(
        "UPDATE model_session_journal SET payload=? WHERE wake_id='wake-one' AND kind='wake_finish'",
      ).run(
        JSON.stringify({
          reason: 'session_reset',
          reason_code: reasonCode,
          sent_submissions: 1,
          private: sentinel,
        }),
      );
      const response = await app.inject('/api/wakes/wake-one?groupId=11'),
        wake = response.json().wake;
      assert.equal(wake.sessionId, 'session');
      assert.equal(wake.outcome, 'session_reset');
      assert.equal(wake.reasonCode, reasonCode);
      assert.equal(wake.diagnostics.sent_submissions, 1);
      assert.equal(statusLabel(wake.outcome), '会话重置/轮换');
      assert.doesNotMatch(response.body, new RegExp(sentinel));
      const newer = (await app.inject('/api/wakes/wake-two?groupId=11')).json()
        .wake;
      assert.equal(newer.sessionId, 'new-session');
      assert.equal(newer.outcome, null);
      assert.equal(newer.finishedAt, null);
      assert.equal(newer.reasonCode, null);
    }
  } finally {
    db.close();
    await app.close();
    f.cleanup();
  }
});

test('unavailable telemetry and wrong group identity remain honest', async () => {
  const f = fixture(),
    app = buildApp({
      ...f.options,
      telemetryPath: join(f.dir, 'absent'),
      groups: [{ groupId: '22', sessionPath: f.sessionPath }],
    });
  try {
    const meta = (await app.inject('/api/meta')).json();
    assert.equal(meta.availability.telemetry, false);
    assert.equal(meta.availability.sessions[0].available, false);
    const summary = (await app.inject('/api/overview')).json().summary;
    assert.equal(summary.inputTokens, null);
    assert.equal(summary.cacheHitRate, null);
    assert.equal(summary.cachedInputTokens, null);
    assert.equal(summary.uncachedInputTokens, null);
    assert.equal(existsSync(join(f.dir, 'absent')), false);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('requests are shown, filtered and summarized by configured model name, legacy rows as null', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.telemetryPath);
  db.exec(
    'ALTER TABLE model_requests ADD COLUMN model TEXT; ALTER TABLE model_requests ADD COLUMN model_name TEXT;',
  );
  db.exec(
    "UPDATE model_requests SET model='deepseek-v4.1-flash'; UPDATE model_requests SET model_name='opencode_go' WHERE request_id='request-one'; UPDATE model_requests SET model_name='qunyou_model' WHERE request_id='request-two';",
  );
  db.close();
  const app = buildApp({
    ...f.options,
    models: ['opencode_go', 'qunyou_model'],
  });
  try {
    assert.deepEqual((await app.inject('/api/meta')).json().models, [
      'opencode_go',
      'qunyou_model',
    ]);
    const list = (await app.inject('/api/requests?since=0&until=300')).json();
    assert.deepEqual(
      list.items.map((r: any) => [r.requestId, r.modelName, r.model]).sort(),
      [
        ['request-one', 'opencode_go', 'deepseek-v4.1-flash'],
        ['request-three', null, 'deepseek-v4.1-flash'],
        ['request-two', 'qunyou_model', 'deepseek-v4.1-flash'],
      ],
    );
    const filtered = (
      await app.inject('/api/requests?since=0&until=300&modelName=qunyou_model')
    ).json();
    assert.deepEqual(
      filtered.items.map((r: any) => r.requestId),
      ['request-two'],
    );
    // 请求模型ID不再是筛选条件。
    assert.equal(
      (
        await app.inject(
          '/api/requests?since=0&until=300&modelName=deepseek-v4.1-flash',
        )
      ).json().items.length,
      0,
    );
    for (const bad of ['', 'x'.repeat(129)]) {
      assert.equal(
        (await app.inject(`/api/requests?since=0&until=300&modelName=${bad}`))
          .statusCode,
        400,
      );
    }
    const overview = (
      await app.inject('/api/overview?since=0&until=300')
    ).json();
    assert.deepEqual(
      overview.models.map((m: any) => [m.modelName, m.requests]),
      [
        ['opencode_go', 1],
        ['qunyou_model', 1],
        [null, 1],
      ],
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
