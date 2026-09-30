import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TelemetryStore,
  type TelemetryRecord,
} from '../../../src/observability/telemetry.ts';
import { performanceMetrics } from '../../../src/dashboard/contracts/metrics.ts';

const base = (id: string): TelemetryRecord => ({
  requestId: id,
  startedAt: 100,
  endedAt: 110,
  durationMs: 10.5,
  transport: 'chat',
  model: 'test',
  status: 'success',
  usage: {},
  groupId: '22',
});

test('telemetry persists nullable counts and cache-weighted paired denominator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  try {
    const path = join(dir, 'usage.sqlite');
    const s = new TelemetryStore(path);
    s.record({
      ...base('1'),
      ttftMs: 2,
      decodeDurationMs: 8,
      usage: { inputTokens: 100, cachedInputTokens: 75, outputTokens: 5 },
    });
    s.record({
      ...base('bad-times'),
      ttftMs: 11,
      decodeDurationMs: 11,
      usage: {},
    });
    s.record({ ...base('2'), usage: { inputTokens: 900 } });
    s.record({
      ...base('3'),
      status: 'error',
      errorCode: 'truncated_response',
      usage: { inputTokens: 100, cachedInputTokens: 25 },
    });
    s.record(base('4'));
    s.record({ ...base('1'), usage: { inputTokens: 9 } });
    const r = s.summarize({ since: 0, until: 1000 });
    assert.equal(r.requests, 5);
    assert.equal(r.cacheKnownInputTokens, 200);
    assert.equal(r.cacheHitRate, 0.5);
    assert.equal(r.missingCacheUsage, 3);
    assert.equal(r.truncatedRequests, 1);
    const db = new DatabaseSync(path, { readOnly: true });
    const timing = db
      .prepare(
        'SELECT ttft_ms,decode_duration_ms FROM model_requests WHERE request_id=?',
      )
      .get('1')!;
    assert.equal(timing.ttft_ms, 2);
    assert.equal(timing.decode_duration_ms, 8);
    const bad = db
      .prepare(
        'SELECT ttft_ms,decode_duration_ms FROM model_requests WHERE request_id=?',
      )
      .get('bad-times')!;
    assert.equal(bad.ttft_ms, null);
    assert.equal(bad.decode_duration_ms, null);
    db.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    s.close();
    const again = new TelemetryStore(path);
    assert.equal(
      again.summarize({ since: 0, until: 1000, groupId: '23' }).requests,
      0,
    );
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zero decode duration is persisted rather than discarded and cannot divide by zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-zero-')),
    path = join(dir, 'usage.sqlite');
  try {
    const store = new TelemetryStore(path);
    store.record({
      ...base('zero'),
      ttftMs: 2,
      decodeDurationMs: 0,
      usage: { outputTokens: 56, reasoningTokens: 30 },
    });
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT * FROM model_requests WHERE request_id=?')
        .get('zero')!;
      assert.equal(row.decode_duration_ms, 0);
      assert.equal(row.output_tokens, 56);
      assert.equal(row.reasoning_tokens, 30);
      assert.equal(performanceMetrics([row]).tps, null);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decode migration isolates contaminated generation timings and rotates sync epoch once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-migrate-')),
    path = join(dir, 'usage.sqlite');
  try {
    const initial = new TelemetryStore(path);
    initial.record({
      ...base('old'),
      ttftMs: 2,
      decodeDurationMs: 1,
      usage: { outputTokens: 20 },
    });
    initial.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      'ALTER TABLE model_requests RENAME COLUMN decode_duration_ms TO generation_duration_ms',
    );
    const epoch = legacy.prepare('SELECT epoch FROM request_change_meta').get()!
      .epoch;
    legacy.close();
    const upgraded = new TelemetryStore(path);
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db
      .prepare('SELECT * FROM model_requests WHERE request_id=?')
      .get('old')!;
    assert.equal(row.generation_duration_ms, 1);
    assert.equal(row.decode_duration_ms, null);
    assert.equal(row.ttft_ms, 2);
    assert.equal(performanceMetrics([row]).tps, null);
    const migratedEpoch = db
      .prepare('SELECT epoch FROM request_change_meta')
      .get()!.epoch;
    assert.notEqual(migratedEpoch, epoch);
    upgraded.record({
      ...base('new'),
      ttftMs: 2,
      decodeDurationMs: 8,
      usage: { outputTokens: 20 },
    });
    const fresh = db
      .prepare('SELECT * FROM model_requests WHERE request_id=?')
      .get('new')!;
    assert.equal(fresh.generation_duration_ms, null);
    assert.equal(fresh.decode_duration_ms, 8);
    assert.equal(performanceMetrics([fresh]).tps, 2500);
    upgraded.close();
    const reopened = new TelemetryStore(path);
    assert.equal(
      db.prepare('SELECT epoch FROM request_change_meta').get()!.epoch,
      migratedEpoch,
    );
    reopened.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid ranges and symlink paths fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  try {
    const path = join(dir, 'usage.sqlite'),
      s = new TelemetryStore(path);
    assert.throws(() => s.summarize({ since: -1, until: 20 }));
    assert.throws(() => s.summarize({ since: 0, until: 20, groupId: '' }));
    s.close();
    symlinkSync(path, join(dir, 'link'));
    assert.throws(() => new TelemetryStore(join(dir, 'link')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
