import type { JsonObject } from '../contracts/json.ts';
import { isObject } from '../contracts/json.ts';
import type { Memory } from '../contracts/messages.ts';
import type { TurnContext } from '../contracts/tools.ts';
import type { Moderation } from '../tools/management/moderation.ts';
import type { GroupSender, SentMessage } from './group-sender.ts';
import type { SideEffectPacer } from './pacing.ts';
import type { TurnStats } from './turn-outcome.ts';
import {
  confirmationNotice,
  spaceSends,
  type WakeFlags,
} from './wake-shared.ts';

export interface WakeManagementDeps {
  pacer: SideEffectPacer;
  /** /reset会替换Moderation实例，所以每次调用时读取。 */
  moderation: () => Moderation;
  sender: GroupSender;
  memory: Memory;
  session: boolean;
  stats: TurnStats;
  wake: WakeFlags;
  valid: () => boolean;
  /** 确认提示已发出并被ACK。 */
  onNotified: (entry: SentMessage) => void;
}

/** 一次wake内的群管工具调用状态：结果缓存、目标映射与结果未知的目标。 */
export class WakeManagement {
  private readonly results = new Map<string, JsonObject>();
  private readonly targets = new Map<string, string>();
  private readonly unknownTargets = new Set<string>();

  constructor(
    private readonly enabled: ReadonlySet<string>,
    private readonly deps: WakeManagementDeps,
  ) {}

  /** 执行一次群管工具调用：同轮去重、目标状态未知时拒绝重复操作，必要时发出确认提示。返回undefined表示wake已失效。 */
  async execute(
    call: { function: { name: string } },
    args: unknown,
    context: TurnContext,
    signal: AbortSignal,
  ): Promise<JsonObject | undefined> {
    const { stats, wake, valid } = this.deps;
    let result: JsonObject;
    const key =
      call.function.name +
      ':' +
      JSON.stringify(
        isObject(args)
          ? Object.fromEntries(
              Object.keys(args)
                .sort()
                .map((key) => [key, args[key]]),
            )
          : args,
      );
    const cached = this.results.get(key);
    const recallId =
      isObject(args) && typeof args.message_id === 'string'
        ? args.message_id
        : undefined;
    if (!this.enabled.has(call.function.name)) {
      result = { status: 'error', error: 'tool_disabled' };
    } else if (cached) {
      result = { ...cached, duplicate: true };
    } else if (
      isObject(args) &&
      typeof args.user_id === 'string' &&
      this.unknownTargets.has(
        `${call.function.name === 'set_member_card' ? 'card' : 'mute'}:${args.user_id}`,
      )
    ) {
      result = { status: 'unknown', error: 'delivery_unknown' };
    } else if (
      call.function.name === 'recall_message' &&
      recallId &&
      !this.deps.memory.find(recallId) &&
      !this.deps.memory.recent().some((entry) => entry.replyTo === recallId)
    ) {
      result = { status: 'error', error: 'message_not_in_context' };
    } else {
      await this.deps.pacer.take(signal);
      if (!valid()) {
        return undefined;
      }
      result = await this.deps
        .moderation()
        .request(
          call.function.name,
          args,
          context,
          signal,
          call.function.name === 'recall_message' && recallId
            ? this.deps.memory.find(recallId)?.userId
            : undefined,
        );
      const targetKey =
        isObject(args) && typeof args.user_id === 'string'
          ? `${call.function.name === 'set_member_card' ? 'card' : 'mute'}:${args.user_id}`
          : undefined;
      if (targetKey) {
        this.targets.set(key, targetKey);
      }
      if (
        result.status === 'executed' &&
        targetKey &&
        ['mute_member', 'unmute_member', 'set_member_card'].includes(
          call.function.name,
        )
      ) {
        for (const [oldKey, oldTarget] of this.targets) {
          if (
            oldTarget === targetKey &&
            this.results.get(oldKey)?.status === 'executed'
          ) {
            this.results.delete(oldKey);
          }
        }
      }
      this.results.set(key, structuredClone(result));
      if (result.status === 'executed') {
        stats.managementExecuted++;
      } else if (result.status === 'unknown') {
        stats.managementUnknown++;
        if (targetKey) {
          this.unknownTargets.add(targetKey);
        }
      }
    }
    if (!valid()) {
      return undefined;
    }
    if (result.status === 'error' || result.status === 'unknown') {
      wake.managementNeedsReview = true;
    }
    if (result.status === 'confirmation_required' && !cached) {
      const code = String(result.code);
      try {
        if (wake.lastSendAt) {
          await spaceSends(wake.lastSendAt, signal);
        }
        if (!valid()) {
          throw new Error('cancelled');
        }
        wake.sending = true;
        const text = confirmationNotice(result, code);
        const entry = await this.deps.sender.sendPart(
          { segments: [{ type: 'text', data: { text } }], text },
          context,
          signal,
        );
        if (!valid()) {
          throw new Error('cancelled');
        }
        if (!this.deps.session && this.deps.memory.find(entry.messageId)) {
          throw new Error('delivery_unknown');
        }
        this.deps.onNotified(entry);
        stats.sentMessages++;
        result = {
          status: 'confirmation_required',
          notification_message_id: entry.messageId,
        };
      } catch {
        this.deps.moderation().cancelPending(code);
        result = {
          status: 'unknown',
          error: 'confirmation_notification_failed',
          proposal_cancelled: true,
        };
        wake.managementNeedsReview = true;
      } finally {
        wake.sending = false;
        wake.lastSendAt = Date.now();
      }
      this.results.set(key, structuredClone(result));
      if (!valid()) {
        return undefined;
      }
    }
    return result;
  }
}
