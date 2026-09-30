import { LISTENER_GROUP, resolveGroupId } from '../../contracts/identity.ts';
import { type Api } from '../../contracts/onebot.ts';
import { type Memory, type TimelineEntry } from '../../contracts/messages.ts';
import { type JsonObject } from '../../contracts/json.ts';
import { type TurnContext } from '../../contracts/tools.ts';
import {
  isKnownReactionId,
  createReactionTool as catalogReactionTool,
} from '../../onebot/catalog/reactions.ts';
import {
  submittedResult,
  writeFailure,
  afterDispatch,
} from '../../onebot/operation-result.ts';

export function createReactionTool() {
  const tool = catalogReactionTool();
  tool.function.description =
    tool.function.description.replace(
      '即时执行，后续取消本轮不回滚已执行操作。',
      '即时向provider提交请求，后续取消本轮不回滚提交。',
    ) +
    ' 正常结果submitted=true只证明provider接受提交，不代表已观察到QQ贴上或移除表情，也不是失败。重复同一动作返回原提交而不重发；明确要求的add/remove可作为新的期望状态独立提交，但不得仅因缺少业务回执而盲目反向试探或补偿。真实unknown仍禁止同一消息与表情的双向重试。';
  return tool;
}

/** 不透明的归属令牌：可变状态绝不来自模型参数。 */
export interface ReactionTurn {
  readonly reaction_turn: true;
}

type Action = 'add' | 'remove';

interface PairState {
  queue: Promise<void>;
  last?: { action: Action; result: JsonObject };
  unknown?: JsonObject;
}

interface TurnState {
  pairs: Map<string, PairState>;
}

const MAX_PAIR_RESOURCES = 4096; // 内存上限；调用次数由wake runner统计。
const error = (code: string): JsonObject => ({ status: 'error', error: code });

function record(value: unknown): value is Record<string, unknown> {
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

function messageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 17 &&
    /^(0|-?[1-9][0-9]*)$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    String(Number(value)) === value
  );
}

function remoteMessageId(value: unknown): string | undefined {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  ) {
    return String(value);
  }
  return messageId(value) ? value : undefined;
}

function identity(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    value.trim() !== value ||
    !/^[1-9][0-9]*$/.test(value)
  ) {
    return undefined;
  }
  return value;
}

/**
 * 原生returnSchema为Any：正常的JSON只表示已提交，不是业务ACK。
 * 分类时不执行getter/toJSON，也不暴露原生响应体。
 */
function jsonResponse(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 8192 },
): boolean {
  if (--budget.nodes < 0 || depth > 32) {
    return false;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || !value || seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) {
        return false;
      }
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, 'value') ||
          !jsonResponse(descriptor.value, depth + 1, seen, budget)
        ) {
          return false;
        }
      }
      return true;
    }
    if (!record(value)) {
      return false;
    }
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => jsonResponse(descriptor.value, depth + 1, seen, budget),
    );
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

export class ReactionTools {
  private readonly groupId: string;
  private readonly turns = new WeakMap<ReactionTurn, TurnState>();
  constructor(
    private readonly api: Api,
    private readonly memory: Memory,
    groupId: string = LISTENER_GROUP,
  ) {
    this.groupId = resolveGroupId(groupId);
  }

  createTurn(): ReactionTurn {
    const token: ReactionTurn = Object.freeze({ reaction_turn: true });
    this.turns.set(token, { pairs: new Map() });
    return token;
  }

  async react(
    args: unknown,
    context: TurnContext,
    state: ReactionTurn,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    if (!context || context.groupId !== this.groupId) {
      return error('forbidden_group');
    }
    if (!state || typeof state !== 'object') {
      return error('invalid_turn');
    }
    const turn = this.turns.get(state);
    if (!turn) {
      return error('invalid_turn');
    }
    if (
      !record(args) ||
      Object.keys(args).length !== 3 ||
      !['message_id', 'emoji_id', 'action'].every((key) =>
        Object.hasOwn(args, key),
      ) ||
      !messageId(args.message_id) ||
      (args.action !== 'add' && args.action !== 'remove')
    ) {
      return error('invalid_arguments');
    }
    try {
      if (!isKnownReactionId(args.emoji_id)) {
        return error('invalid_arguments');
      }
    } catch {
      return error('reaction_catalog_unavailable');
    }
    if (signal?.aborted) {
      return error('cancelled');
    }
    const id = args.message_id,
      emoji = args.emoji_id as string,
      action = args.action;
    let local: TimelineEntry | undefined;
    try {
      local = this.memory.find(id);
      if (
        local &&
        (!record(local) || local.messageId !== id || !identity(local.userId))
      ) {
        return error('verification_failed');
      }
      if (
        !local &&
        !this.memory.recent().some((entry) => entry.replyTo === id)
      ) {
        return error('message_not_in_context');
      }
    } catch {
      return error('verification_failed');
    }
    const key = `${id}:${emoji}`;
    let pair = turn.pairs.get(key);
    if (!pair) {
      if (turn.pairs.size >= MAX_PAIR_RESOURCES) {
        return error('resource_limit');
      }
      pair = { queue: Promise.resolve() };
      turn.pairs.set(key, pair);
    }
    // 在等待队列/RPC之前快照发送者。上层传入的是冻结的memory，但即使调用方改动了源记录也不能影响这份证明。
    const sender = local?.userId;
    const ownedPair = pair;
    const operation = pair.queue.then(() =>
      this.perform(id, emoji, action, sender, ownedPair, signal),
    );
    pair.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async perform(
    id: string,
    emoji: string,
    action: Action,
    sender: string | undefined,
    pair: PairState,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const duplicate = (result: JsonObject): JsonObject =>
      structuredClone({ ...result, duplicate: true });
    // 已派发但结果不确定的写操作之后，两种目标状态都不再重试。
    // 保留原先派发的参数；requested_action标出被拦下的相反操作，不假装它已发给QQ。
    if (pair.unknown) {
      return duplicate({
        ...pair.unknown,
        ...(pair.unknown.action !== action ? { requested_action: action } : {}),
      });
    }
    if (pair.last?.action === action) {
      return duplicate(pair.last.result);
    }
    if (signal?.aborted) {
      return error('cancelled');
    }
    const remember = (result: JsonObject): JsonObject => {
      pair.last = { action, result: structuredClone(result) };
      if (result.status === 'unknown') {
        pair.unknown = structuredClone(result);
      }
      return result;
    };
    let remote: unknown;
    try {
      remote = await this.api.call('get_msg', { message_id: id });
    } catch {
      return remember(error('api_unavailable'));
    }
    if (signal?.aborted) {
      return remember(error('cancelled'));
    }
    if (
      !record(remote) ||
      remote.message_type !== 'group' ||
      identity(remote.group_id) !== this.groupId ||
      remoteMessageId(remote.message_id) !== id ||
      !record(remote.sender)
    ) {
      return remember(error('verification_failed'));
    }
    const remoteSender = identity(remote.sender.user_id);
    if (
      !remoteSender ||
      (sender !== undefined && remoteSender !== sender) ||
      (Object.hasOwn(remote, 'user_id') &&
        identity(remote.user_id) !== remoteSender)
    ) {
      return remember(error('verification_failed'));
    }
    if (signal?.aborted) {
      return remember(error('cancelled'));
    }
    const tuple = { message_id: id, emoji_id: emoji, action };
    const unknown = (): JsonObject =>
      remember({
        ...writeFailure(undefined, 'reaction_result_unknown'),
        ...tuple,
      });
    let result: unknown;
    try {
      result = await this.api.call('set_msg_emoji_like', {
        message_id: id,
        emoji_id: emoji,
        set: action === 'add',
      });
    } catch (failure) {
      return remember({
        ...writeFailure(failure, 'reaction_result_unknown'),
        ...tuple,
      });
    }
    // 原生调用派发后再取消也无法撤销其结果。
    if (!jsonResponse(result)) {
      return unknown();
    }
    if (
      record(result) &&
      Object.hasOwn(result, 'result') &&
      (result.result === false ||
        (typeof result.result === 'number' &&
          Number.isFinite(result.result) &&
          result.result !== 0))
    ) {
      return remember({
        status: 'error',
        error: 'reaction_rejected',
        ...tuple,
      });
    }
    return remember(
      afterDispatch(submittedResult(tuple), signal?.aborted === true),
    );
  }
}
