import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  endedAt: 120,
  durationMs: 20,
  transport: 'chat',
  model: 'test',
  status: 'success',
  usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 2 },
});

for (const legacy of [false, true]) {
  test(`reasoning columns persist and migrate without backfill (legacy=${legacy})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-reasoning-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'test.sqlite');
    if (legacy) {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE model_requests (
        request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
        duration_ms REAL NOT NULL, transport TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, error_code TEXT, http_status INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        cached_input_tokens INTEGER, reasoning_tokens INTEGER,
        group_id TEXT, turn_id TEXT, phase TEXT
      );
      INSERT INTO model_requests(request_id,started_at,ended_at,duration_ms,transport,model,status,reasoning_tokens)
      VALUES('old',100,120,20,'chat','test','success',10);`);
      db.close();
    }
    const cases: Array<
      [string, Partial<TelemetryRecord>, number | null, string | null]
    > = [
      [
        'zero',
        { reasoningDurationMs: 0, reasoningTimingStatus: 'complete' },
        0,
        'complete',
      ],
      [
        'fraction',
        { reasoningDurationMs: 1.25, reasoningTimingStatus: 'complete' },
        1.25,
        'complete',
      ],
      [
        'partial',
        {
          reasoningDurationMs: 2,
          reasoningTimingStatus: 'partial',
          status: 'error',
        },
        2,
        'partial',
      ],
      [
        'open',
        { reasoningDurationMs: null, reasoningTimingStatus: 'partial' },
        null,
        'partial',
      ],
      [
        'none',
        { reasoningDurationMs: null, reasoningTimingStatus: 'not_observed' },
        null,
        'not_observed',
      ],
      ['absent', {}, null, null],
      [
        'nan',
        { reasoningDurationMs: NaN, reasoningTimingStatus: 'complete' },
        null,
        'partial',
      ],
      [
        'infinite',
        { reasoningDurationMs: Infinity, reasoningTimingStatus: 'complete' },
        null,
        'partial',
      ],
      [
        'negative',
        { reasoningDurationMs: -1, reasoningTimingStatus: 'complete' },
        null,
        'partial',
      ],
      [
        'over',
        { reasoningDurationMs: 21, reasoningTimingStatus: 'complete' },
        null,
        'partial',
      ],
      [
        'error-complete',
        {
          reasoningDurationMs: 3,
          reasoningTimingStatus: 'complete',
          status: 'error',
        },
        3,
        'partial',
      ],
      [
        'none-duration',
        { reasoningDurationMs: 3, reasoningTimingStatus: 'not_observed' },
        null,
        'not_observed',
      ],
      [
        'unknown',
        {
          reasoningDurationMs: 3,
          reasoningTimingStatus: 'invalid' as 'complete',
        },
        null,
        null,
      ],
    ];
    const store = new TelemetryStore(path);
    for (const [id, extra] of cases) {
      store.record({ ...base(id), ...extra });
    }
    store.close();
    // Reopening is idempotent and must not rewrite old or newly stored values.
    new TelemetryStore(path).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const [id, , duration, status] of cases) {
        const row = db
          .prepare('SELECT * FROM model_requests WHERE request_id=?')
          .get(id)!;
        assert.equal(row.reasoning_duration_ms, duration, id);
        assert.equal(row.reasoning_timing_status, status, id);
        assert.equal(row.reasoning_tokens, 2);
      }
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM model_requests').get()!.n,
        cases.length + Number(legacy),
      );
      if (legacy) {
        const row = db
          .prepare("SELECT * FROM model_requests WHERE request_id='old'")
          .get()!;
        assert.equal(row.reasoning_duration_ms, null);
        assert.equal(row.reasoning_timing_status, null);
        assert.equal(row.reasoning_tokens, 10);
      }
    } finally {
      db.close();
    }
  });
}
