import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSession } from '../../../../src/agent/session/store.ts';
import type { Completion } from '../../../../src/contracts/model.ts';
import type { ToolDefinition } from '../../../../src/contracts/tools.ts';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'send',
      parameters: { type: 'object' },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'finish',
      parameters: { type: 'object' },
    },
  },
];
const call = (id: string, name = 'send_message') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{}' },
});
const completion = (...calls: any[]): Completion => ({
  content: null,
  tool_calls: calls,
});

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-analytics-'));
  return { dir, path: join(dir, 'session.sqlite') };
}

function clean(x: { dir: string }) {
  rmSync(x.dir, { recursive: true, force: true });
}

test('weighted durations, unknown and cached results are classified without claiming native RPCs', (t) => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  const s = new ModelSession({ path: ':memory:' });
  s.beginWake('i', tools);
  const wake = s.state().wakeId!;
  s.appendAssistant(
    completion(call('a'), call('b'), call('c'), call('d')),
    'request',
  );
  s.startTool('a');
  now = 110;
  s.finishTool('a', { status: 'ok', duplicate: true });
  now = 120;
  s.startTool('b');
  now = 150;
  s.finishTool('b', { status: 'unknown', error: 'PRIVATE error body' });
  s.startTool('c');
  now = 170;
  s.finishTool('c', { status: 'unrecognised', private: 'SECRET_RESULT' });
  s.skipPending('budget');
  s.finishTool('a', { status: 'error' });
  const summary = s.summarizeTools({ since: 100, until: 100, wakeId: wake });
  assert.equal(summary.invocations, 4);
  assert.equal(summary.successes, 1);
  assert.equal(summary.unknown, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.totalDurationMs, 60);
  assert.equal(summary.meanDurationMs, 20);
  assert.equal(summary.modelRequests, 1);
  assert.equal(summary.externalRequests, null);
  assert.equal(s.summarizeTools({ since: 101, until: 200 }).invocations, 0);
  assert.equal(
    s.summarizeTools({ since: 0, until: 200, sessionId: 'not-this-session' })
      .invocations,
    0,
  );
  s.close();
});

test('analytics aggregates outcomes, durations, exposure and keeps private args out', () => {
  const x = make();
  try {
    const s = new ModelSession({ path: x.path, groupId: '123456789' });
    s.beginWake('instructions', tools, { trigger: 'a' });
    s.appendAssistant(completion(call('ok')), 'request-a');
    assert.equal(s.startTool('ok'), true);
    s.finishTool('ok', {
      status: 'ok',
      message_id: 'private-1',
      secret: 'do-not-export',
    });
    s.finishWake('done');
    s.beginWake('instructions', tools, { trigger: 'b' });
    s.appendAssistant(completion(call('bad'), call('skip', 'finish')));
    assert.equal(s.startTool('bad'), true);
    s.finishTool('bad', {
      status: 'error',
      error: 'api_failed',
      secret: 'private',
    });
    s.skipPending('budget');
    const summary = s.summarizeTools({ since: 0, until: Date.now() });
    assert.equal(summary.invocations, 3);
    assert.equal(summary.started, 2);
    assert.equal(summary.completed, 3);
    assert.equal(summary.successes, 1);
    assert.equal(summary.errors, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.externalRequests, null);
    assert.ok(summary.modelRequests >= 1);
    assert.ok(
      summary.toolExposureCounts.some(
        (x) => x.name === 'send_message' && x.wakes >= 2,
      ),
    );
    s.close();
  } finally {
    clean(x);
  }
});

test('analytics filters validate scope, inclusive time and limits', () => {
  const x = make();
  try {
    const s = new ModelSession({ path: x.path });
    s.beginWake('i', tools);
    s.appendAssistant(completion(call('a')));
    assert.throws(() => s.summarizeTools({ since: -1, until: 2 }), /window/);
    assert.throws(
      () => s.summarizeTools({ since: 0, until: 1, extra: 1 } as any),
      /filter/,
    );
    s.close();
  } finally {
    clean(x);
  }
});

test('analytics survives reopen and keeps group boundary', () => {
  const x = make();
  try {
    let s = new ModelSession({ path: x.path, groupId: '123456789' });
    s.beginWake('i', tools);
    s.appendAssistant(completion(call('a')));
    s.finishWake();
    s.close();
    s = new ModelSession({ path: x.path, groupId: '123456789' });
    assert.equal(
      s.summarizeTools({ since: 0, until: Date.now() }).invocations,
      1,
    );
    assert.throws(
      () => new ModelSession({ path: x.path, groupId: '100000002' }),
      /group/,
    );
    s.close();
  } finally {
    clean(x);
  }
});
