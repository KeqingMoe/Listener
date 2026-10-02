import type { ReviewTool } from '../../../../contracts/review.ts';

export type ManagementToolView = {
  action: string;
  targets: { label: string; id: string; name: string }[];
  requested: { label: string; value: string }[];
  text: { label: string; value: string }[];
  stage: {
    label: string;
    detail: string;
    tone: 'neutral' | 'success' | 'warning' | 'error';
  };
  returned: { label: string; value: string }[];
  reasons: { code: string; label: string }[];
  notices: string[];
};

type Input = Pick<
  ReviewTool,
  'name' | 'arguments' | 'result' | 'state' | 'outcome'
> &
  Partial<Pick<ReviewTool, 'reasonCode'>>;

type Field =
  | 'user_id'
  | 'message_id'
  | 'notice_id'
  | 'file_handle'
  | 'folder_handle'
  | 'request_handle'
  | 'seconds'
  | 'enable'
  | 'reject_add_request'
  | 'approve'
  | 'card'
  | 'title'
  | 'name'
  | 'text'
  | 'reason';

const operations: Record<
  string,
  { label: string; fields: Field[]; ack?: true }
> = {
  mute_member: { label: '禁言成员', fields: ['user_id', 'seconds'], ack: true },
  unmute_member: { label: '解除禁言', fields: ['user_id'], ack: true },
  recall_message: { label: '撤回消息', fields: ['message_id'], ack: true },
  set_member_card: {
    label: '修改群名片',
    fields: ['user_id', 'card'],
    ack: true,
  },
  poke_member: { label: '戳一戳成员', fields: ['user_id'] },
  group_sign: { label: '本群签到', fields: [] },
  set_group_name: { label: '修改群名称', fields: ['name'], ack: true },
  set_group_title: { label: '设置成员头衔', fields: ['user_id', 'title'] },
  set_group_whole_mute: {
    label: '设置全员禁言',
    fields: ['enable'],
    ack: true,
  },
  kick_member: {
    label: '移出群成员',
    fields: ['user_id', 'reject_add_request'],
  },
  set_group_admin: { label: '任免管理员', fields: ['user_id', 'enable'] },
  set_group_essence: { label: '设置精华消息', fields: ['message_id'] },
  remove_group_essence: { label: '移除精华消息', fields: ['message_id'] },
  publish_group_notice: { label: '发布群公告', fields: ['text'], ack: true },
  delete_group_notice: { label: '删除群公告', fields: ['notice_id'] },
  leave_group: { label: 'Bot退出本群', fields: [] },
  create_group_folder: { label: '创建群文件目录', fields: ['name'] },
  delete_group_file: { label: '删除群文件', fields: ['file_handle'] },
  delete_group_folder: { label: '删除群文件目录', fields: ['folder_handle'] },
  respond_group_request: {
    label: '处理入群申请',
    fields: ['request_handle', 'approve', 'reason'],
  },
};
const labels: Record<Field, string> = {
  user_id: '目标成员QQ',
  message_id: '目标消息ID',
  notice_id: '目标公告ID',
  file_handle: '目标文件句柄',
  folder_handle: '目标目录句柄',
  request_handle: '目标申请句柄',
  seconds: '禁言时长',
  enable: '启用',
  reject_add_request: '拒绝再次申请',
  approve: '申请决定',
  card: '请求群名片',
  title: '请求头衔',
  name: '请求名称',
  text: '请求公告正文',
  reason: '请求处理理由',
};

// 只读取白名单自有数据属性；不枚举输入、不运行getter、不递归或解析嵌套JS结果。
const unreadable = Symbol('unreadable');

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor
    ? 'value' in descriptor
      ? descriptor.value
      : unreadable
    : undefined;
}

const unsafe = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function plain(
  value: unknown,
  max: number,
  multiline = false,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let result = '',
    count = 0;
  for (const character of value) {
    if (count++ === max) {
      return `${result}…（已裁剪）`;
    }
    // Display only a bounded prefix. Ordinary line breaks and emoji joiners are
    // text, not markup; identifiers use the stricter validator below.
    if (
      unsafe.test(character) &&
      character !== '\u200d' &&
      character !== '\u200c' &&
      !(multiline && /[\n\r\t]/.test(character))
    ) {
      return undefined;
    }
    result += character;
  }
  return result;
}

function identity(
  value: unknown,
  kind: 'user' | 'message' | 'opaque',
): string | undefined {
  if (typeof value === 'number' && kind !== 'opaque') {
    if (!Number.isSafeInteger(value) || (kind === 'user' && value <= 0)) {
      return undefined;
    }
    value = String(value);
  }
  if (
    typeof value !== 'string' ||
    !value.trim().length ||
    value.length > 256 ||
    unsafe.test(value)
  ) {
    return undefined;
  }
  if (kind === 'user' && !/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }
  if (kind === 'message' && !/^(0|-?[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  return value;
}

const reasonLabels: Record<string, string> = {
  permission_denied: '权限不足',
  insufficient_permission: '权限不足',
  verification_failed: '目标或身份核验失败',
  verification_unavailable: '无法核验目标或身份',
  invalid_arguments: '参数不合法',
  tool_disabled: '工具未启用',
  message_not_in_context: '消息不在可用上下文中',
  forbidden_reference: '目标引用不允许',
  invalid_handle: '资源句柄无效',
  invalid_request_handle: '申请句柄无效',
  confirmation_expired: '返回报告确认已过期',
  confirmation_denied: '确认被拒绝',
  previous_result_unknown: '此前结果未知',
  target_result_unknown: '目标此前结果未知',
  previous_submission_pending: '此前提交尚未核实',
  request_already_submitted: '申请此前已提交处理',
  target_already_submitted: '目标此前已提交处理',
  target_busy: '目标正被处理',
  target_deleted: '返回记录目标此前已删除',
  request_not_pending_or_changed: '申请不再待处理或已变化',
  request_identity_changed: '申请身份已变化',
  operation_rejected: '操作被拒绝',
  operation_result_unknown: '操作结果未知',
  action_result_unknown: '操作结果未知',
  delivery_unknown: '送达结果未知',
  cancelled: '调用取消，不证明副作用撤销',
};
const flagLabels: Record<string, [string, string, string]> = {
  submitted: ['提交回执', '已提交', '未报告已提交'],
  effect_confirmed: ['效果核实', '返回声明已核实', '未核实'],
  delivery_confirmed: ['送达核实', '返回声明已核实', '未核实'],
  deleted: ['目录删除回执', '返回声明已删除', '未报告已删除'],
  api_reported_success: [
    'API成功报告',
    'API报告成功，不等于目标删除已核实',
    'API未报告成功，不等于已确认失败',
  ],
  refresh_list: [
    '列表建议',
    '建议重新读取列表；本页面不会执行',
    '未建议重新读取列表',
  ],
  provider_reported_partial: [
    '上游部分结果',
    '上游报告部分结果',
    '未报告部分结果，不证明完整',
  ],
  provider_reported_failure: [
    '上游失败报告',
    '上游报告失败，不证明未生效',
    '未报告上游失败，不证明成功',
  ],
  retry_allowed: [
    '重试许可',
    '返回允许重试；本页面不会执行',
    '返回明确不允许重试',
  ],
  previous_submitted: ['此前提交', '此前已提交', '未报告此前提交'],
  effect_unknown: ['效果未知标记', '效果未知', '未标记未知，不证明效果已核实'],
  cached: ['缓存标记', '复用缓存结果', '未标记缓存'],
  duplicate: ['重复标记', '重复调用结果', '未标记重复'],
  dispatched: [
    '本次派发标记',
    '返回记录已派发，不等于生效',
    '返回记录未新派发',
  ],
  cancelled_after_dispatch: [
    '派发后取消',
    '派发后标记取消，不证明撤销；已有回执仍保留',
    '未标记派发后取消',
  ],
};

/** 纯只读历史摘要：不查询资源、成员角色或客户端时钟；所有文字只能按纯文本渲染。 */
export function managementToolView(
  tool: Input,
  names?: ReadonlyMap<string, string>,
  groupId?: string,
): ManagementToolView | null {
  if (!Object.hasOwn(operations, tool.name)) {
    return null;
  }
  const operation = operations[tool.name]!;
  const view: ManagementToolView = {
    action: operation.label,
    targets: [],
    requested: [],
    text: [],
    returned: [],
    reasons: [],
    notices: [],
    stage: {
      label: '结果未确认',
      detail: '记录不足以确认本次操作结果。',
      tone: 'warning',
    },
  };
  const args = tool.arguments,
    result = tool.result;
  const notice = (message: string) => {
    view.notices.push(message);
  };
  for (const key of operation.fields) {
    const value = field(args, key),
      label = labels[key];
    if (value === undefined) {
      notice(`缺失请求参数 ${key}，不推断默认值。`);
      continue;
    }
    if (
      [
        'user_id',
        'message_id',
        'notice_id',
        'file_handle',
        'folder_handle',
        'request_handle',
      ].includes(key)
    ) {
      const id = identity(
        value,
        key === 'user_id'
          ? 'user'
          : key === 'message_id'
            ? 'message'
            : 'opaque',
      );
      if (id === undefined) {
        notice(`请求 ${key} 无效或超过256字符；不截短ID。`);
        continue;
      }
      const historical =
        key === 'user_id' ? plain(names?.get(id), 128) : undefined;
      view.targets.push({
        label,
        id,
        name: historical ? `${historical}（历史名称）` : '',
      });
    } else if (key === 'seconds') {
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0
      ) {
        view.requested.push({ label, value: `${value} 秒` });
      } else {
        notice('请求 seconds 必须为安全正整数，不推断禁言时长。');
      }
    } else if (['enable', 'approve', 'reject_add_request'].includes(key)) {
      if (typeof value !== 'boolean') {
        notice(`请求 ${key} 不是布尔值，不当作false。`);
        continue;
      }
      const meaning =
        key === 'approve'
          ? value
            ? '同意'
            : '拒绝'
          : key === 'reject_add_request'
            ? value
              ? '拒绝再次申请'
              : '不拒绝再次申请'
            : tool.name === 'set_group_admin'
              ? value
                ? '设为管理员'
                : '撤销管理员'
              : value
                ? '开启全员禁言'
                : '关闭全员禁言';
      view.requested.push({
        label,
        value: key === 'approve' ? meaning : `${meaning}（${String(value)}）`,
      });
    } else {
      const max = key === 'text' ? 4000 : key === 'reason' ? 512 : 128;
      const text = plain(value, max, key === 'text' || key === 'reason');
      if (
        text === undefined ||
        (text.trim() === '' && key !== 'title' && key !== 'reason')
      ) {
        notice(`请求 ${key} 不是可展示的纯文本（空值、控制或格式字符）。`);
        continue;
      }
      view.text.push({
        label,
        value:
          text === ''
            ? key === 'title'
              ? '空字符串：移除头衔'
              : '空字符串'
            : text,
      });
      if (key === 'reason' && field(args, 'approve') === true && value !== '') {
        notice('同意申请时请求reason应为空字符串；当前记录不符合协议。');
      }
    }
  }
  if (tool.name === 'delete_group_folder') {
    notice('请求删除目录及其内容；不读取目录实际内容。');
  }
  if (tool.name === 'respond_group_request') {
    notice('提交处理不代表申请人已入群；不重复或反向处理同一申请。');
  }

  let abnormal = false;
  const problem = (message: string) => {
    abnormal = true;
    notice(message);
  };
  const flags: Record<string, unknown> = {};
  for (const [key, [label, yes, no]] of Object.entries(flagLabels)) {
    const value = field(result, key);
    flags[key] = value;
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'boolean') {
      problem(`返回 ${key} 类型异常，应为布尔值。`);
      continue;
    }
    view.returned.push({
      label,
      value: `${value ? yes : no}（${String(value)}）`,
    });
  }
  const rawStatus = field(result, 'status'),
    status = plain(rawStatus, 128);
  if (rawStatus !== undefined && (status === undefined || status === '')) {
    problem('返回status不是有效状态文本。');
  }
  if (status) {
    view.returned.push({ label: '返回状态（不等于本次生效）', value: status });
  }
  for (const key of ['error', 'reason_code', 'reason']) {
    const raw = field(result, key);
    if (raw === undefined) {
      continue;
    }
    const code = plain(raw, 512);
    if (!code) {
      problem(`返回 ${key} 不是有效原因文本。`);
      continue;
    }
    view.reasons.push({
      code,
      label: Object.hasOwn(reasonLabels, code)
        ? reasonLabels[code]!
        : '返回原因（原文）',
    });
  }
  const note = field(result, 'note');
  if (note !== undefined) {
    const value = plain(note, 512, true);
    if (value === undefined) {
      problem('返回note不是可展示的纯文本。');
    } else {
      view.returned.push({ label: '返回说明', value });
    }
  }
  const providerCode = field(result, 'provider_code');
  if (providerCode !== undefined) {
    if (
      typeof providerCode !== 'number' ||
      !Number.isSafeInteger(providerCode)
    ) {
      problem('返回provider_code不是安全整数。');
    } else {
      view.returned.push({
        label: '上游返回码（不单独证明未生效）',
        value: String(providerCode),
      });
    }
  }
  const notification = field(result, 'notification_message_id');
  if (notification !== undefined) {
    const id = identity(notification, 'message');
    if (id === undefined) {
      problem('返回notification_message_id无效；不截短ID。');
    } else {
      view.returned.push({
        label: '确认提示消息ID（不是管理目标）',
        value: id,
      });
    }
  }
  for (const key of ['action', 'user_id', 'group_id']) {
    const value = field(result, key);
    if (value === undefined) {
      continue;
    }
    const normalized =
      key === 'action' ? plain(value, 128) : identity(value, 'user');
    const expected =
      key === 'action'
        ? tool.name
        : key === 'group_id'
          ? groupId
          : identity(field(args, 'user_id'), 'user');
    if (!normalized || (expected !== undefined && normalized !== expected)) {
      problem(`返回 ${key} 与本次操作不一致或类型无效。`);
    }
    if (normalized) {
      view.returned.push({
        label: `返回${key}（不是请求目标）`,
        value: normalized,
      });
    }
  }
  const positive = status === 'ok' || status === 'executed';
  if (positive && view.reasons.length) {
    problem('正向返回同时包含原因字段，不能据此确认完整结果。');
  }
  if (
    flags.submitted === true &&
    (flags.effect_confirmed === true ||
      flags.delivery_confirmed === true ||
      flags.deleted === true)
  ) {
    problem('提交标记与效果/送达/删除确认标记矛盾。');
  }
  if (
    positive &&
    (flags.effect_unknown === true ||
      flags.provider_reported_partial === true ||
      flags.provider_reported_failure === true ||
      flags.previous_submitted === true)
  ) {
    problem('正向返回同时存在未知、部分结果或此前提交标记。');
  }
  if (flags.effect_unknown === true && flags.effect_confirmed === true) {
    problem('效果未知与效果已核实标记矛盾。');
  }
  if (
    status === 'executed' &&
    (flags.submitted === true ||
      flags.deleted !== undefined ||
      flags.effect_confirmed === false ||
      flags.delivery_confirmed === false)
  ) {
    problem('executed与显式提交或未确认字段不一致。');
  }
  if (flags.dispatched === false && flags.cancelled_after_dispatch === true) {
    problem('未派发与派发后取消标记矛盾。');
  }
  if (flags.deleted !== undefined && tool.name !== 'delete_group_folder') {
    problem('此操作不支持目录删除确认字段。');
  }
  if (
    positive &&
    ['create_group_folder', 'delete_group_file'].includes(tool.name) &&
    flags.refresh_list !== true
  ) {
    problem('本操作正向回执缺少refresh_list=true建议。');
  }
  if (
    positive &&
    tool.name === 'delete_group_file' &&
    typeof flags.api_reported_success !== 'boolean'
  ) {
    problem(
      '删除文件正向回执缺少布尔api_reported_success；不能据此推断删除成功。',
    );
  }
  if (
    !positive &&
    (flags.effect_confirmed === true ||
      flags.delivery_confirmed === true ||
      flags.deleted === true ||
      flags.submitted === true)
  ) {
    problem('非正向状态同时提供正向确认或提交字段，记录不一致。');
  }

  const stage = (
    label: string,
    detail: string,
    tone: ManagementToolView['stage']['tone'] = 'warning',
  ) => {
    view.stage = { label, detail, tone };
  };
  if (
    (flags.cached === true || flags.duplicate === true) &&
    flags.dispatched === true
  ) {
    problem('复用或重复标记与本次已派发标记冲突，不确认新执行。');
  }
  const confirmedAck =
    !abnormal &&
    tool.state === 'finished' &&
    tool.outcome === 'handled' &&
    ((operation.ack && status === 'executed') ||
      (tool.name === 'delete_group_folder' &&
        status === 'ok' &&
        flags.deleted === true &&
        flags.effect_confirmed === true &&
        flags.submitted !== true &&
        flags.delivery_confirmed !== false));
  const cached =
    flags.cached === true || flags.duplicate === true || status === 'duplicate';
  const reused = cached || flags.dispatched === false;
  if (cached) {
    notice('返回带复用或重复标记；可能描述此前回执，不能确认新的执行。');
  } else if (flags.dispatched === false) {
    notice('返回明确记录本次未新派发；这不表示使用了缓存。');
  }
  if (flags.cancelled_after_dispatch === true) {
    notice(
      '返回带派发后取消标记；若另有业务ACK也不因此消失，但该标记本身不证明收到ACK或撤销成功。',
    );
  }
  if (tool.state === 'unknown') {
    stage(
      '账本结果未知',
      '账本尚未确认最终结果；已有回执保留，不覆盖账本不确定性。',
    );
  } else if (tool.state === 'pending') {
    stage(
      '账本待执行',
      '账本仍为pending；已有返回不能确认本次执行。',
      'neutral',
    );
  } else if (tool.state === 'started') {
    stage('账本执行中', '账本仅记录开始，尚未确认本次完整结果。', 'neutral');
  } else if (
    tool.state === 'skipped' ||
    tool.outcome === 'skipped' ||
    status === 'skipped'
  ) {
    stage('调用已跳过', '不据此判断已有副作用是否撤销。', 'neutral');
  } else if (
    tool.state === 'cancelled' ||
    tool.outcome === 'cancelled' ||
    status === 'cancelled' ||
    field(result, 'error') === 'cancelled'
  ) {
    stage(
      '调用已取消，副作用未确认撤销',
      '取消不证明外部效果已撤销；若另有业务ACK，也不因此抹除。',
    );
  } else if (tool.state === 'failed' || tool.outcome === 'failed') {
    stage(
      '账本记录失败',
      '已有返回保留；失败不证明此前副作用已撤销。',
      'error',
    );
  } else if (tool.state === 'rejected' || tool.outcome === 'rejected') {
    stage('调用被拒绝', '不以遗留正向返回覆盖拒绝记录。', 'error');
  } else if (status === 'error' && flags.dispatched === false) {
    stage(
      '工具返回错误，记录未新派发',
      '返回拒绝或失败且dispatched=false；不抹除其他调用或此前回执。',
      'error',
    );
  } else if (reused && abnormal) {
    stage(
      '返回证据异常，不确认新执行',
      '复用或派发字段存在冲突；保留原有回执，不据此确认新执行。',
    );
  } else if (reused) {
    stage(
      '本次无新派发证据',
      cached
        ? '复用或重复标记；返回状态仅作此前回执参考，不算新执行。'
        : '返回dispatched=false，仅表示记录未新派发，不推断存在缓存或此前执行。',
    );
  } else if (flags.cancelled_after_dispatch === true) {
    stage(
      confirmedAck
        ? '记录有执行回执，另有派发后取消标记'
        : '派发后取消，结果未完整确认',
      confirmedAck
        ? '本操作已有明确业务ACK，取消不证明执行被撤销；另行保留派发后取消标记。'
        : '取消不证明撤销；若另有执行回执也不应抹掉，但此返回不足以确认完整结果。',
    );
  } else if (result == null) {
    stage('结果未记录', '没有工具返回，不能从handled推断成功。');
  } else if (status === 'error') {
    stage(
      '工具返回错误',
      '返回未确认成功；不要求失败结果携带成功专属字段。',
      'error',
    );
  } else if (status === 'unknown' || flags.effect_unknown === true) {
    stage(
      '结果未知，外部效果未确认',
      '可能已生效但未确认；不要盲目重放或反向操作。',
    );
  } else if (status === 'confirmation_required') {
    stage(
      '等待主人确认',
      '已进入确认流程，不代表已执行；不根据客户端时钟判断过期。',
    );
  } else if (status === 'pending') {
    stage('结果待定', '返回pending，不代表操作完成。');
  } else if (status === 'staged') {
    stage('已暂存，待后续处理', '暂存不代表已提交或生效。');
  } else if (abnormal) {
    stage('返回证据异常', '字段类型或事实标记不一致，不确认本次完整结果。');
  } else if (tool.state !== 'finished' || tool.outcome !== 'handled') {
    stage(
      '账本未确认完整结束',
      '只有finished且handled才能采信本次正向完整回执。',
    );
  } else if (operation.ack && status === 'executed') {
    stage(
      '本次业务执行已确认',
      '此操作明确返回executed业务回执；不推断当前成员角色或持续状态。',
      'success',
    );
  } else if (
    tool.name === 'delete_group_folder' &&
    status === 'ok' &&
    flags.deleted === true &&
    flags.effect_confirmed === true &&
    flags.submitted !== true &&
    flags.delivery_confirmed !== false
  ) {
    stage(
      '目录删除回执已确认',
      '本次返回ok、deleted=true与effect_confirmed=true。',
      'success',
    );
  } else if (
    !operation.ack &&
    tool.name !== 'delete_group_folder' &&
    status === 'ok' &&
    flags.submitted === true &&
    flags.effect_confirmed === false &&
    flags.delivery_confirmed === false
  ) {
    stage(
      '已提交，效果与送达未核实',
      '仅说明请求正常提交，不代表生效、目标删除、已入群或已送达。',
    );
  } else {
    stage('返回证据不足', '普通ok或不完整回执不能确认此操作已执行或生效。');
    if (positive) {
      notice('本操作的正向回执缺少必要证据或不符合其协议。');
    }
  }
  // Ledger-only fallback is display metadata, not evidence from the tool result.
  // Append after classification so it cannot alter the result's evidence stage.
  if (view.reasons.length === 0) {
    const code = plain(field(tool, 'reasonCode'), 512);
    if (code) {
      view.reasons.push({
        code,
        label: Object.hasOwn(reasonLabels, code)
          ? `账本原因：${reasonLabels[code]!}`
          : '账本原因（原文）',
      });
    }
  }
  return view;
}
