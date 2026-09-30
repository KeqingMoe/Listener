import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TelemetryStore,
  type TelemetryRecord,
} from '../../../src/observability/telemetry.ts';

// inspection有7天保留期，时间戳须接近当前时刻。
const NOW = Date.now();
const record = (requestId: string, modelName?: string): TelemetryRecord => ({
  requestId,
  startedAt: NOW,
  endedAt: NOW + 10,
  durationMs: 10,
  transport: 'chat',
  model: 'deepseek-v4.1-flash',
  status: 'success',
  usage: {},
  groupId: '11',
  ...(modelName === undefined ? {} : { modelName }),
});

function temporaryDatabase(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-model-name-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'telemetry.sqlite');
}

function read(path: string, table: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT request_id,model,model_name FROM ${table} ORDER BY request_id`,
      )
      .all()
      .map((row) => [row.request_id, row.model, row.model_name]);
  } finally {
    db.close();
  }
}

test('the configured model name is stored beside the unchanged request model id', (t) => {
  const path = temporaryDatabase(t);
  const store = new TelemetryStore(path);
  try {
    store.beginRequest({
      requestId: 'a',
      startedAt: NOW,
      transport: 'chat',
      model: 'deepseek-v4.1-flash',
      requestJson: '{}',
      requestMode: 'fresh',
      groupId: '11',
      modelName: 'qunyou_model',
    });
    store.record(record('a', 'qunyou_model'));
    store.record(record('b'));
    // 非法文本不写入模型名，但不影响用量记录。
    store.record(record('c', 'bad\nname'));
  } finally {
    store.close();
  }
  const expected = [
    ['a', 'deepseek-v4.1-flash', 'qunyou_model'],
    ['b', 'deepseek-v4.1-flash', null],
    ['c', 'deepseek-v4.1-flash', null],
  ];
  assert.deepEqual(read(path, 'model_requests'), expected);
  assert.deepEqual(read(path, 'model_request_inspections'), expected);
});

test('old telemetry tables gain a nullable model_name column idempotently', (t) => {
  const path = temporaryDatabase(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE model_requests (
      request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
      duration_ms REAL NOT NULL, transport TEXT NOT NULL, model TEXT NOT NULL,
      status TEXT NOT NULL, error_code TEXT, http_status INTEGER,
      ttft_ms REAL, decode_duration_ms REAL,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      cached_input_tokens INTEGER, reasoning_tokens INTEGER,
      group_id TEXT, turn_id TEXT, phase TEXT, diagnostics TEXT
    );
    CREATE TABLE model_request_inspections (
      request_id TEXT PRIMARY KEY, group_id TEXT, turn_id TEXT, wake_id TEXT, phase TEXT,
      started_at INTEGER, ended_at INTEGER, transport TEXT, model TEXT, status TEXT,
      request_json TEXT, response_json TEXT, reasoning_text TEXT, error_text TEXT,
      response_id TEXT, previous_response_id TEXT, provider_request_id TEXT, request_mode TEXT,
      content_truncated INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO model_requests(request_id,started_at,ended_at,duration_ms,transport,model,status)
      VALUES('old',100,110,10,'chat','legacy-id','success');`);
  db.close();
  for (let i = 0; i < 2; i++) {
    const store = new TelemetryStore(path);
    try {
      store.record(record(`new${i}`, 'main'));
    } finally {
      store.close();
    }
  }
  assert.deepEqual(read(path, 'model_requests'), [
    ['new0', 'deepseek-v4.1-flash', 'main'],
    ['new1', 'deepseek-v4.1-flash', 'main'],
    ['old', 'legacy-id', null],
  ]);
  assert.deepEqual(
    read(path, 'model_request_inspections').map((row) => row[2]),
    ['main', 'main'],
  );
});
