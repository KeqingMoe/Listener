import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewTool } from '../../../src/dashboard/contracts/review.ts';
import { managementToolView } from '../../../src/dashboard/web/src/components/review/management-tool-view.ts';

type Input = Parameters<typeof managementToolView>[0];

const submitted = {
  status: 'ok',
  submitted: true,
  effect_confirmed: false,
  delivery_confirmed: false,
};
const input = (
  name: string,
  args: unknown = {},
  result: unknown = { status: 'executed' },
  overrides: Partial<Input> = {},
): Input => ({
  name,
  arguments: args,
  result,
  state: 'finished',
  outcome: 'handled',
  ...overrides,
});
const view = (
  name: string,
  args: unknown = {},
  result: unknown = { status: 'executed' },
  overrides: Partial<Input> = {},
) => {
  const value = managementToolView(input(name, args, result, overrides));
  assert.ok(value);
  return value;
};
const fixtures: [
  string,
  Record<string, unknown>,
  Record<string, unknown>,
  boolean,
][] = [
  [
    'mute_member',
    { user_id: '123', seconds: 60 },
    { status: 'executed' },
    true,
  ],
  ['unmute_member', { user_id: '123' }, { status: 'executed' }, true],
  ['recall_message', { message_id: '-1' }, { status: 'executed' }, true],
  [
    'set_member_card',
    { user_id: '123', card: '群名片' },
    { status: 'executed' },
    true,
  ],
  [
    'poke_member',
    { user_id: '123' },
    { ...submitted, action: 'poke_member', group_id: '42', user_id: '123' },
    false,
  ],
  [
    'group_sign',
    {},
    { ...submitted, action: 'group_sign', group_id: '42' },
    false,
  ],
  [
    'set_group_name',
    { name: '群名' },
    { status: 'executed', action: 'set_group_name', group_id: '42' },
    true,
  ],
  ['set_group_title', { user_id: '123', title: '' }, submitted, false],
  ['set_group_whole_mute', { enable: false }, { status: 'executed' }, true],
  [
    'kick_member',
    { user_id: '123', reject_add_request: false },
    submitted,
    false,
  ],
  ['set_group_admin', { user_id: '123', enable: false }, submitted, false],
  ['set_group_essence', { message_id: '0' }, submitted, false],
  ['remove_group_essence', { message_id: '-1' }, submitted, false],
  ['publish_group_notice', { text: '公告' }, { status: 'executed' }, true],
  ['delete_group_notice', { notice_id: 'n-1' }, submitted, false],
  ['leave_group', {}, submitted, false],
  [
    'create_group_folder',
    { name: '资料' },
    { ...submitted, refresh_list: true },
    false,
  ],
  [
    'delete_group_file',
    { file_handle: 'gf_opaque' },
    { ...submitted, api_reported_success: true, refresh_list: true },
    false,
  ],
  [
    'delete_group_folder',
    { folder_handle: 'gf_folder' },
    { status: 'ok', deleted: true, effect_confirmed: true },
    true,
  ],
  [
    'respond_group_request',
    { request_handle: 'grq_opaque', approve: true, reason: '' },
    submitted,
    false,
  ],
];
for (const [name, args, result, confirmed] of fixtures) {
  test(`${name}: actual protocol is readable without promoting Submitted`, () => {
    const actual = view(name, args, result);
    assert.equal(actual.stage.tone === 'success', confirmed);
    assert.equal(actual.action.length > 0, true);
    assert.equal(
      actual.notices.some((s) => /异常|缺失|不一致|缺少/.test(s)),
      false,
    );
    if (!confirmed) {
      assert.equal(actual.stage.label, '已提交，效果与送达未核实');
    }
    const failed = view(name, args, {
      status: 'error',
      error: 'permission_denied',
    });
    assert.equal(failed.stage.label, '工具返回错误');
    assert.equal(
      failed.notices.some((s) => /缺少|异常/.test(s)),
      false,
    );
    assert.deepEqual(failed.reasons, [
      { code: 'permission_denied', label: '权限不足' },
    ]);
  });
}

test('exact whitelist excludes uploads, read tools, JS wrappers, unknown and prototype names', () => {
  for (const name of [
    'upload_group_file',
    'list_group_files',
    'read_group_notices',
    'list_group_requests',
    'execute_javascript',
    'unknown',
    '',
    'toString',
    '__proto__',
    'constructor',
    'mute_member ',
  ]) {
    assert.equal(
      managementToolView(
        input(
          name,
          {},
          { status: 'executed', value: { action: 'mute_member' } },
        ),
      ),
      null,
    );
  }
  assert.equal(fixtures.length, 20);
});

test('zero, false, empty title and reason keep their distinct request meaning', () => {
  assert.deepEqual(view('recall_message', { message_id: 0 }).targets, [
    { label: '目标消息ID', id: '0', name: '' },
  ]);
  assert.match(
    view('set_group_title', { user_id: 123, title: '' }, submitted).text[0]!
      .value,
    /移除头衔/,
  );
  for (const [name, args] of fixtures.filter(([, args]) =>
    Object.values(args).includes(false),
  )) {
    assert.ok(
      view(name, args).requested.some((x) => x.value.endsWith('（false）')),
    );
  }
  const approved = view(
    'respond_group_request',
    { request_handle: 'r', approve: true, reason: '' },
    submitted,
  );
  assert.deepEqual(approved.text, [
    { label: '请求处理理由', value: '空字符串' },
  ]);
  assert.equal(approved.reasons.length, 0);
  const rejected = view(
    'respond_group_request',
    { request_handle: 'r', approve: false, reason: '不符合要求' },
    submitted,
  );
  assert.equal(rejected.requested[0]!.value, '拒绝');
  assert.equal(rejected.reasons.length, 0);
  assert.ok(
    view(
      'respond_group_request',
      { request_handle: 'r', approve: true, reason: '非空' },
      submitted,
    ).notices.some((x) => x.includes('应为空字符串')),
  );
});

test('invalid boolean is not false and missing fields never invent defaults', () => {
  for (const value of ['false', 0, null, [], {}]) {
    const actual = view('set_group_whole_mute', { enable: value });
    assert.equal(actual.requested.length, 0);
    assert.match(actual.notices.join(' '), /不是布尔值/);
  }
  for (const args of [null, {}, 'enable=false', []]) {
    const actual = view('set_group_whole_mute', args);
    assert.equal(actual.requested.length, 0);
    assert.match(actual.notices.join(' '), /缺失请求参数 enable/);
  }
  for (const value of [
    0,
    -1,
    1.2,
    Number.MAX_SAFE_INTEGER + 1,
    '60',
    null,
    Infinity,
    NaN,
  ]) {
    assert.equal(
      view('mute_member', { user_id: '123', seconds: value }).requested.length,
      0,
    );
  }
  assert.equal(
    view('mute_member', { user_id: '123', seconds: Number.MAX_SAFE_INTEGER })
      .requested[0]!.value,
    `${Number.MAX_SAFE_INTEGER} 秒`,
  );
});

test('targets come exclusively from requests; names are scoped historical user names only', () => {
  const names = new Map([
    ['123', '小明'],
    ['-1', '不得当作消息名'],
    ['gf_opaque', '不得当作文件名'],
  ]);
  const actual = managementToolView(
    input(
      'mute_member',
      { user_id: 123, seconds: 1 },
      { status: 'executed', user_id: '999', card: '伪名' },
    ),
    names,
  )!;
  assert.deepEqual(actual.targets, [
    { label: '目标成员QQ', id: '123', name: '小明（历史名称）' },
  ]);
  assert.notEqual(actual.stage.tone, 'success');
  assert.equal(
    managementToolView(input('recall_message', { message_id: '-1' }), names)!
      .targets[0]!.name,
    '',
  );
  assert.equal(
    managementToolView(
      input('delete_group_file', { file_handle: 'gf_opaque' }),
      names,
    )!.targets[0]!.name,
    '',
  );
  assert.equal(
    view('mute_member', {}, { status: 'executed', user_id: '123' }).targets
      .length,
    0,
  );
  assert.equal(
    view(
      'set_group_name',
      { name: '请求名称' },
      { status: 'executed', name: '返回名称' },
    ).text[0]!.value,
    '请求名称',
  );
});

test('IDs reject invalid, unsafe numeric and overlong values without truncation', () => {
  for (const id of [
    0,
    -1,
    1.2,
    Number.MAX_SAFE_INTEGER + 1,
    '',
    '0',
    '-1',
    '01',
    '1e3',
    ' 1',
    '1\u200b',
    '1'.repeat(257),
  ]) {
    assert.equal(
      view('mute_member', { user_id: id, seconds: 1 }).targets.length,
      0,
    );
  }
  assert.equal(
    view('mute_member', { user_id: '9'.repeat(256), seconds: 1 }).targets[0]!.id
      .length,
    256,
  );
  for (const id of ['-2', '0', 0, -2]) {
    assert.equal(
      view('recall_message', { message_id: id }).targets[0]!.id,
      String(id),
    );
  }
  for (const id of ['-0', '00', '2.5', 'a', '0'.repeat(257)]) {
    assert.equal(view('recall_message', { message_id: id }).targets.length, 0);
  }
  for (const id of ['x'.repeat(257), 'bad\n', 'bad\u202e', '\ud800']) {
    assert.equal(
      view('delete_group_file', { file_handle: id }).targets.length,
      0,
    );
  }
  const opaque = 'https://example.invalid/<script>'; // Opaque plain text, never a link or read operation.
  assert.equal(
    view('delete_group_file', { file_handle: opaque }).targets[0]!.id,
    opaque,
  );
});

test('plain text is codepoint bounded, never markup parsed, and controls/formats are rejected', () => {
  for (const [name, key, max] of [
    ['publish_group_notice', 'text', 4000],
    ['set_group_name', 'name', 128],
    ['set_group_title', 'title', 128],
    ['set_member_card', 'card', 128],
    ['respond_group_request', 'reason', 512],
  ] as const) {
    const exact = '😀'.repeat(max),
      args = {
        user_id: '123',
        request_handle: 'r',
        approve: false,
        [key]: exact,
      };
    assert.equal(view(name, args).text[0]!.value, exact);
    const clipped = view(name, { ...args, [key]: exact + '尾' }).text[0]!.value;
    assert.equal(clipped, exact + '…（已裁剪）');
    assert.equal(clipped.includes('\ufffd'), false);
    for (const bad of ['A\u0000', 'A\u202e', 'A\u2028', 'A\ud800']) {
      assert.equal(view(name, { ...args, [key]: bad }).text.length, 0);
    }
  }
  const malicious =
    '<img src=x onerror=alert(1)>[CQ:at,qq=123] https://evil.invalid';
  assert.equal(
    view('publish_group_notice', { text: malicious }).text[0]!.value,
    malicious,
  );
  const multibyte = '中'.repeat(512);
  assert.equal(
    view('respond_group_request', {
      request_handle: 'r',
      approve: false,
      reason: multibyte,
    }).text[0]!.value,
    multibyte,
  );
});

test('no enumeration or access of unrelated large fields, getters, nested value/code', () => {
  const trap = () => {
    throw new Error('must not inspect');
  };
  const result = Object.defineProperties(
    { status: 'executed' },
    {
      content: { get: trap },
      pixels: { get: trap },
      value: { get: trap },
      code: { get: trap },
      extra: { get: trap },
    },
  );
  const args = Object.defineProperties(
    { name: '请求群名' },
    { content: { get: trap }, pixels: { get: trap } },
  );
  assert.equal(view('set_group_name', args, result).stage.tone, 'success');
  const noEnumeration = new Proxy(
    { status: 'executed' },
    { ownKeys: trap, get: trap },
  );
  assert.equal(
    view('set_group_name', args, noEnumeration).stage.tone,
    'success',
  );
  assert.equal(
    view('set_group_name', args, { value: { status: 'executed' }, code: 0 })
      .stage.label,
    '返回证据不足',
  );
  const knownGetter = Object.defineProperty({ status: 'executed' }, 'cached', {
    get: trap,
  });
  assert.equal(
    view('set_group_name', args, knownGetter).stage.label,
    '返回证据异常',
  );
});

test('only operation-specific complete positive receipts confirm', () => {
  for (const [name, args, , confirmed] of fixtures) {
    assert.notEqual(view(name, args, { status: 'ok' }).stage.tone, 'success');
    if (!confirmed) {
      assert.notEqual(
        view(name, args, { status: 'executed' }).stage.tone,
        'success',
      );
    }
  }
  for (const result of [
    { status: 'ok', deleted: true },
    { status: 'ok', effect_confirmed: true },
    { status: 'ok', deleted: false, effect_confirmed: true },
    { status: 'ok', deleted: true, effect_confirmed: false },
  ]) {
    assert.notEqual(
      view('delete_group_folder', { folder_handle: 'f' }, result).stage.tone,
      'success',
    );
  }
  for (const result of [
    null,
    undefined,
    [],
    'executed',
    0,
    { status: 'success' },
  ]) {
    assert.notEqual(
      view('set_group_name', { name: 'n' }, result, { result }).stage.tone,
      'success',
    );
  }
  assert.equal(
    view('set_group_name', { name: 'n' }, null).stage.label,
    '结果未记录',
  );
});

test('all ledger overrides take priority over saved ACKs, with records preserved', () => {
  for (const state of [
    'unknown',
    'started',
    'pending',
    'skipped',
    'failed',
    'rejected',
    'cancelled',
    'future',
  ]) {
    const actual = view(
      'set_group_name',
      { name: 'n' },
      { status: 'executed' },
      { state },
    );
    assert.notEqual(actual.stage.tone, 'success');
    assert.ok(actual.returned.some((r) => r.value === 'executed'));
  }
  for (const outcome of [
    'unknown',
    'failed',
    'skipped',
    'rejected',
    'cancelled',
    'deferred',
  ] satisfies ReviewTool['outcome'][]) {
    assert.notEqual(
      view('set_group_name', { name: 'n' }, { status: 'executed' }, { outcome })
        .stage.tone,
      'success',
    );
  }
});

test('cache, duplicate and no-dispatch retain previous status but never claim new execution', () => {
  for (const extra of [
    { cached: true },
    { duplicate: true },
    { dispatched: false },
    { cached: true, dispatched: false },
  ]) {
    for (const [name, args, result] of fixtures) {
      const actual = view(name, args, { ...result, ...extra });
      assert.equal(actual.stage.label, '本次无新派发证据');
      assert.ok(actual.returned.some((r) => r.value === result.status));
    }
  }
  assert.equal(
    view('set_group_name', { name: 'n' }, { status: 'duplicate' }).stage.label,
    '本次无新派发证据',
  );
  const cancelled = view(
    'set_group_name',
    { name: 'n' },
    { status: 'executed', cancelled_after_dispatch: true },
  );
  assert.equal(cancelled.stage.label, '记录有执行回执，另有派发后取消标记');
  assert.match(cancelled.stage.detail, /已有明确业务ACK/);
  assert.ok(cancelled.returned.some((r) => r.value === 'executed'));
  assert.match(
    view(
      'set_group_name',
      { name: 'n' },
      { status: 'executed', cancelled_after_dispatch: true },
      { state: 'unknown' },
    ).stage.label,
    /账本结果未知/,
  );
});

test('Submitted missing, contradictory and invalid flags stay conservative', () => {
  for (const override of [
    { submitted: false },
    { submitted: 'true' },
    { effect_confirmed: true },
    { effect_confirmed: null },
    { delivery_confirmed: true },
    { delivery_confirmed: 'false' },
    { effect_unknown: true },
    { provider_reported_partial: true },
    { previous_submitted: true },
    { deleted: true },
    { duplicate: 'false' },
    { dispatched: 0 },
  ]) {
    const actual = view(
      'kick_member',
      { user_id: '123', reject_add_request: false },
      { ...submitted, ...override },
    );
    assert.notEqual(actual.stage.label, '已提交，效果与送达未核实');
    assert.notEqual(actual.stage.tone, 'success');
    assert.ok(actual.notices.length > 0);
  }
  for (const key of ['submitted', 'effect_confirmed', 'delivery_confirmed']) {
    const incomplete: Record<string, unknown> = { ...submitted };
    delete incomplete[key];
    assert.notEqual(
      view('poke_member', { user_id: '123' }, incomplete).stage.label,
      '已提交，效果与送达未核实',
    );
  }
  assert.notEqual(
    view(
      'set_group_name',
      { name: 'n' },
      { status: 'executed', submitted: true },
    ).stage.tone,
    'success',
  );
  assert.notEqual(
    view(
      'set_group_name',
      { name: 'n' },
      { status: 'executed', effect_confirmed: false },
    ).stage.tone,
    'success',
  );
});

test('confirmation notification is not an operation target, and stages remain distinct', () => {
  const actual = view(
    'recall_message',
    { message_id: '-9' },
    {
      status: 'confirmation_required',
      notification_message_id: '0',
      expires_in_seconds: 0,
    },
  );
  assert.deepEqual(actual.targets, [
    { label: '目标消息ID', id: '-9', name: '' },
  ]);
  assert.ok(
    actual.returned.some(
      (r) => /确认提示消息ID/.test(r.label) && r.value === '0',
    ),
  );
  assert.equal(actual.stage.label, '等待主人确认');
  const stages = [
    'unknown',
    'confirmation_required',
    'error',
    'pending',
    'staged',
  ].map((status) => view('group_sign', {}, { status }).stage.label);
  assert.equal(new Set(stages).size, 5);
});

test('delete-file API success is not target deletion, and explicit false flags remain visible', () => {
  for (const api_reported_success of [true, false]) {
    const actual = view(
      'delete_group_file',
      { file_handle: 'f' },
      { ...submitted, api_reported_success, refresh_list: true },
    );
    assert.equal(actual.stage.label, '已提交，效果与送达未核实');
    assert.ok(
      actual.returned.some(
        (r) =>
          r.label === 'API成功报告' &&
          r.value.includes(String(api_reported_success)),
      ),
    );
    assert.match(
      actual.returned.find((r) => r.label === '列表建议')!.value,
      /本页面不会执行/,
    );
  }
  const actual = view(
    'group_sign',
    {},
    {
      status: 'unknown',
      effect_unknown: true,
      retry_allowed: false,
      previous_submitted: false,
      provider_reported_partial: false,
      cached: false,
      duplicate: false,
      dispatched: false,
    },
  );
  for (const label of [
    '重试许可',
    '此前提交',
    '上游部分结果',
    '缓存标记',
    '重复标记',
    '本次派发标记',
  ]) {
    assert.ok(
      actual.returned.some(
        (r) => r.label === label && r.value.includes('false'),
      ),
    );
  }
});

test('bounded reason codes preserve original text; notes never upgrade evidence', () => {
  const actual = view(
    'respond_group_request',
    { request_handle: 'r', approve: false, reason: '请求理由' },
    {
      status: 'error',
      error: 'invalid_arguments',
      reason_code: 'custom_code',
      reason: '😀'.repeat(513),
      note: '已成功入群',
    },
  );
  assert.equal(actual.reasons[0]!.code, 'invalid_arguments');
  assert.equal(actual.reasons[1]!.code, 'custom_code');
  assert.equal(actual.reasons[2]!.code, '😀'.repeat(512) + '…（已裁剪）');
  assert.equal(
    actual.reasons.some((r) => r.code === '请求理由'),
    false,
  );
  assert.equal(actual.stage.label, '工具返回错误');
  assert.deepEqual(
    actual.returned.find((r) => r.label === '返回说明'),
    { label: '返回说明', value: '已成功入群' },
  );
  const bad = view(
    'group_sign',
    {},
    {
      status: 'error',
      error: {},
      reason_code: '\u202e',
      note: { value: 'ok' },
      retry_allowed: 'false',
    },
  );
  assert.equal(bad.reasons.length, 0);
  assert.equal(bad.notices.length, 4);
});

test('explicit action, user and group conflicts cannot confirm the current operation', () => {
  for (const extra of [
    { action: 'kick_member' },
    { action: {} },
    { user_id: '999' },
    { user_id: 0 },
    { group_id: '99' },
    { group_id: {} },
  ]) {
    const actual = managementToolView(
      input(
        'mute_member',
        { user_id: '123', seconds: 5 },
        { status: 'executed', ...extra },
      ),
      undefined,
      '42',
    )!;
    assert.equal(actual.stage.label, '返回证据异常');
    assert.ok(actual.notices.some((s) => /不一致或类型无效/.test(s)));
    assert.equal(actual.targets[0]!.id, '123');
  }
  const legacy = managementToolView(
    input(
      'mute_member',
      { user_id: 123, seconds: 5 },
      { status: 'executed', action: 'mute_member', user_id: 123, group_id: 42 },
    ),
    undefined,
    '42',
  )!;
  assert.equal(legacy.stage.tone, 'success');
});

test('multiline notice, request reason, notes and joined emoji remain plain bounded text', () => {
  const body = '公告第一行\n第二行\t👨‍👩‍👧‍👦';
  assert.equal(
    view('publish_group_notice', { text: body }).text[0]!.value,
    body,
  );
  assert.equal(
    view('respond_group_request', {
      request_handle: 'r',
      approve: false,
      reason: body,
    }).text[0]!.value,
    body,
  );
  assert.equal(
    view('set_group_name', { name: '家庭👨‍👩‍👧‍👦' }).text[0]!.value,
    '家庭👨‍👩‍👧‍👦',
  );
  assert.equal(
    view('set_group_title', { user_id: '123', title: '👨‍👩‍👧‍👦' }, submitted).text[0]!
      .value,
    '👨‍👩‍👧‍👦',
  );
  assert.equal(
    view('group_sign', {}, { ...submitted, note: body }).returned.find(
      (x) => x.label === '返回说明',
    )!.value,
    body,
  );
  assert.equal(
    view('delete_group_file', { file_handle: '  ' }).targets.length,
    0,
  );
  assert.equal(
    view('delete_group_file', { file_handle: 'gf_\u200d' }).targets.length,
    0,
  );
});

test('provider 1200 stays unknown; 1400 no-dispatch rejection and cancelled ACK remain distinct', () => {
  const unknown = view(
    'mute_member',
    { user_id: '123', seconds: 1 },
    {
      status: 'unknown',
      error: 'delivery_unknown',
      provider_code: 1200,
      provider_reported_failure: true,
      effect_unknown: true,
      retry_allowed: false,
    },
  );
  assert.equal(unknown.stage.label, '结果未知，外部效果未确认');
  assert.ok(unknown.returned.some((x) => x.value === '1200'));
  assert.ok(unknown.returned.some((x) => x.value.includes('不证明未生效')));
  const rejected = view(
    'mute_member',
    { user_id: '123', seconds: 1 },
    {
      status: 'error',
      error: 'provider_rejected',
      provider_code: 1400,
      dispatched: false,
    },
  );
  assert.equal(rejected.stage.label, '工具返回错误，记录未新派发');
  assert.equal(rejected.stage.tone, 'error');
  const folder = view(
    'delete_group_folder',
    { folder_handle: 'f' },
    {
      status: 'ok',
      deleted: true,
      effect_confirmed: true,
      cancelled_after_dispatch: true,
    },
  );
  assert.equal(folder.stage.label, '记录有执行回执，另有派发后取消标记');
  assert.equal(folder.stage.tone, 'warning');
  const conflict = view(
    'set_group_name',
    { name: 'n' },
    { status: 'executed', cached: true, dispatched: true },
  );
  assert.equal(conflict.stage.label, '返回证据异常，不确认新执行');
});

test('explicit submitted=false is compatible with executed and confirmed folder ACKs', () => {
  for (const [name, args, result] of [
    ['set_group_name', { name: 'n' }, { status: 'executed' }],
    [
      'delete_group_folder',
      { folder_handle: 'f' },
      { status: 'ok', deleted: true, effect_confirmed: true },
    ],
  ] as const) {
    const actual = view(name, args, { ...result, submitted: false });
    assert.equal(actual.stage.tone, 'success');
    assert.ok(
      actual.returned.some(
        (x) => x.label === '提交回执' && x.value.includes('false'),
      ),
    );
    assert.equal(
      view(name, args, {
        ...result,
        submitted: false,
        cancelled_after_dispatch: true,
      }).stage.label,
      '记录有执行回执，另有派发后取消标记',
    );
    for (const submitted of [true, 'false', 0, null]) {
      assert.notEqual(
        view(name, args, { ...result, submitted }).stage.tone,
        'success',
      );
    }
  }
});

test('cancellation without ACK does not invent one and no-dispatch does not imply cache', () => {
  for (const status of ['unknown', 'error']) {
    const actual = view(
      'set_group_name',
      { name: 'n' },
      { status, cancelled_after_dispatch: true },
    );
    assert.equal(actual.stage.label, '派发后取消，结果未完整确认');
    assert.match(actual.stage.detail, /若另有执行回执/);
    assert.doesNotMatch(actual.stage.detail, /已有ACK仍是记录|已有明确业务ACK/);
    assert.ok(
      actual.notices.some((x) => x.includes('该标记本身不证明收到ACK')),
    );
  }
  const failure = view(
    'set_group_name',
    { name: 'n' },
    { status: 'error', error: 'api_busy', dispatched: false },
  );
  assert.equal(failure.stage.label, '工具返回错误，记录未新派发');
  assert.ok(failure.notices.some((x) => x.includes('不表示使用了缓存')));
  assert.equal(
    failure.notices.some((x) => x.includes('此前回执')),
    false,
  );
  const noDispatch = view(
    'set_group_name',
    { name: 'n' },
    { status: 'executed', dispatched: false },
  );
  assert.match(noDispatch.stage.detail, /不推断存在缓存或此前执行/);
});

test('ledger reasonCode is a bounded fallback, not duplicate result evidence', () => {
  const metadata = { reasonCode: 'permission_denied' };
  const fallback = view('group_sign', {}, { status: 'error' }, metadata);
  assert.deepEqual(fallback.reasons, [
    { code: 'permission_denied', label: '账本原因：权限不足' },
  ]);
  assert.equal(fallback.stage.label, '工具返回错误');
  for (const reasonCode of ['permission_denied', 'metadata_only']) {
    const existing = view(
      'group_sign',
      {},
      { status: 'error', error: 'permission_denied' },
      { reasonCode },
    );
    assert.deepEqual(existing.reasons, [
      { code: 'permission_denied', label: '权限不足' },
    ]);
  }
  const clipped = view('group_sign', {}, null, {
    reasonCode: '😀'.repeat(1_000_000),
  });
  assert.deepEqual(clipped.reasons, [
    { code: '😀'.repeat(512) + '…（已裁剪）', label: '账本原因（原文）' },
  ]);
  assert.equal(clipped.stage.label, '结果未记录');
  for (const reasonCode of [null, '', '\u202e']) {
    assert.equal(
      view('group_sign', {}, null, { reasonCode }).reasons.length,
      0,
    );
  }
  for (const result of [{ status: 'executed' }, { status: 'ok' }, null]) {
    const baseline = view('set_group_name', { name: 'n' }, result);
    const withMetadata = view(
      'set_group_name',
      { name: 'n' },
      result,
      metadata,
    );
    assert.deepEqual(withMetadata.stage, baseline.stage);
    assert.deepEqual(withMetadata.returned, baseline.returned);
  }
  const unreadableResult = view(
    'group_sign',
    {},
    { status: 'error', error: {} },
    metadata,
  );
  assert.match(unreadableResult.reasons[0]!.label, /账本原因/);
});

test('formatter is read-only, creates independent output, and does not mutate inputs or names', () => {
  const args = Object.freeze({ user_id: '123', seconds: 60 });
  const result = Object.freeze({ status: 'executed' });
  const tool = Object.freeze(input('mute_member', args, result));
  const names = new Map([['123', '历史用户']]);
  const before = JSON.stringify(tool);
  const first = managementToolView(tool, names)!;
  first.targets[0]!.id = 'modified';
  first.returned.push({ label: 'test', value: 'test' });
  assert.equal(managementToolView(tool, names)!.targets[0]!.id, '123');
  assert.equal(JSON.stringify(tool), before);
  assert.deepEqual([...names], [['123', '历史用户']]);
});
