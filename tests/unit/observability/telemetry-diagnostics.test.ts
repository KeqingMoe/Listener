import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TelemetryStore,
  type TelemetryRecord,
} from '../../../src/observability/telemetry.ts';

const base = (requestId: string): TelemetryRecord => ({
  requestId,
  startedAt: 100,
  endedAt: 110,
  durationMs: 10,
  transport: 'chat',
  model: 'test',
  status: 'success',
  usage: {},
});

function temporaryDatabase(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'test.sqlite');
}

function oldDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE model_requests (
      request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
      duration_ms REAL NOT NULL, transport TEXT NOT NULL, model TEXT NOT NULL,
      status TEXT NOT NULL, error_code TEXT, http_status INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      cached_input_tokens INTEGER, reasoning_tokens INTEGER,
      group_id TEXT, turn_id TEXT, phase TEXT
    );
    INSERT INTO model_requests(request_id,started_at,ended_at,duration_ms,transport,model,status,input_tokens)
      VALUES('old',100,110,10,'chat','test','success',20);`);
  } finally {
    db.close();
  }
}

function rows(path: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT request_id, diagnostics FROM model_requests ORDER BY request_id',
      )
      .all();
  } finally {
    db.close();
  }
}

test('old telemetry schema migrates nullable diagnostics and reopens idempotently', (t) => {
  const path = temporaryDatabase(t);
  oldDatabase(path);
  for (let i = 0; i < 3; i++) {
    const store = new TelemetryStore(path);
    try {
      assert.equal(store.summarize({ since: 0, until: 1000 }).inputTokens, 20);
      store.record(base('new'));
    } finally {
      store.close();
    }
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = db
      .prepare('PRAGMA table_info(model_requests)')
      .all()
      .filter((row) => row.name === 'diagnostics');
    assert.equal(columns.length, 1);
    assert.equal(columns[0].type, 'TEXT');
    assert.equal(columns[0].notnull, 0);
    assert.equal(columns[0].dflt_value, null);
  } finally {
    db.close();
  }
  assert.deepEqual(
    rows(path).map((row) => [row.request_id, row.diagnostics]),
    [
      ['new', null],
      ['old', null],
    ],
  );
});

test('fresh telemetry stores only allowlisted normalized diagnostics and no private bytes', (t) => {
  const path = temporaryDatabase(t);
  const store = new TelemetryStore(path);
  const secret = 'PRIVATE_TELEMETRY_SECRET_19df36';
  let invoked = 0;
  const hostile = {
    abortSource: 'request_timeout',
    providerCategory: 'rate_limit',
    providerParameter: 'input',
    failureStage: 'http_status',
    requestMode: 'continue_restored',
    requestTimeoutMs: 1500,
    body: secret,
    prompt: secret,
    apiKey: secret,
    arbitrary: { nested: secret },
    toJSON() {
      invoked++;
      return { secret };
    },
  } as const;
  try {
    store.record({ ...base('valid'), diagnostics: hostile });
    store.record({
      ...base('invalid'),
      diagnostics: {
        abortSource: secret,
        providerCategory: secret,
        providerParameter: secret,
        failureStage: secret,
        requestMode: secret,
        requestTimeoutMs: Number.MAX_SAFE_INTEGER,
      } as never,
    });
    store.record({
      ...base('partial'),
      diagnostics: {
        failureStage: 'response_parse',
        requestTimeoutMs: -1,
        prompt: secret,
      } as never,
    });
    store.record(base('absent'));
  } finally {
    store.close();
  }
  const saved = new Map(
    rows(path).map((row) => [row.request_id, row.diagnostics]),
  );
  assert.deepEqual(JSON.parse(saved.get('valid') as string), {
    abortSource: 'request_timeout',
    providerCategory: 'rate_limit',
    providerParameter: 'input',
    failureStage: 'http_status',
    requestMode: 'continue_restored',
    requestTimeoutMs: 1500,
  });
  assert.deepEqual(JSON.parse(saved.get('partial') as string), {
    failureStage: 'response_parse',
  });
  assert.equal(saved.get('invalid'), null);
  assert.equal(saved.get('absent'), null);
  assert.equal(invoked, 0);
  assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
});

test('diagnostics getters, inherited values and proxies are never invoked or persisted', (t) => {
  const path = temporaryDatabase(t);
  const store = new TelemetryStore(path);
  let invoked = 0;
  const trap = () => {
    invoked++;
    throw new Error('Private getter or proxy invoked');
  };
  const proxy = new Proxy(
    {},
    {
      get: trap,
      getOwnPropertyDescriptor: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  try {
    const getterRecord = base('getter');
    Object.defineProperty(getterRecord, 'diagnostics', { get: trap });
    store.record(getterRecord);
    const inherited = Object.assign(
      Object.create({ diagnostics: { failureStage: 'request' } }),
      base('inherited'),
    );
    store.record(inherited);
    store.record({ ...base('proxy'), diagnostics: proxy });
    store.record({ ...base('revoked'), diagnostics: revoked.proxy });
    const getters = Object.defineProperty({}, 'failureStage', { get: trap });
    store.record({ ...base('nested-getter'), diagnostics: getters });
    assert.throws(
      () =>
        store.record(
          new Proxy(base('record-proxy'), {
            get: trap,
            getOwnPropertyDescriptor: trap,
          }),
        ),
      /Invalid telemetry record/,
    );
    assert.throws(
      () => store.record(revoked.proxy as TelemetryRecord),
      /Invalid telemetry record/,
    );
  } finally {
    store.close();
  }
  assert.equal(invoked, 0);
  assert.equal(rows(path).length, 5);
  assert.ok(rows(path).every((row) => row.diagnostics === null));
});

test('concurrent old-schema openers serialize diagnostics migration', async (t) => {
  const path = temporaryDatabase(t);
  oldDatabase(path);
  const moduleUrl = new URL(
    '../../../src/observability/telemetry.ts',
    import.meta.url,
  ).href;
  await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              '--input-type=module',
              '-e',
              `import { TelemetryStore } from ${JSON.stringify(moduleUrl)}; const store = new TelemetryStore(${JSON.stringify(path)}); store.close();`,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (data) => {
            stderr += String(data);
          });
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`Migration child exited ${code}: ${stderr}`)),
          );
        }),
    ),
  );
  assert.deepEqual(
    rows(path).map((row) => [row.request_id, row.diagnostics]),
    [['old', null]],
  );
});

test('failed initialization rolls back schema changes and releases the transaction', (t) => {
  const path = temporaryDatabase(t);
  const seed = new DatabaseSync(path);
  seed.exec(
    'CREATE TABLE model_requests(request_id TEXT PRIMARY KEY, started_at INTEGER);',
  );
  seed.close();
  assert.throws(() => new TelemetryStore(path), /group_id/);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=50; BEGIN IMMEDIATE;');
    assert.equal(
      db
        .prepare('PRAGMA table_info(model_requests)')
        .all()
        .some((row) => row.name === 'diagnostics'),
      false,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='model_requests_started'",
        )
        .get()?.count,
      0,
    );
    db.exec('COMMIT;');
  } finally {
    db.close();
  }
});
