import { randomBytes } from 'node:crypto';
import { MAX_MUTE_SECONDS } from '../../contracts/tool-limits.ts';
import { writeFailure } from '../../onebot/operation-result.ts';
import { log } from '../../observability/logger.ts';
import type { ModerationPolicy } from '../../config/listener.ts';
import {
  LISTENER_GROUP,
  resolveGroupId,
  OWNER_ID,
  resolveOwnerId,
} from '../../contracts/identity.ts';
import { type Api } from '../../contracts/onebot.ts';
import { type JsonObject } from '../../contracts/json.ts';
import {
  type ToolDefinition,
  type TurnContext,
} from '../../contracts/tools.ts';

type Mode = 'off' | 'confirm' | 'direct';

const userIdSchema = {
  type: 'string',
  maxLength: 32,
  pattern: '^[1-9][0-9]*$',
  description:
    'Target QQ user ID in this group; actual QQ permissions apply. Nicknames are not identity proof.',
};
const parameters = (
  properties: JsonObject,
  required: string[],
): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
export const MODERATION_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'mute_member',
      description:
        'Mute an eligible current-group member under the configured capability policy.',
      parameters: parameters(
        {
          user_id: userIdSchema,
          seconds: { type: 'integer', minimum: 1, maximum: MAX_MUTE_SECONDS },
        },
        ['user_id', 'seconds'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'unmute_member',
      description:
        'Unmute an eligible current-group member under the configured capability policy.',
      parameters: parameters({ user_id: userIdSchema }, ['user_id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_message',
      description:
        'Recall a verified current-group message under the configured capability policy, including messages sent by the bot itself. Recalling own messages does not require a group administrator role; QQ may still reject expired or otherwise ineligible messages.',
      parameters: parameters(
        {
          message_id: {
            type: 'string',
            maxLength: 17,
            pattern: '^(0|-?[1-9][0-9]*)$',
          },
        },
        ['message_id'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_member_card',
      description:
        'Change an eligible current-group member card under the configured capability policy.',
      parameters: parameters(
        {
          user_id: userIdSchema,
          card: { type: 'string', minLength: 1, maxLength: 60 },
        },
        ['user_id', 'card'],
      ),
    },
  },
];

type Action =
  | { name: 'mute_member'; user_id: string; seconds: number }
  | { name: 'unmute_member'; user_id: string }
  | { name: 'set_member_card'; user_id: string; card: string }
  | { name: 'recall_message'; message_id: string };

const policyKey = {
  mute_member: 'mute',
  unmute_member: 'unmute',
  recall_message: 'recall',
  set_member_card: 'memberCard',
} as const;

type ActionName = keyof typeof policyKey;

export interface ExternalModerationProposal {
  name: string;
  description: string;
  /**
   * 每次await之后都要重新校验范围和权限，并检查本次确认的signal。
   * 写操作一旦派发，必须保留真实的ACK，否则返回unknown。
   */
  execute(context: TurnContext, signal: AbortSignal): Promise<JsonObject>;
}

type Pending = { context: TurnContext; expires: number } & (
  | { kind: 'legacy'; action: Action; target: string }
  | { kind: 'external'; external: ExternalModerationProposal }
);

function record(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  try {
    return (
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === 'string' &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
      )
    );
  } catch {
    return false;
  }
}

function id(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === 'string' &&
    value.length <= 32 &&
    value.trim() === value &&
    /^[1-9][0-9]*$/.test(value)
    ? value
    : undefined;
}

function messageId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && !Object.is(value, -0)
      ? String(value)
      : undefined;
  }
  return typeof value === 'string' &&
    value.length <= 17 &&
    /^(0|-?[1-9][0-9]*)$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    String(Number(value)) === value
    ? value
    : undefined;
}

class Denied extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const deny = (code = 'verification_failed'): never => {
  throw new Denied(code);
};

function policy(
  options: Partial<ModerationPolicy> = {},
): Readonly<ModerationPolicy> {
  const defaults: ModerationPolicy = {
    mute: 'off',
    unmute: 'off',
    recall: 'off',
    memberCard: 'off',
    confirmationTtlSeconds: 60,
    maxMuteSeconds: MAX_MUTE_SECONDS,
  };
  if (
    !record(options) ||
    Reflect.ownKeys(options).some(
      (key) => typeof key !== 'string' || !Object.hasOwn(defaults, key),
    )
  ) {
    throw new Error('Invalid moderation options');
  }
  const value = { ...defaults, ...options };
  if (
    ['mute', 'unmute', 'recall', 'memberCard'].some(
      (key) =>
        !['off', 'confirm', 'direct'].includes(
          value[key as keyof ModerationPolicy] as string,
        ),
    ) ||
    !Number.isInteger(value.confirmationTtlSeconds) ||
    value.confirmationTtlSeconds < 1 ||
    value.confirmationTtlSeconds > 60 ||
    !Number.isInteger(value.maxMuteSeconds) ||
    value.maxMuteSeconds < 1 ||
    value.maxMuteSeconds > MAX_MUTE_SECONDS
  ) {
    throw new Error('Invalid moderation options');
  }
  return Object.freeze(value);
}

export function buildModerationTools(
  options: Partial<ModerationPolicy> = {},
): ToolDefinition[] {
  const configured = policy(options);
  return MODERATION_TOOLS.filter(
    (tool) => configured[policyKey[tool.function.name as ActionName]] !== 'off',
  ).map((source) => {
    const tool = structuredClone(source),
      mode = configured[policyKey[tool.function.name as ActionName]];
    tool.function.description +=
      mode === 'confirm'
        ? ` The bot may decide autonomously from current-group context. Requires owner /confirm within ${configured.confirmationTtlSeconds} seconds; confirmation_required is not execution.`
        : ' The bot may decide autonomously from current-group context and execute immediately without approval. Only executed means success; unknown means delivery is uncertain and must not be blindly retried.';
    if (tool.function.name === 'mute_member') {
      (
        (tool.function.parameters.properties as JsonObject)
          .seconds as JsonObject
      ).maximum = configured.maxMuteSeconds;
    }
    return tool;
  });
}

/**
 * 群管理操作与主人确认流程。提案生成一次性确认码，只有主人在同群、有效期内确认才会执行；
 * 确认时重新校验身份、权限和目标。
 */
export class Moderation {
  private readonly pending = new Map<string, Pending>();
  private disposed = false;
  private readonly externalLifetime = new AbortController();
  private readonly policy: Readonly<ModerationPolicy>;
  private readonly groupId: string;
  private readonly ownerId: string;
  constructor(
    private readonly api: Api,
    private readonly now: () => number = Date.now,
    options: Partial<ModerationPolicy> = {},
    groupId: string = LISTENER_GROUP,
    ownerId: string = OWNER_ID,
  ) {
    this.groupId = resolveGroupId(groupId);
    this.ownerId = resolveOwnerId(ownerId);
    this.policy = policy(options);
  }

  private check(signal?: AbortSignal, expires?: number): void {
    if (this.disposed || signal?.aborted) {
      deny('cancelled');
    }
    if (expires !== undefined && this.now() >= expires) {
      deny('confirmation_expired');
    }
  }

  private scope(context: TurnContext): TurnContext {
    if (
      !record(context) ||
      context.groupId !== this.groupId ||
      typeof context.actorId !== 'string' ||
      id(context.actorId) !== context.actorId ||
      typeof context.selfId !== 'string' ||
      id(context.selfId) !== context.selfId ||
      context.selfId === this.ownerId ||
      typeof context.messageId !== 'string' ||
      messageId(context.messageId) !== context.messageId
    ) {
      deny('forbidden_context');
    }
    return {
      groupId: this.groupId,
      actorId: context.actorId,
      selfId: context.selfId,
      messageId: context.messageId,
    };
  }

  private parse(name: string, args: unknown): Action {
    if (!Object.hasOwn(policyKey, name) || !record(args)) {
      return deny('invalid_arguments');
    }
    const expected =
      name === 'mute_member'
        ? ['user_id', 'seconds']
        : name === 'set_member_card'
          ? ['user_id', 'card']
          : name === 'recall_message'
            ? ['message_id']
            : ['user_id'];
    if (
      Reflect.ownKeys(args).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(args, key))
    ) {
      return deny('invalid_arguments');
    }
    if (name === 'recall_message') {
      if (
        typeof args.message_id !== 'string' ||
        messageId(args.message_id) !== args.message_id
      ) {
        return deny('invalid_arguments');
      }
      return { name, message_id: args.message_id };
    }
    if (typeof args.user_id !== 'string' || id(args.user_id) !== args.user_id) {
      return deny('invalid_arguments');
    }
    if (name === 'unmute_member') {
      return { name, user_id: args.user_id };
    }
    if (
      name === 'mute_member' &&
      typeof args.seconds === 'number' &&
      Number.isInteger(args.seconds) &&
      args.seconds >= 1 &&
      args.seconds <= this.policy.maxMuteSeconds
    ) {
      return { name, user_id: args.user_id, seconds: args.seconds };
    }
    if (
      name === 'set_member_card' &&
      typeof args.card === 'string' &&
      Array.from(args.card).length >= 1 &&
      Array.from(args.card).length <= 60 &&
      !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(args.card)
    ) {
      return { name, user_id: args.user_id, card: args.card };
    }
    return deny('invalid_arguments');
  }

  private mode(action: Action): Mode {
    return this.policy[policyKey[action.name]];
  }

  private async read(
    action: string,
    params: JsonObject,
    signal?: AbortSignal,
    expires?: number,
  ): Promise<unknown> {
    this.check(signal, expires);
    let value: unknown;
    try {
      value = await this.api.call(action, params);
    } catch {
      this.check(signal, expires);
      return deny('verification_unavailable');
    }
    this.check(signal, expires);
    return value;
  }

  private member(
    value: unknown,
    expected: string,
  ): 'member' | 'admin' | 'owner' {
    if (
      !record(value) ||
      id(value.group_id) !== this.groupId ||
      id(value.user_id) !== expected ||
      !['member', 'admin', 'owner'].includes(value.role as string)
    ) {
      return deny();
    }
    return value.role as 'member' | 'admin' | 'owner';
  }

  private async verify(
    action: Action,
    context: TurnContext,
    signal?: AbortSignal,
    expires?: number,
    expectedSender?: string,
  ): Promise<string> {
    // 这份证明只来自调用方冻结的memory，绝不来自模型参数。
    if (expectedSender !== undefined) {
      if (
        action.name !== 'recall_message' ||
        typeof expectedSender !== 'string' ||
        id(expectedSender) !== expectedSender
      ) {
        return deny('verification_failed');
      }
    }
    const login = await this.read('get_login_info', {}, signal, expires);
    if (!record(login) || id(login.user_id) !== context.selfId) {
      return deny('identity_mismatch');
    }
    const botRole = this.member(
      await this.read(
        'get_group_member_info',
        { group_id: this.groupId, user_id: context.selfId, no_cache: true },
        signal,
        expires,
      ),
      context.selfId,
    );
    let target: string;
    if (action.name === 'recall_message') {
      const message = await this.read(
        'get_msg',
        { message_id: action.message_id },
        signal,
        expires,
      );
      if (
        !record(message) ||
        message.message_type !== 'group' ||
        id(message.group_id) !== this.groupId ||
        messageId(message.message_id) !== action.message_id ||
        !record(message.sender)
      ) {
        return deny();
      }
      const sender = id(message.sender.user_id);
      if (
        !sender ||
        (Object.hasOwn(message, 'user_id') && id(message.user_id) !== sender) ||
        (expectedSender !== undefined && sender !== expectedSender)
      ) {
        return deny();
      }
      target = sender;
    } else {
      target = action.user_id;
    }
    // 撤回自己的消息、修改自己的群名片属于账号自身操作，不是管理其他成员。
    // 上面的群、登录和消息证明（包括冻结的发送者检查）照常保留，但不要求管理员身份。
    if (
      target === context.selfId &&
      (action.name === 'recall_message' || action.name === 'set_member_card')
    ) {
      return target;
    }
    if (botRole === 'member') {
      return deny('permission_denied');
    }
    const role = this.member(
      await this.read(
        'get_group_member_info',
        { group_id: this.groupId, user_id: target, no_cache: true },
        signal,
        expires,
      ),
      target,
    );
    // Bot是群主时，不自行设定针对具体操作的管理员豁免；操作能否成功由原生API决定。
    if (role === 'owner' || (botRole !== 'owner' && role !== 'member')) {
      return deny('permission_denied');
    }
    return target;
  }

  private audit(
    action: string,
    context: TurnContext | undefined,
    target: string | undefined,
    outcome: string,
    seconds?: number,
    phase: 'request' | 'confirm' | 'direct' = 'request',
  ): void {
    // 在request/direct阶段，actor_id只是源消息的发送者，不是授权人。
    log('info', 'moderation.audit', {
      action,
      group_id: this.groupId,
      actor_id: context?.actorId,
      message_id: context?.messageId,
      target_id: target,
      seconds,
      outcome,
      phase,
    });
  }

  private resultError(error: unknown): JsonObject {
    return {
      status: 'error',
      error: error instanceof Denied ? error.code : 'moderation_failed',
    };
  }

  private async execute(
    action: Action,
    context: TurnContext,
    target: string,
    signal?: AbortSignal,
    expires?: number,
  ): Promise<JsonObject> {
    this.check(signal, expires);
    const phase = this.mode(action) === 'confirm' ? 'confirm' : 'direct';
    let result: unknown;
    try {
      if (action.name === 'mute_member' || action.name === 'unmute_member') {
        result = await this.api.call('set_group_ban', {
          group_id: this.groupId,
          user_id: action.user_id,
          duration: action.name === 'mute_member' ? action.seconds : 0,
        });
      } else if (action.name === 'set_member_card') {
        result = await this.api.call('set_group_card', {
          group_id: this.groupId,
          user_id: action.user_id,
          card: action.card,
        });
      } else {
        result = await this.api.call('delete_msg', {
          message_id: action.message_id,
        });
      }
    } catch (error) {
      const failure = writeFailure(error, 'delivery_unknown');
      this.audit(
        action.name,
        context,
        target,
        failure.status === 'error' ? 'rejected' : 'delivery_unknown',
        undefined,
        phase,
      );
      return failure;
    }
    // 这些handler会检查原生业务ACK（禁言/名片）或匹配的撤回事件，然后返回void；传输层只把外层成功规范化为null。
    // 不猜测任意原生result/retcode字段或标量的含义。
    // 派发不可撤销，即使已取消也保留其ACK。
    if (result !== null) {
      this.audit(
        action.name,
        context,
        target,
        'delivery_unknown',
        undefined,
        phase,
      );
      return writeFailure(undefined, 'delivery_unknown');
    }
    this.audit(
      action.name,
      context,
      target,
      'executed',
      action.name === 'mute_member'
        ? action.seconds
        : action.name === 'unmute_member'
          ? 0
          : undefined,
      phase,
    );
    return { status: 'executed' };
  }

  async request(
    name: string,
    args: unknown,
    context: TurnContext,
    signal?: AbortSignal,
    expectedSender?: string,
  ): Promise<JsonObject> {
    let fixed: TurnContext | undefined,
      action: Action | undefined,
      target: string | undefined;
    try {
      this.check(signal);
      fixed = this.scope(context);
      action = this.parse(name, args);
      const mode = this.mode(action);
      if (mode === 'off') {
        return deny('tool_disabled');
      }
      for (const [code, pending] of this.pending) {
        if (this.now() >= pending.expires) {
          this.pending.delete(code);
        }
      }
      if (mode === 'confirm' && this.pending.size >= 10) {
        return deny('confirmation_limit');
      }
      target = await this.verify(
        action,
        fixed,
        signal,
        undefined,
        expectedSender,
      );
      this.check(signal);
      if (mode === 'direct') {
        return await this.execute(action, fixed, target, signal);
      }
      if (this.pending.size >= 10) {
        return deny('confirmation_limit');
      }
      const code = randomBytes(16).toString('hex');
      this.pending.set(code, {
        kind: 'legacy',
        action,
        context: fixed,
        target,
        expires: this.now() + this.policy.confirmationTtlSeconds * 1000,
      });
      this.audit(
        action.name,
        fixed,
        target,
        'confirmation_required',
        action.name === 'mute_member'
          ? action.seconds
          : action.name === 'unmute_member'
            ? 0
            : undefined,
      );
      const description =
        action.name === 'mute_member'
          ? `禁言 QQ ${action.user_id} ${action.seconds} 秒`
          : action.name === 'unmute_member'
            ? `解除 QQ ${action.user_id} 的禁言`
            : action.name === 'recall_message'
              ? `撤回本群消息 ${action.message_id}（发送者 QQ ${target}）`
              : `将 QQ ${action.user_id} 的群名片改为 ${JSON.stringify(action.card)}`;
      return {
        status: 'confirmation_required',
        code,
        expires_in_seconds: this.policy.confirmationTtlSeconds,
        description: `群 ${this.groupId}：${description}`,
        action: { ...action },
      };
    } catch (error) {
      this.audit(action?.name ?? 'invalid', fixed, target, 'request_denied');
      return this.resultError(error);
    }
  }

  requestExternal(
    input: ExternalModerationProposal,
    context: TurnContext,
    signal?: AbortSignal,
  ): JsonObject {
    let fixed: TurnContext | undefined,
      name = 'invalid';
    try {
      this.check(signal);
      fixed = this.scope(context);
      if (
        !record(input) ||
        Reflect.ownKeys(input).length !== 3 ||
        typeof input.name !== 'string' ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(input.name) ||
        typeof input.description !== 'string' ||
        !input.description.trim() ||
        Buffer.byteLength(input.description) > 4096 ||
        /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input.description) ||
        typeof input.execute !== 'function'
      ) {
        return deny('invalid_arguments');
      }
      name = input.name;
      for (const [code, pending] of this.pending) {
        if (this.now() >= pending.expires) {
          this.pending.delete(code);
        }
      }
      if (this.pending.size >= 10) {
        return deny('confirmation_limit');
      }
      const code = randomBytes(16).toString('hex');
      // 复制元数据，并有意不保留提案所在wake的signal。
      const external = {
        name,
        description: input.description,
        execute: input.execute,
      };
      this.pending.set(code, {
        kind: 'external',
        external,
        context: fixed,
        expires: this.now() + this.policy.confirmationTtlSeconds * 1000,
      });
      this.audit(name, fixed, undefined, 'confirmation_required');
      return {
        status: 'confirmation_required',
        code,
        expires_in_seconds: this.policy.confirmationTtlSeconds,
        description: `群 ${this.groupId}：${external.description}`,
      };
    } catch (error) {
      this.audit(name, fixed, undefined, 'request_denied');
      return this.resultError(error);
    }
  }

  private async confirmExternal(
    pending: Extract<Pending, { kind: 'external' }>,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    this.check(signal, pending.expires);
    const deadline = AbortSignal.timeout(
      Math.max(1, Math.ceil(pending.expires - this.now())),
    );
    const confirmationSignal = AbortSignal.any([
      this.externalLifetime.signal,
      deadline,
      ...(signal ? [signal] : []),
    ]);
    this.check(confirmationSignal, pending.expires);
    try {
      const result = await pending.external.execute(
        context,
        confirmationSignal,
      );
      // await之后不检查取消：已确认的迟到写入仍是事实。
      if (
        !record(result) ||
        !['ok', 'executed', 'unknown', 'error'].includes(
          result.status as string,
        )
      ) {
        throw new Error('Invalid external result');
      }
      this.audit(
        pending.external.name,
        context,
        undefined,
        result.status === 'unknown'
          ? 'delivery_unknown'
          : result.status === 'error'
            ? 'rejected'
            : result.submitted === true
              ? 'submitted'
              : 'executed',
        undefined,
        'confirm',
      );
      return result;
    } catch {
      // 只有回调自己知道是否已派发；不能把不透明的异常当成可以重试的依据，外部写入可能已经完成。
      this.audit(
        pending.external.name,
        context,
        undefined,
        'delivery_unknown',
        undefined,
        'confirm',
      );
      return writeFailure(undefined, 'delivery_unknown');
    }
  }

  async confirm(
    code: string,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    let fixed: TurnContext | undefined, pending: Pending | undefined;
    try {
      this.check(signal);
      fixed = this.scope(context);
      // 非主人或其他群/Bot不能消耗主人有效的确认码。
      if (fixed.actorId !== this.ownerId) {
        return deny('confirmation_denied');
      }
      if (typeof code !== 'string' || !/^[0-9a-f]{32}$/.test(code)) {
        return deny('confirmation_denied');
      }
      pending = this.pending.get(code);
      if (
        !pending ||
        pending.context.groupId !== fixed.groupId ||
        pending.context.selfId !== fixed.selfId
      ) {
        return deny('confirmation_denied');
      }
      this.pending.delete(code); // 在第一个await之前消耗确认码，并发确认只会执行一次。
      if (pending.kind === 'external') {
        return await this.confirmExternal(pending, fixed, signal);
      }
      const { name, ...args } = pending.action;
      const action = this.parse(name, args);
      if (this.mode(action) !== 'confirm') {
        return deny('tool_disabled');
      }
      this.check(signal, pending.expires);
      const target = await this.verify(
        action,
        fixed,
        signal,
        pending.expires,
        action.name === 'recall_message' ? pending.target : undefined,
      );
      if (target !== pending.target) {
        return deny('verification_failed');
      }
      this.check(signal, pending.expires);
      return await this.execute(action, fixed, target, signal, pending.expires);
    } catch (error) {
      this.audit(
        pending?.kind === 'external'
          ? pending.external.name
          : (pending?.action.name ?? 'invalid'),
        fixed,
        pending?.kind === 'legacy' ? pending.target : undefined,
        'confirmation_denied',
        undefined,
        'confirm',
      );
      return this.resultError(error);
    }
  }

  cancelPending(code: string): boolean {
    return this.pending.delete(code);
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.externalLifetime.abort();
  }
}
