import { createHash, randomBytes } from 'node:crypto';
import { resolveGroupId } from '../../contracts/identity.ts';
import { type Api } from '../../contracts/onebot.ts';
import { type JsonObject, isDataObject } from '../../contracts/json.ts';
import {
  type ToolDefinition,
  type TurnContext,
} from '../../contracts/tools.ts';
import {
  afterDispatch,
  submittedResult,
  writeFailure,
} from '../../onebot/operation-result.ts';
import { ToolFailure, fail, failureCode } from '../failure.ts';

// 基于NapCat v4.18.28的契约：
// packages/napcat-onebot/action/system/GetSystemMsg.ts：join_requests为type 7，
// request_id = +native.seq，invitor_uin = +user1 UIN，checked = status != pending。
// packages/napcat-onebot/index.ts确认type 7的user1是申请人。
// packages/napcat-onebot/action/group/SetGroupAddRequest.ts按seq === flag查找；
// 它接受flag/approve/reason/count，不带group_id，并丢弃ACK。
// 不要把这层桥接扩展到精度不足的数字或邀请入群请求。
export const GROUP_REQUEST_TOOL_NAMES = Object.freeze([
  'list_group_requests',
  'respond_group_request',
] as const);
const TTL_MS = 15 * 60 * 1000,
  CAPACITY = 4096,
  SOURCE_LIMIT = 1000, // 只读取全账号请求的有限前缀，不代表列表完整。
  OUTPUT_LIMIT = 24 * 1024;
const NAMES = new Set<string>(GROUP_REQUEST_TOOL_NAMES);

interface Handle {
  key: string;
  flag: string;
  applicant: string;
  self: string;
  expires: number;
}

interface Pending {
  key: string;
  flag: string;
  applicant: string;
  raw: JsonObject;
}

function id(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value)
    ? value
    : undefined;
}

function safeNatural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function flag(value: unknown): string | undefined {
  // 经核对的响应中flag是数字；原始响应里的字符串flag不视为另一种合法格式。已丢失的精度不做恢复。
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  return value
    .slice(0, 1024)
    .replace(/[\u0000-\u001f\u007f\p{Cs}]/gu, '')
    .replace(/\[CQ:[^\]]*(?:\]|$)/g, '[unsupported segment]')
    .replace(/(?:https?:\/\/|file:\/\/|data:)[^\s]*/gi, '[redacted]');
}

function schema(properties: JsonObject, required: string[]): JsonObject {
  return { type: 'object', additionalProperties: false, properties, required };
}

/**
 * 每个Listener持有一份，跨wake持久。reset()撤销已发放的句柄，但不解除结果未知的锁。
 * 这些锁在本进程内跨wake和手动reset保留。flag不会写入模型输出、数据库或日志；进程重启后该状态不恢复。
 */
export class GroupRequestTools {
  private readonly groupId: string;
  private readonly enabled: ReadonlySet<string>;
  private readonly handles = new Map<string, Handle>();
  private readonly uncertain = new Set<string>();
  private readonly submitted = new Map<
    string,
    { intent: string; applicant: string; result: JsonObject }
  >();

  private epoch = 0;
  private serial: Promise<void> = Promise.resolve();
  constructor(
    private readonly api: Api,
    groupId: string,
    enabledNames: readonly string[] = [],
  ) {
    this.groupId = resolveGroupId(groupId);
    if (
      !Array.isArray(enabledNames) ||
      enabledNames.some((n) => !NAMES.has(n))
    ) {
      throw new Error('Invalid group request capabilities');
    }
    this.enabled = new Set(enabledNames);
  }

  reset(): void {
    this.epoch++;
    this.handles.clear();
  }

  /** wake边界有意保留句柄和结果未知的锁。 */
  resetWake(): void {}
  definitions(): ToolDefinition[] {
    const list: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'list_group_requests',
          description:
            '读取当前群尚待处理的直接入群申请，须Bot为本群管理员或群主。仅返回本群有损过滤后的观察与15分钟临时request_handle，不接受/输出原始flag；不显示邀请Bot加入其他群的请求。limit为必填正安全整数，offset仅对本次新查询快照本地分页；上游仅读取全账号最多1000条通知形成的前缀，不是本群全部申请；未见不表示不存在，覆盖及缺字段情况未知，不承诺列尽。',
          parameters: schema(
            {
              limit: { type: 'integer', minimum: 1 },
              offset: { type: 'integer', minimum: 0 },
            },
            ['limit'],
          ),
        },
      },
      {
        type: 'function',
        function: {
          name: 'respond_group_request',
          description:
            '处理通过list_group_requests获得的本群申请handle；approve和reason都必填，同意时reason必须为空串，拒绝理由原样发送且最多512 UTF-8字节。重新核验本群申请仍待处理、申请人、Bot身份与管理员权限。依本群配置直接执行或等待主人确认；正常返回表示申请处理请求已提交，不代表已观察到成员加入，禁止重复或反向处理同一申请。异常导致结果未知时同样不自动重试，其他独立申请不受影响。',
          parameters: schema(
            {
              request_handle: { type: 'string', pattern: '^grq_[0-9a-f]{48}$' },
              approve: { type: 'boolean' },
              reason: { type: 'string', maxLength: 512 },
            },
            ['request_handle', 'approve', 'reason'],
          ),
        },
      },
    ];
    return list.filter((t) => this.enabled.has(t.function.name));
  }

  private validate(
    name: string,
    value: unknown,
    context: TurnContext,
    generation: number,
    signal?: AbortSignal,
  ): { args: JsonObject; self: string } {
    this.check(generation, signal);
    if (!NAMES.has(name) || !this.enabled.has(name)) {
      fail('tool_disabled');
    }
    if (!isDataObject(context) || context.groupId !== this.groupId) {
      fail('forbidden_group');
    }
    if (
      typeof context.selfId !== 'string' ||
      id(context.selfId) !== context.selfId
    ) {
      fail('invalid_identity');
    }
    return { args: this.parse(name, value), self: context.selfId };
  }

  /** 为主人确认提供只读的当前请求证明；flag不会离开本类。 */
  async confirmationDetails(
    name: string,
    value: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const generation = this.epoch;
    try {
      const { args, self } = this.validate(
        name,
        value,
        context,
        generation,
        signal,
      );
      if (name !== 'respond_group_request') {
        fail('invalid_arguments');
      }
      const { current } = await this.verifiedRequest(
        args,
        self,
        generation,
        signal,
      );
      return JSON.stringify({
        群号: this.groupId,
        操作: args.approve ? '同意入群申请' : '拒绝入群申请',
        申请人QQ: current.applicant,
        拒绝理由: args.reason,
      });
    } catch (error) {
      fail(this.error(error, signal).error as string);
    }
  }

  async execute(
    name: string,
    value: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const generation = this.epoch;
    let args: JsonObject, self: string;
    try {
      ({ args, self } = this.validate(
        name,
        value,
        context,
        generation,
        signal,
      ));
    } catch (error) {
      return this.error(error, signal);
    }
    const before = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await before;
      this.check(generation, signal);
      this.prune();
      return name === 'list_group_requests'
        ? await this.list(args, self, generation, signal)
        : await this.respond(args, self, generation, signal);
    } catch (error) {
      return this.error(error, signal);
    } finally {
      release();
    }
  }

  private parse(name: string, value: unknown): JsonObject {
    const allowed =
      name === 'list_group_requests'
        ? ['limit', 'offset']
        : ['request_handle', 'approve', 'reason'];
    if (
      !isDataObject(value) ||
      Object.keys(value).some((k) => !allowed.includes(k))
    ) {
      fail('invalid_arguments');
    }
    if (name === 'list_group_requests') {
      if (
        !Object.hasOwn(value, 'limit') ||
        !safeNatural(value.limit) ||
        value.limit === 0 ||
        (Object.hasOwn(value, 'offset') && !safeNatural(value.offset))
      ) {
        fail('invalid_arguments');
      }
      return { limit: value.limit, offset: value.offset ?? 0 };
    }
    if (
      Object.keys(value).length !== 3 ||
      typeof value.request_handle !== 'string' ||
      !/^grq_[0-9a-f]{48}$/.test(value.request_handle) ||
      typeof value.approve !== 'boolean' ||
      typeof value.reason !== 'string' ||
      Buffer.byteLength(value.reason) > 512 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(
        value.reason,
      ) ||
      (value.approve && value.reason !== '')
    ) {
      fail('invalid_arguments');
    }
    return {
      request_handle: value.request_handle,
      approve: value.approve,
      reason: value.reason,
    };
  }

  private check(generation: number, signal?: AbortSignal): void {
    if (signal?.aborted) {
      fail('cancelled');
    }
    if (generation !== this.epoch) {
      fail('capabilities_revoked');
    }
  }

  private error(error: unknown, signal?: AbortSignal): JsonObject {
    return {
      status: 'error',
      error: signal?.aborted
        ? 'cancelled'
        : failureCode(error, 'verification_failed'),
      ...(error instanceof ToolFailure &&
      error.code === 'request_already_submitted'
        ? { previous_submitted: true, dispatched: false }
        : {}),
    };
  }

  private async read(
    action: string,
    params: JsonObject,
    generation: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.check(generation, signal);
    let value: unknown;
    try {
      value = await this.api.call(action, params);
    } catch {
      this.check(generation, signal);
      fail('verification_unavailable');
    }
    this.check(generation, signal);
    return value;
  }

  private async authorize(
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const login = await this.read('get_login_info', {}, generation, signal);
    if (!isDataObject(login) || id(login.user_id) !== self) {
      fail('identity_mismatch');
    }
    const member = await this.read(
      'get_group_member_info',
      { group_id: this.groupId, user_id: self, no_cache: true },
      generation,
      signal,
    );
    if (
      !isDataObject(member) ||
      id(member.group_id) !== this.groupId ||
      id(member.user_id) !== self
    ) {
      fail('verification_failed');
    }
    if (member.role !== 'admin' && member.role !== 'owner') {
      fail('permission_denied');
    }
  }

  private key(self: string, nativeFlag: string): string {
    return createHash('sha256')
      .update(JSON.stringify([self, this.groupId, nativeFlag]))
      .digest('hex');
  }

  private async pending(
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<Pending[]> {
    const raw = await this.read(
      'get_group_system_msg',
      { count: SOURCE_LIMIT },
      generation,
      signal,
    );
    if (
      !isDataObject(raw) ||
      !Array.isArray(raw.join_requests) ||
      !Array.isArray(raw.invited_requests)
    ) {
      fail('invalid_response');
    }
    const invitations = raw.invited_requests;
    // InvitedRequest别名字段也纳入歧义检查，但与正式字段完全相同的条目不算重复；只要有不同的匹配邀请就拒绝。
    const alias = Array.isArray(raw.InvitedRequest) ? raw.InvitedRequest : [];
    if (
      raw.join_requests.length + invitations.length > SOURCE_LIMIT ||
      alias.length > SOURCE_LIMIT
    ) {
      fail('resource_limit');
    }
    const seen = new Map<string, number>(),
      blocked = new Set<string>();
    for (const row of raw.join_requests) {
      if (isDataObject(row)) {
        const f = flag(row.request_id);
        if (f) {
          seen.set(f, (seen.get(f) ?? 0) + 1);
        }
      }
    }
    for (const row of [...invitations, ...alias]) {
      if (isDataObject(row)) {
        const f = flag(row.request_id);
        if (f) {
          blocked.add(f);
        }
      }
    }
    const result: Pending[] = [];
    for (const row of raw.join_requests) {
      if (
        !isDataObject(row) ||
        id(row.group_id) !== this.groupId ||
        row.checked !== false
      ) {
        continue;
      }
      const nativeFlag = flag(row.request_id),
        applicant = id(row.invitor_uin);
      if (
        !nativeFlag ||
        !applicant ||
        seen.get(nativeFlag) !== 1 ||
        blocked.has(nativeFlag)
      ) {
        continue;
      }
      result.push({
        key: this.key(self, nativeFlag),
        flag: nativeFlag,
        applicant,
        raw: row,
      });
    }
    return result;
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, h] of this.handles) {
      if (h.expires <= now) {
        this.handles.delete(token);
      }
    }
  }

  private issue(row: Pending, self: string): string {
    for (const [token, h] of this.handles) {
      if (
        h.key === row.key &&
        h.applicant === row.applicant &&
        h.self === self
      ) {
        return token;
      }
    }
    if (this.handles.size >= CAPACITY) {
      fail('handle_capacity');
    }
    const token = `grq_${randomBytes(24).toString('hex')}`;
    this.handles.set(token, {
      key: row.key,
      flag: row.flag,
      applicant: row.applicant,
      self,
      expires: Date.now() + TTL_MS,
    });
    return token;
  }

  private async list(
    args: JsonObject,
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    await this.authorize(self, generation, signal);
    const rows = await this.pending(self, generation, signal),
      offset = args.offset as number,
      requested = args.limit as number;
    const end =
      offset >= rows.length
        ? offset
        : offset + Math.min(requested, rows.length - offset);
    const items: JsonObject[] = [];
    let index = offset,
      bytes = 0,
      reason = 'limit';
    for (; index < end; index++) {
      const row = rows[index]!;
      const item: JsonObject = {
        applicant_id: row.applicant,
        pending_observed: true,
        untrusted: true,
      };
      const message = text(row.raw.message),
        nickname = text(row.raw.requester_nick);
      if (message !== undefined) {
        item.message = message;
      }
      if (nickname !== undefined) {
        item.applicant_nickname = nickname;
      }
      if (
        (typeof row.raw.message === 'string' &&
          row.raw.message.length > 1024) ||
        (typeof row.raw.requester_nick === 'string' &&
          row.raw.requester_nick.length > 1024)
      ) {
        item.content_truncated = true;
      }
      if (this.uncertain.has(row.key)) {
        item.previous_outcome = 'unknown';
      } else if (this.submitted.has(row.key)) {
        item.previous_outcome =
          this.submitted.get(row.key)!.applicant === row.applicant
            ? 'submitted'
            : 'identity_conflict';
      }
      const size = Buffer.byteLength(JSON.stringify(item)) + 150;
      if (bytes + size > OUTPUT_LIMIT - 2000) {
        reason = 'output_limit';
        break;
      }
      try {
        const token = this.issue(row, self);
        item.request_handle = token;
        item.request_handle_expires_at =
          this.handles.get(token)!.expires / 1000;
      } catch (error) {
        if (
          !(error instanceof ToolFailure) ||
          error.code !== 'handle_capacity'
        ) {
          throw error;
        }
        reason = 'handle_capacity';
        break;
      }
      items.push(item);
      bytes += size;
    }
    this.check(generation, signal);
    const more = index < rows.length;
    const result: JsonObject = {
      status: 'ok',
      untrusted: true,
      group_id: this.groupId,
      queried_at: Date.now() / 1000,
      items,
      requested,
      returned: items.length,
      offset,
      next_offset: more ? index : null,
      has_more: more,
      truncated: more || items.some((x) => x.content_truncated === true),
      reason: more ? reason : 'end_of_observed_requests',
      total: rows.length,
      total_scope: 'eligible_observed_current_group_requests',
      completeness: 'unknown_upstream_coverage_and_unverifiable_entries',
      upstream_coverage: 'bounded_account_prefix_missing_is_not_absence',
      upstream_has_more: null,
      pagination: 'local_slice_of_fresh_response',
      handle_ttl_seconds: TTL_MS / 1000,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMIT) {
      fail('resource_limit');
    }
    return result;
  }

  private async verifiedRequest(
    args: JsonObject,
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<{ handle: Handle; current: Pending }> {
    const handle = this.handles.get(args.request_handle as string);
    if (!handle || handle.expires <= Date.now() || handle.self !== self) {
      fail('invalid_request_handle');
    }
    if (this.uncertain.has(handle.key)) {
      fail('previous_result_unknown');
    }
    if (this.submitted.has(handle.key)) {
      fail('request_already_submitted');
    }
    if (this.uncertain.size + this.submitted.size >= CAPACITY) {
      fail('outcome_lock_capacity');
    }
    await this.authorize(self, generation, signal);
    const rows = await this.pending(self, generation, signal);
    const current = rows.find(
      (row) =>
        row.key === handle.key &&
        row.applicant === handle.applicant &&
        row.flag === handle.flag,
    );
    if (!current) {
      fail('request_not_pending_or_changed');
    }
    // 拉取列表可能较慢，派发前重新校验账号身份和权限，不沿用查询前的角色。
    await this.authorize(self, generation, signal);
    if (
      handle.expires <= Date.now() ||
      this.handles.get(args.request_handle as string) !== handle
    ) {
      fail('invalid_request_handle');
    }
    this.check(generation, signal);
    if (this.uncertain.has(handle.key)) {
      fail('previous_result_unknown');
    }
    if (this.submitted.has(handle.key)) {
      fail('request_already_submitted');
    }
    return { handle, current };
  }

  private async respond(
    args: JsonObject,
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const token = this.handles.get(args.request_handle as string);
    const intent = createHash('sha256')
      .update(JSON.stringify([args.approve, args.reason]))
      .digest('hex');
    if (token && token.self === self && token.expires > Date.now()) {
      const prior = this.submitted.get(token.key);
      if (prior) {
        await this.authorize(self, generation, signal);
        this.check(generation, signal);
        if (
          this.handles.get(args.request_handle as string) !== token ||
          token.expires <= Date.now()
        ) {
          fail('invalid_request_handle');
        }
        if (prior.applicant !== token.applicant) {
          return {
            status: 'error',
            error: 'request_identity_changed',
            previous_submitted: true,
            dispatched: false,
          };
        }
        return prior.intent === intent
          ? {
              ...structuredClone(prior.result),
              cached: true,
              dispatched: false,
            }
          : {
              status: 'error',
              error: 'request_already_submitted',
              previous_submitted: true,
              dispatched: false,
            };
      }
    }
    const { handle } = await this.verifiedRequest(
      args,
      self,
      generation,
      signal,
    );
    this.uncertain.add(handle.key); // 在产生外部影响之前先占位，也防止与reset竞态。
    let result: JsonObject;
    try {
      const value = await this.api.call('set_group_add_request', {
        flag: handle.flag,
        approve: args.approve,
        reason: args.reason,
        count: SOURCE_LIMIT,
      });
      result =
        value === null
          ? submittedResult({
              action: 'respond_group_request',
              group_id: this.groupId,
            })
          : {
              status: 'unknown',
              error: 'operation_result_unknown',
              effect_unknown: true,
              retry_allowed: false,
            };
    } catch (error) {
      result = writeFailure(error, 'operation_result_unknown');
    }
    result = afterDispatch(
      result,
      !!signal?.aborted || generation !== this.epoch,
    );
    if (result.status === 'ok') {
      this.uncertain.delete(handle.key);
      this.submitted.set(handle.key, {
        intent,
        applicant: handle.applicant,
        result: structuredClone(result),
      });
    } else if (result.dispatched === false) {
      this.uncertain.delete(handle.key);
    }
    return result;
  }
}
