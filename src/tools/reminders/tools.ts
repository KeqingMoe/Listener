import { canonicalMessageId } from '../../onebot/identity.ts';
import type { Api } from '../../contracts/onebot.ts';
import type { Memory } from '../../contracts/messages.ts';
import {
  type JsonObject,
  isObject,
  hasExactFields,
} from '../../contracts/json.ts';
import type { ToolDefinition, TurnContext } from '../../contracts/tools.ts';
import {
  type ReminderStore,
  REMINDER_GRACE_MS,
  type Reminder,
  type ReminderState,
} from '../../reminders/store.ts';
import { fail, failureCode } from '../failure.ts';

export const REMINDER_TOOL_NAMES = [
  'create_reminder',
  'list_reminders',
  'update_reminder',
  'cancel_reminder',
] as const;
const STATES: ReminderState[] = [
  'pending',
  'sending',
  'sent',
  'unknown',
  'failed',
  'cancelled',
  'expired',
];
const OUTPUT_BYTES = 24_000,
  MAX_DATE = 8_640_000_000_000_000;
const shared =
  '提醒是当前群共享资源，由本群授权模型按群意图管理，不限创建者本人。到期发送固定纯文字，不执行命令、不产生@、不唤醒模型。停机后仅在到期24小时内补发，之后过期。存储成功不代表已发送；结果未知时先查询，不保证恰好一次。';
const idSchema = { type: 'string', pattern: '^rem_[a-f0-9-]{36}$' };
const revisionSchema = { type: 'integer', minimum: 1 };
const timeFields = {
  due_at: {
    type: 'string',
    description: '未来时间，严格RFC3339含秒及Z或±HH:MM偏移；可含1至3位毫秒。',
  },
  time_zone: {
    type: 'string',
    description: 'IANA时区，如Asia/Shanghai；必须与due_at该瞬间偏移一致。',
  },
};
const definitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description:
        '创建一次性群提醒。source_message_id必须是本群已观察的非Bot消息，由核验后的消息作者归属，不能自报创建者。' +
        shared,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['source_message_id', 'text', 'due_at', 'time_zone'],
        properties: {
          source_message_id: { type: 'string', pattern: '^-?[1-9]\\d{0,15}$' },
          text: {
            type: 'string',
            description:
              '非空固定提醒文字，最多24000 UTF-8字节；CQ/命令标记均按文字发送。',
          },
          ...timeFields,
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description:
        '查询当前账号当前群共享提醒，实时offset分页，不是固定快照；正文可能截断但身份、版本和状态保留。' +
        shared,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['limit'],
        properties: {
          limit: { type: 'integer', minimum: 1 },
          offset: { type: 'integer', minimum: 0 },
          state: { type: 'string', enum: STATES },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_reminder',
      description:
        '修改已知id和revision对应的pending群提醒，至少提供一个修改项；due_at/time_zone必须一起提供。版本冲突需重新查询。' +
        shared,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'revision'],
        properties: {
          id: idSchema,
          revision: revisionSchema,
          text: {
            type: 'string',
            description: '非空固定文字，最多24000 UTF-8字节。',
          },
          ...timeFields,
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description:
        '取消已知id和revision对应的pending群提醒；不会撤回已发送消息。' +
        shared,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'revision'],
        properties: { id: idSchema, revision: revisionSchema },
      },
    },
  },
];

export function buildReminderTools(
  enabledNames: readonly string[],
): ToolDefinition[] {
  return definitions
    .filter((tool) => enabledNames.includes(tool.function.name))
    .map((tool) => structuredClone(tool));
}

function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  if (!hasExactFields(value, required, optional)) {
    fail('invalid_arguments');
  }
}

function identity(v: unknown, message = false): string | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v)) {
    v = String(v);
  }
  return typeof v === 'string' &&
    (message ? /^-?[1-9]\d{0,15}$/ : /^[1-9]\d{0,31}$/).test(v) &&
    (!message || Number.isSafeInteger(Number(v)))
    ? v
    : undefined;
}

function text(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    Buffer.byteLength(v) > OUTPUT_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
  ) {
    fail('invalid_text');
  }
  return v;
}

function integer(v: unknown, min: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min) {
    fail('invalid_arguments');
  }
  return v as number;
}

function due(value: unknown, zone: unknown, now: number): number {
  if (
    typeof value !== 'string' ||
    typeof zone !== 'string' ||
    !zone ||
    zone.length > 128 ||
    !/[A-Za-z]/.test(zone) ||
    /^[+-]/.test(zone)
  ) {
    fail('invalid_time');
  }
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!m) {
    fail('invalid_time');
  }
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const offset =
    m[8] === 'Z'
      ? 0
      : (m[9] === '-' ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11]));
  if (
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > 31 ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    Number(m[10] ?? 0) > 23 ||
    Number(m[11] ?? 0) > 59 ||
    m[8] === '-00:00'
  ) {
    fail('invalid_time');
  }
  const instant = Date.parse(value),
    local = new Date(instant + offset * 60000);
  if (
    !Number.isSafeInteger(instant) ||
    instant <= now ||
    instant > MAX_DATE - REMINDER_GRACE_MS ||
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() + 1 !== month ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    fail('invalid_time');
  }
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(instant))
      .find((p) => p.type === 'timeZoneName')?.value;
  } catch {
    fail('invalid_time_zone');
  }
  const z = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(name ?? '');
  if (!z) {
    fail('invalid_time_zone');
  }
  const zoneSeconds = z[1]
    ? (z[1] === '-' ? -1 : 1) *
      (Number(z[2]) * 3600 + Number(z[3]) * 60 + Number(z[4] ?? 0))
    : 0;
  if (zoneSeconds !== offset * 60) {
    fail('time_zone_offset_mismatch');
  }
  return instant;
}

function bytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

function project(row: Reminder): JsonObject {
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    creator_id: row.creatorId,
    source_message_id: row.sourceMessageId,
    text: row.text,
    due_at: new Date(row.dueAt).toISOString(),
    expires_at: new Date(row.expiresAt).toISOString(),
    time_zone: row.timeZone,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
    ...(row.messageId ? { message_id: row.messageId } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

/** 即使单条正文占满输出预算，也保留全部调度和CAS元数据。 */
function fit(row: JsonObject, budget: number): JsonObject | undefined {
  if (bytes(row) <= budget) {
    return row;
  }
  const source = row.text as string,
    out = {
      ...row,
      text: '',
      text_truncated: true,
      text_bytes: Buffer.byteLength(source),
    };
  let used = bytes(out);
  if (used > budget) {
    return;
  }
  const parts: string[] = [];
  for (const point of source) {
    const cost = bytes(point) - 2;
    if (used + cost > budget) {
      break;
    }
    parts.push(point);
    used += cost;
  }
  out.text = parts.join('');
  return out;
}

export class GroupReminderTools {
  private readonly enabled: ReadonlySet<string>;
  constructor(
    private readonly api: Api,
    private readonly memory: Memory,
    private readonly groupId: string,
    private readonly ownerId: string,
    private readonly store: ReminderStore,
    enabledNames: readonly string[] = REMINDER_TOOL_NAMES,
    private readonly now: () => number = Date.now,
  ) {
    if (!identity(groupId) || !identity(ownerId)) {
      throw new Error('Invalid reminder tool scope');
    }
    this.enabled = new Set(
      enabledNames.filter((name) =>
        (REMINDER_TOOL_NAMES as readonly string[]).includes(name),
      ),
    );
  }

  private check(signal?: AbortSignal): void {
    if (signal?.aborted) {
      fail('cancelled');
    }
  }

  private async call(
    action: string,
    params: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.check(signal);
    let raw: unknown;
    try {
      raw = await this.api.call(action, params);
    } catch {
      this.check(signal);
      fail('api_unavailable');
    }
    this.check(signal);
    return raw;
  }

  async execute(
    name: string,
    args: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    try {
      this.check(signal);
      if (!this.enabled.has(name)) {
        fail('tool_disabled');
      }
      if (!context || context.groupId !== this.groupId) {
        fail('forbidden_group');
      }
      if (!identity(context.selfId) || !identity(context.actorId)) {
        fail('invalid_identity');
      }
      const selfId = context.selfId;
      if (name === 'create_reminder') {
        fields(args, ['source_message_id', 'text', 'due_at', 'time_zone']);
      } else if (name === 'list_reminders') {
        fields(args, ['limit'], ['offset', 'state']);
      } else if (name === 'update_reminder') {
        fields(args, ['id', 'revision'], ['text', 'due_at', 'time_zone']);
      } else {
        fields(args, ['id', 'revision']);
      }
      const clock = this.now();
      let sourceAuthor: string | undefined,
        sourceId: string | undefined,
        body: string | undefined,
        dueAt: number | undefined;
      if (name === 'create_reminder') {
        if (
          typeof args.source_message_id !== 'string' ||
          !canonicalMessageId(args.source_message_id)
        ) {
          fail('invalid_arguments');
        }
        sourceId = args.source_message_id;
        const entry = this.memory.find(sourceId);
        sourceAuthor = entry?.userId;
        if (
          !entry ||
          entry.messageId !== sourceId ||
          entry.bot ||
          !identity(sourceAuthor) ||
          sourceAuthor === selfId
        ) {
          fail('source_not_in_context');
        }
        body = text(args.text);
        dueAt = due(args.due_at, args.time_zone, clock);
      } else if (name === 'update_reminder') {
        if (
          !['text', 'due_at', 'time_zone'].some((k) =>
            Object.hasOwn(args, k),
          ) ||
          Object.hasOwn(args, 'due_at') !== Object.hasOwn(args, 'time_zone')
        ) {
          fail('invalid_arguments');
        }
        if (Object.hasOwn(args, 'text')) {
          body = text(args.text);
        }
        if (Object.hasOwn(args, 'due_at')) {
          dueAt = due(args.due_at, args.time_zone, clock);
        }
      }
      if (name === 'update_reminder' || name === 'cancel_reminder') {
        if (
          typeof args.id !== 'string' ||
          !/^rem_[a-f0-9-]{36}$/.test(args.id)
        ) {
          fail('invalid_arguments');
        }
        integer(args.revision, 1);
      }
      if (name === 'list_reminders') {
        integer(args.limit, 1);
        if (Object.hasOwn(args, 'offset')) {
          integer(args.offset, 0);
        }
        if (
          Object.hasOwn(args, 'state') &&
          !STATES.includes(args.state as ReminderState)
        ) {
          fail('invalid_arguments');
        }
      }
      const login = await this.call('get_login_info', {}, signal);
      if (!isObject(login) || identity(login.user_id) !== selfId) {
        fail('identity_mismatch');
      }
      if (name === 'create_reminder') {
        const remote = await this.call(
          'get_msg',
          { message_id: sourceId! },
          signal,
        );
        if (
          !isObject(remote) ||
          remote.message_type !== 'group' ||
          identity(remote.group_id) !== this.groupId ||
          canonicalMessageId(remote.message_id) !== sourceId ||
          !isObject(remote.sender) ||
          identity(remote.sender.user_id) !== sourceAuthor ||
          (Object.hasOwn(remote, 'user_id') &&
            identity(remote.user_id) !== sourceAuthor) ||
          (Object.hasOwn(remote, 'self_id') &&
            identity(remote.self_id) !== selfId)
        ) {
          fail('verification_failed');
        }
      }
      this.check(signal);
      if (name === 'list_reminders') {
        const limit = args.limit as number,
          offset = (args.offset ?? 0) as number;
        const out: JsonObject = {
          status: 'ok',
          untrusted: true,
          scope: 'current_group_shared',
          pagination: 'live_offset',
          requested: limit,
          returned: 0,
          offset,
          next_offset: null,
          items: [],
        };
        const items: JsonObject[] = [];
        out.items = items;
        while (items.length < limit) {
          const position = offset + items.length;
          if (!Number.isSafeInteger(position)) {
            break;
          }
          const row = this.store.list(selfId, this.groupId, {
            limit: 1,
            offset: position,
            ...(args.state ? { state: args.state as ReminderState } : {}),
          })[0];
          if (!row) {
            break;
          }
          const item = fit(project(row), OUTPUT_BYTES - bytes(out) - 128);
          if (!item) {
            break;
          }
          items.push(item);
          out.returned = items.length;
        }
        const next = offset + items.length;
        if (
          Number.isSafeInteger(next) &&
          this.store.list(selfId, this.groupId, {
            limit: 1,
            offset: next,
            ...(args.state ? { state: args.state as ReminderState } : {}),
          }).length
        ) {
          out.next_offset = next;
        }
        return out;
      }
      let row: Reminder | undefined;
      if (name === 'create_reminder') {
        row = this.store.create(
          {
            selfId,
            groupId: this.groupId,
            creatorId: sourceAuthor!,
            sourceMessageId: sourceId!,
            text: body!,
            dueAt: dueAt!,
            timeZone: args.time_zone as string,
          },
          this.now(),
        );
      } else {
        const scope = {
          selfId,
          groupId: this.groupId,
          id: args.id as string,
          expectedRevision: args.revision as number,
        };
        const current = this.store.get(selfId, this.groupId, scope.id);
        if (!current) {
          fail('reminder_not_found');
        }
        if (
          current.state !== 'pending' ||
          current.revision !== scope.expectedRevision
        ) {
          fail('not_pending_or_conflict');
        }
        if (name === 'update_reminder') {
          if (dueAt !== undefined && dueAt <= this.now()) {
            fail('invalid_time');
          }
          row = this.store.update(
            scope,
            {
              ...(body !== undefined ? { text: body } : {}),
              ...(dueAt !== undefined
                ? { dueAt, timeZone: args.time_zone as string }
                : {}),
            },
            this.now(),
          );
        } else {
          row = this.store.cancel(scope, this.now());
        }
      }
      if (!row) {
        fail('not_pending_or_conflict');
      }
      const out: JsonObject = {
        status: 'ok',
        stored: true,
        delivery_confirmed: false,
        catch_up_hours: 24,
        scope: 'current_group_shared',
        reminder: {},
      };
      out.reminder = fit(project(row), OUTPUT_BYTES - bytes(out) - 32)!;
      return out;
    } catch (error) {
      return {
        status: 'error',
        error: failureCode(error, 'reminder_failed'),
      };
    }
  }
}
