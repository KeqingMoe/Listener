import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewTool } from '../../../src/dashboard/contracts/review.ts';
import { toolEvidence } from '../../../src/dashboard/web/src/components/review/tool-evidence.ts';

const tool = (overrides: Partial<ReviewTool> = {}): ReviewTool => ({
  ordinal: 1,
  name: 'send_message',
  requestId: null,
  callId: null,
  state: 'finished',
  status: 'ok',
  outcome: 'handled',
  reasonCode: null,
  proposedAt: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  arguments: { text: '请求内容不能证明发送结果' },
  result: { status: 'ok' },
  ...overrides,
});

for (const [state, text] of [
  ['pending', '尚未执行'],
  ['started', '执行中，尚未返回'],
  ['finished', '结果未记录'],
] as const) {
  test(`${state} with no result never infers success from handled or metadata`, () => {
    assert.equal(toolEvidence(tool({ state, result: null })).text, text);
  });
}

test('unknown ledger takes precedence over historical ok and submitted results', () => {
  for (const result of [{ status: 'ok' }, { status: 'ok', submitted: true }]) {
    const evidence = toolEvidence(tool({ state: 'unknown', result }));
    assert.equal(evidence.text, '账本结果未知');
    assert.equal(evidence.tone, 'warning');
  }
});

for (const status of ['ok', 'executed', 'success']) {
  test(`explicit ${status} reports only top-level tool success`, () => {
    const evidence = toolEvidence(tool({ status, result: { status } }));
    assert.equal(evidence.text, '工具返回成功');
    assert.equal(evidence.tone, 'neutral');
    assert.match(evidence.title, /仅顶层返回/);
  });
}

test('unknown outcomes, unfinished or novel ledger states cannot become success', () => {
  for (const overrides of [
    { outcome: 'unknown' },
    { outcome: 'failed' },
    { state: 'pending' },
    { state: 'started' },
    { state: 'novel' },
  ] satisfies Partial<ReviewTool>[]) {
    assert.equal(toolEvidence(tool(overrides)).text, '状态未识别');
  }
});

test('Submitted shape is submitted even when its status and metadata say ok', () => {
  for (const result of [
    { status: 'submitted' },
    {
      status: 'ok',
      submitted: true,
      effect_confirmed: false,
      delivery_confirmed: false,
    },
    { status: 'ok', submitted: true },
    { status: 'executed', submitted: true },
  ]) {
    const evidence = toolEvidence(tool({ result }));
    assert.equal(evidence.text, '已提交，外部结果未确认');
    assert.equal(evidence.tone, 'warning');
  }
});

test('Unknown shape explains uncertainty and explicit no-retry without inventing fields', () => {
  const evidence = toolEvidence(
    tool({
      status: 'unknown',
      outcome: 'unknown',
      result: {
        status: 'unknown',
        error: 'delivery_unknown',
        effect_unknown: true,
        retry_allowed: false,
      },
    }),
  );
  assert.equal(evidence.text, '结果未知，外部效果未确认');
  assert.match(evidence.title, /可能已生效/);
  assert.match(evidence.title, /不允许重试/);
  assert.doesNotMatch(
    toolEvidence(tool({ result: { status: 'unknown' } })).title,
    /不允许重试/,
  );
  assert.equal(
    toolEvidence(tool({ result: { status: 'ok', effect_unknown: true } })).text,
    evidence.text,
  );
});

for (const [status, text] of [
  ['confirmation_required', '待确认'],
  ['staged', '已暂存，待后续处理'],
  ['pending', '结果待定'],
] as const) {
  test(`${status} is not success`, () => {
    const evidence = toolEvidence(tool({ result: { status } }));
    assert.equal(evidence.text, text);
    assert.equal(evidence.tone, 'warning');
  });
}

test('execute_javascript pending is a foreground handle, not background completion', () => {
  const evidence = toolEvidence(
    tool({
      name: 'execute_javascript',
      result: { status: 'pending', job_id: 'job-1' },
    }),
  );
  assert.equal(evidence.text, '已返回后台句柄，任务未确认完成');
  assert.match(evidence.title, /可能排队或运行/);
  assert.equal(
    toolEvidence(
      tool({ name: 'execute_javascript', result: { status: 'pending' } }),
    ).text,
    '状态未识别',
  );
});

test('duplicate markers qualify returned evidence without claiming a new execution', () => {
  for (const result of [
    { status: 'duplicate' },
    { status: 'ok', duplicate: true },
    { status: 'ok', submitted: true, duplicate: true },
    { status: 'unknown', duplicate: true },
    { status: 'error', duplicate: true },
  ]) {
    const evidence = toolEvidence(tool({ result }));
    assert.match(evidence.text, /^复用\/重复结果/);
    assert.doesNotMatch(evidence.text, /成功/);
    assert.match(evidence.title, /不证明没有副作用/);
  }
  assert.match(
    toolEvidence(
      tool({ state: 'unknown', result: { status: 'ok', duplicate: true } }),
    ).text,
    /账本结果未知/,
  );
});

for (const [result, text, tone] of [
  [{ status: 'error', error: 'unexpected' }, '工具返回错误', 'error'],
  [{ status: 'error', error: 'permission_denied' }, '工具返回拒绝', 'error'],
  [{ status: 'error', reason: 'image_first' }, '调用暂缓', 'warning'],
  [{ status: 'cancelled' }, '调用已取消，副作用未确认', 'warning'],
  [
    { status: 'error', error: 'cancelled' },
    '调用已取消，副作用未确认',
    'warning',
  ],
  [{ status: 'skipped' }, '调用已跳过', 'neutral'],
] as const) {
  test(`non-success evidence: ${JSON.stringify(result)}`, () => {
    const evidence = toolEvidence(tool({ result }));
    assert.equal(evidence.text, text);
    assert.equal(evidence.tone, tone);
    assert.match(evidence.title, /不.*撤销/);
  });
}

test('ledger skipped and cancelled outcomes cannot be masked by ok', () => {
  assert.equal(toolEvidence(tool({ state: 'skipped' })).text, '调用已跳过');
  assert.equal(
    toolEvidence(tool({ outcome: 'cancelled' })).text,
    '调用已取消，副作用未确认',
  );
  const evidence = toolEvidence(
    tool({ result: { status: 'ok', cancelled_after_dispatch: true } }),
  );
  assert.equal(evidence.text, '派发后标记取消，副作用未确认撤销');
  assert.equal(evidence.tone, 'warning');
});

test('unknown, missing and malformed results are not guessed from metadata or intent', () => {
  for (const result of [
    {},
    { status: 'novel' },
    { status: 'background' },
    { status: true },
    { status: 'OK' },
    { value: 'ok', message_id: '1' },
    [],
    'ok',
    '{"status":"ok"}',
    0,
    false,
  ]) {
    assert.equal(toolEvidence(tool({ result })).text, '状态未识别');
  }
  assert.equal(toolEvidence(tool({ result: undefined })).text, '结果未记录');
});

test('only strict boolean markers are interpreted and raw JSON remains unchanged', () => {
  const input = tool({
    name: 'execute_javascript',
    result: {
      status: 'ok',
      submitted: 'true',
      duplicate: 'true',
      effect_unknown: 'true',
      value: '{"status":"error"}',
      tool_calls: [{ status: 'error' }],
    },
  });
  const before = structuredClone(input);
  const evidence = toolEvidence(input);
  assert.equal(evidence.text, '工具返回成功');
  assert.match(evidence.title, /不泛指.*内部步骤全部成功/);
  assert.match(evidence.title, /原始 JSON 保留/);
  assert.deepEqual(input, before);
});
