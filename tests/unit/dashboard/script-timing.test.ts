import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewTool } from '../../../src/dashboard/contracts/review.ts';
import {
  isScriptWaiting,
  scriptTiming,
} from '../../../src/dashboard/web/src/components/review/script-timing.ts';

const tool: ReviewTool = {
  name: 'execute_javascript',
  ordinal: 1,
  requestId: 'request',
  callId: 'call',
  state: 'started',
  outcome: 'started',
  status: null,
  reasonCode: null,
  proposedAt: 10000,
  startedAt: 50000,
  finishedAt: null,
  durationMs: null,
  arguments: {
    mode: 'sync',
    wait_ms: 5000,
    description: 'fixture',
    code: 'return "ok";',
  },
  result: null,
};

function args(arguments_: unknown) {
  return { ...tool, arguments: arguments_ };
}

test('script wait is exact configuration, not elapsed duration or an execution default', () => {
  for (const [wait, text] of [
    [1, '1 毫秒'],
    [999, '999 毫秒'],
    [1000, '1 秒'],
    [1001, '1.001 秒'],
    [5000, '5 秒'],
    [2147483647, '2147483.647 秒'],
  ] as const) {
    const view = scriptTiming(args({ mode: 'sync', wait_ms: wait }), 50000)!;
    assert.equal(view.setting, `最多等待 ${text}，超时终止`);
    assert.match(view.title, /包含排队与启动/);
  }
  const completed: ReviewTool = {
    ...tool,
    state: 'finished',
    outcome: 'handled',
    finishedAt: 50200,
    durationMs: 200,
    result: { status: 'ok' },
  };
  const history = scriptTiming(completed, 90000)!;
  assert.equal(history.setting, '最多等待 5 秒，超时终止');
  assert.equal(history.progress, '');
});

test('live sync and auto countdowns use the call start, stop at zero and never invent terminal results', () => {
  for (const mode of ['sync', 'auto']) {
    const running = args({ mode, wait_ms: 5000 });
    const action = mode === 'auto' ? '转后台' : '超时终止';
    assert.equal(isScriptWaiting(running), true);
    assert.equal(scriptTiming(running, 50000)?.progress, `约 5 秒后${action}`);
    assert.equal(scriptTiming(running, 52000)?.progress, `约 3 秒后${action}`);
    assert.equal(scriptTiming(running, 54999)?.progress, `约 1 秒后${action}`);
    for (const now of [55000, 60000, 999999999]) {
      assert.equal(
        scriptTiming(running, now)?.progress,
        '已到预计时限，等待状态更新',
      );
    }
  }
  assert.equal(
    scriptTiming(args({ mode: 'auto', wait_ms: 5000 }), 50000)?.setting,
    '最多等待 5 秒，未完成则转后台',
  );
});

test('pending calls do not count queue time before dispatch and missing start times are not guessed', () => {
  const pending: ReviewTool = {
    ...tool,
    state: 'pending',
    outcome: 'pending',
    startedAt: null,
  };
  assert.equal(isScriptWaiting(pending), false);
  assert.equal(scriptTiming(pending, 60000)?.progress, '尚未开始计时');
  for (const startedAt of [null, NaN, Infinity, -1]) {
    const missing = { ...tool, startedAt };
    assert.equal(isScriptWaiting(missing), false);
    assert.equal(
      scriptTiming(missing, 52000)?.progress,
      '开始时间未记录，无法倒计时',
    );
  }
  assert.equal(
    scriptTiming(tool, 48000)?.progress,
    '开始时间晚于估计当前时间，等待校准',
  );
  // HTTP Date只有秒精度，小量误差不让剩余时间大于配置值。
  assert.equal(scriptTiming(tool, 49500)?.progress, '约 5 秒后超时终止');
});

test('terminal, returned, interrupted and background calls have no live countdown', () => {
  const cases: ReviewTool[] = [
    {
      ...tool,
      state: 'finished',
      outcome: 'handled',
      result: { status: 'pending', job_id: 'job' },
    },
    {
      ...tool,
      state: 'finished',
      outcome: 'failed',
      result: { status: 'error', task_status: 'timeout' },
    },
    { ...tool, state: 'finished', outcome: 'cancelled' },
    { ...tool, state: 'unknown', outcome: 'unknown' },
    { ...tool, state: 'skipped', outcome: 'skipped' },
    { ...tool, finishedAt: 50010 },
    { ...tool, result: { status: 'pending' } },
    { ...tool, status: 'ok' },
  ];
  for (const ended of cases) {
    assert.equal(isScriptWaiting(ended), false);
    assert.equal(scriptTiming(ended, 52000)?.progress, '');
  }
});

test('invalid or absent waits never become defaults, and async/query/unknown modes have no countdown', () => {
  for (const mode of ['sync', 'auto']) {
    assert.equal(
      scriptTiming(args({ mode }), 50000)?.setting,
      '等待时限未记录',
    );
    assert.equal(
      scriptTiming(args({ mode, waitMs: 5000 }), 50000)?.setting,
      '等待时限未记录',
    );
    for (const wait_ms of [
      undefined,
      null,
      '5000',
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      2147483648,
      {},
      [],
    ]) {
      const invalid = args({ mode, wait_ms });
      assert.equal(isScriptWaiting(invalid), false);
      assert.equal(scriptTiming(invalid, 50000)?.setting, '等待时限无效');
      assert.equal(scriptTiming(invalid, 50000)?.progress, '');
    }
  }
  const background = args({ mode: 'async', wait_ms: 5000 });
  assert.equal(isScriptWaiting(background), false);
  assert.equal(scriptTiming(background, 50000)?.setting, '立即返回');
  assert.equal(scriptTiming(background, 50000)?.progress, '');
  assert.equal(
    scriptTiming({ ...tool, name: 'query_javascript_jobs' }, 50000),
    null,
  );
  for (const arguments_ of [
    null,
    [],
    'invalid',
    {},
    { mode: 'future', wait_ms: 5 },
    { mode: { toString: 1 }, wait_ms: 5 },
  ]) {
    assert.equal(scriptTiming(args(arguments_), 50000), null);
    assert.equal(isScriptWaiting(args(arguments_)), false);
  }
});
