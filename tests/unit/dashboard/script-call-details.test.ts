import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scriptCallDetails } from '../../../src/dashboard/web/src/components/review/script-call-details.ts';

const row = (status = 'error', seq: unknown = 0) => ({
  seq,
  tool: 'send_message',
  status,
  error: 'SEND_FAILED: 原始错误码',
});
const summary = (overrides: Record<string, unknown> = {}) => ({
  counts: { send_message: { ok: 3, error: 1 } },
  abnormal: [row()],
  abnormal_omitted: 0,
  ...overrides,
});
const parse = (value: unknown) =>
  scriptCallDetails('execute_javascript', { status: 'ok', tool_calls: value });
const notices = (value: unknown) => parse(value)?.notices.join('\n') ?? '';

test('supports both tool names and summary spellings without trusting outer ok', () => {
  for (const name of ['execute_javascript', 'query_javascript_jobs']) {
    for (const field of ['tool_calls', 'toolCalls']) {
      const payload = { [field]: summary() };
      const result = scriptCallDetails(
        name,
        name === 'execute_javascript'
          ? { status: 'ok', ...payload }
          : { status: 'ok', job: payload },
      );
      assert.deepEqual(result?.items, [
        {
          seq: 0,
          tool: 'send_message',
          status: 'error',
          label: '工具返回错误',
          detail:
            '工具返回错误，不代表已有副作用已撤销。\nSEND_FAILED: 原始错误码',
          tone: 'error',
        },
      ]);
      assert.deepEqual(result!.notices, []);
    }
  }
});

test('null for unrelated tools, absent summaries and complete all-ok summaries', () => {
  assert.equal(scriptCallDetails('other', { tool_calls: summary() }), null);
  for (const value of [null, undefined, 4, 'text', [], {}, { status: 'ok' }]) {
    assert.equal(scriptCallDetails('execute_javascript', value), null);
    assert.equal(scriptCallDetails('query_javascript_jobs', value), null);
  }
  assert.equal(
    parse(summary({ counts: { a: { ok: 2 } }, abnormal: [] })),
    null,
  );
  assert.equal(
    scriptCallDetails('query_javascript_jobs', {
      tool_calls: summary(),
      jobs: [],
    }),
    null,
  );
});

test('unknown, confirmation and novel statuses retain distinct warning meanings', () => {
  const result = parse(
    summary({
      counts: { a: { unknown: 1, confirmation_required: 1, novel_status: 1 } },
      abnormal: [
        row('unknown'),
        row('confirmation_required'),
        row('novel_status'),
      ],
    }),
  )!;
  assert.deepEqual(
    result.items.map((item) => item.label),
    ['结果未知', '待确认', 'novel_status'],
  );
  assert.ok(result.items.every((item) => item.tone === 'warning'));
  assert.match(result.items[0]!.detail, /不能断定未执行/);
  assert.match(result.items[1]!.detail, /不应视为失败/);
  assert.equal(result.items[2]!.status, 'novel_status');
});

test('missing details and server omissions explicitly describe unavailable evidence', () => {
  for (const abnormal of [undefined, null, [], 'bad']) {
    assert.match(notices(summary({ abnormal })), /明细未提供/);
  }
  const text = notices(summary({ abnormal_omitted: 7 }));
  assert.match(text, /另有 7 条内部非 ok 调用未包含在返回中/);
  assert.doesNotMatch(text, /展开|加载|获取/);
});

test('only positive safe integer counts establish non-ok evidence', () => {
  for (const count of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '5',
    null,
    {},
  ]) {
    const text = notices(
      summary({ counts: { a: { error: count } }, abnormal: [] }),
    );
    assert.match(text, /计数无效/);
    assert.doesNotMatch(text, /内部调用汇总/);
    assert.doesNotMatch(text, /无异常/);
  }
  assert.match(
    notices(
      summary({
        counts: { a: { novel: Number.MAX_SAFE_INTEGER } },
        abnormal: [],
      }),
    ),
    /汇总存在非 ok 调用，但明细未提供/,
  );
});

test('unrecognized and malformed summaries do not imply success', () => {
  for (const value of [
    false,
    3,
    'bad',
    [],
    {},
    { counts: [] },
    { counts: { a: null } },
  ]) {
    const result = parse(value);
    assert.ok(result);
    assert.ok(result.notices.length);
    assert.doesNotMatch(result.notices.join('\n'), /无异常/);
  }
  for (const abnormal of [[null], [false], [4], ['bad'], [row('ok')], [{}]]) {
    assert.match(notices(summary({ abnormal })), /不完整/);
  }
});

test('missing tool and invalid sequence retain row with explicit incompleteness notice', () => {
  for (const seq of [
    undefined,
    null,
    -1,
    1.2,
    '1',
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const result = parse(summary({ abnormal: [{ status: 'error', seq }] }))!;
    assert.equal(result.items[0]!.seq, null);
    assert.equal(result.items[0]!.tool, '工具名未记录');
    assert.match(result.notices.join('\n'), /序号或工具名/);
  }
  assert.equal(
    parse(summary({ abnormal: [row('error', Number.MAX_SAFE_INTEGER)] }))!
      .items[0]!.seq,
    Number.MAX_SAFE_INTEGER,
  );
});

test('bounds details at 32 and distinguishes local truncation from server omission', () => {
  const result = parse(
    summary({
      counts: { a: { error: 40 } },
      abnormal: Array.from({ length: 35 }, (_, seq) => row('error', seq)),
      abnormal_omitted: 5,
    }),
  )!;
  assert.equal(result.items.length, 32);
  assert.equal(result.items[31]!.seq, 31);
  assert.match(result.notices.join('\n'), /另有 3 条被本页截断/);
  assert.match(
    result.notices.join('\n'),
    /另有 5 条内部非 ok 调用未包含在返回中/,
  );
});

test('invalid omitted counts are never turned into invented numbers', () => {
  for (const abnormal_omitted of [undefined, -1, 1.5, '9', NaN]) {
    const text = notices(summary({ abnormal_omitted }));
    assert.match(text, /条数未提供或无效/);
    assert.doesNotMatch(text, /另有/);
  }
});

test('malformed error and inconsistent totals produce notices without altering input', () => {
  const value = summary({
    abnormal: [{ ...row(), error: { code: 'NO_GUESS' } }],
    counts: { a: { error: 2 } },
  });
  const before = structuredClone(value);
  const result = parse(value)!;
  assert.match(result.notices.join('\n'), /错误信息格式异常/);
  assert.match(result.notices.join('\n'), /条数不一致/);
  assert.doesNotMatch(result.items[0]!.detail, /NO_GUESS/);
  assert.deepEqual(value, before);
});
