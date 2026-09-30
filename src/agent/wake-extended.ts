import { setTimeout as delay } from 'node:timers/promises';
import { type JsonObject, isObject } from '../contracts/json.ts';
import type { ChatContentPart } from '../contracts/model.ts';
import type { ToolDefinition, TurnContext } from '../contracts/tools.ts';
import type { ProjectedListenerConfig } from '../config/listener.ts';
import { type ExtendedToolName } from '../config/extended-tools.ts';
import { prepareExtendedConfirmation } from '../tools/confirmation.ts';
import { GROUP_MEDIA_TOOL_NAMES } from '../tools/media/tools.ts';
import type { createExtendedTools } from '../tools/extended.ts';
import type { Moderation } from '../tools/management/moderation.ts';
import type { GroupSender, SentMessage } from './group-sender.ts';
import type { SideEffectPacer } from './pacing.ts';
import type { TurnStats } from './turn-outcome.ts';
import {
  confirmationNotice,
  spaceSends,
  type WakeFlags,
} from './wake-shared.ts';

export interface WakeExtendedDeps {
  config: ProjectedListenerConfig;
  tools: ReturnType<typeof createExtendedTools>;
  definitions: readonly ToolDefinition[];
  pacer: SideEffectPacer;
  moderation: () => Moderation;
  sender: GroupSender;
  /** 收藏表情工具产生的图片，在工具结果之后作为user图片消息追加。 */
  pendingImages: ChatContentPart[];
  stats: TurnStats;
  wake: WakeFlags;
  valid: () => boolean;
  onNotified: (entry: SentMessage) => void;
}

/** 一次wake内的扩展工具调用：同一提案只确认一次，并按结果更新发送与复核状态。 */
export class WakeExtended {
  private readonly proposals = new Map<string, JsonObject>();

  constructor(private readonly deps: WakeExtendedDeps) {}

  /** 执行一次扩展工具调用；返回undefined表示wake已失效。 */
  async execute(
    call: { function: { name: string; arguments: string } },
    args: unknown,
    context: TurnContext,
    signal: AbortSignal,
    imageContent: ChatContentPart[],
  ): Promise<JsonObject | undefined> {
    const { stats, wake, valid } = this.deps;
    let result: JsonObject;
    const outgoing =
      GROUP_MEDIA_TOOL_NAMES.includes(
        call.function.name as (typeof GROUP_MEDIA_TOOL_NAMES)[number],
      ) ||
      call.function.name === 'send_group_ai_voice' ||
      call.function.name === 'send_custom_face';
    if (
      outgoing &&
      this.deps.tools.has(call.function.name) &&
      wake.lastSendAt
    ) {
      await spaceSends(wake.lastSendAt, signal);
      if (!valid()) {
        return undefined;
      }
    }
    let proposalKey = JSON.stringify([
      call.function.name,
      call.function.arguments,
    ]);
    if (
      this.deps.config.tools.extended?.[
        call.function.name as ExtendedToolName
      ] === 'confirm'
    ) {
      try {
        const definition = this.deps.definitions.find(
          (tool) => tool.function.name === call.function.name,
        )!;
        const parsed = prepareExtendedConfirmation(
          call.function.name,
          args,
          definition,
          '目标待重新核验',
        ).args;
        const canonical = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(canonical)
            : isObject(value)
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, canonical(value[key])]),
                )
              : value;
        proposalKey = JSON.stringify([call.function.name, canonical(parsed)]);
      } catch {
        /* 非法提案会被确认适配器拒绝，不会派发。 */
      }
    }
    const previousProposal = this.proposals.get(proposalKey);
    if (
      !previousProposal &&
      this.deps.tools.has(call.function.name) &&
      this.deps.tools.isSideEffect(call.function.name)
    ) {
      await this.deps.pacer.take(signal);
      if (!valid()) {
        return undefined;
      }
    }
    result = previousProposal
      ? { ...structuredClone(previousProposal), cached: true }
      : await this.deps.tools.execute(
          call.function.name,
          args,
          context,
          signal,
        );
    imageContent.push(...this.deps.pendingImages.splice(0));
    if (result.status === 'confirmation_required' && !previousProposal) {
      const code = String(result.code);
      try {
        if (!valid()) {
          throw new Error('cancelled');
        }
        if (wake.lastSendAt) {
          await delay(
            Math.max(0, wake.lastSendAt + 450 - Date.now()),
            undefined,
            { signal: signal },
          );
        }
        const text = confirmationNotice(result, code);
        const entry = await this.deps.sender.sendPart(
          { segments: [{ type: 'text', data: { text } }], text },
          context,
          signal,
        );
        if (!valid()) {
          throw new Error('cancelled');
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
        wake.lastSendAt = Date.now();
      }
      this.proposals.set(proposalKey, structuredClone(result));
    }
    if (
      outgoing &&
      !result.cached &&
      !result.duplicate &&
      (result.status === 'executed' ||
        result.status === 'unknown' ||
        result.submitted === true)
    ) {
      wake.lastSendAt = Date.now();
    }
    // 即使取消与ACK同时到达，也保留已派发写操作的结果，据此标记需要复核。
    if (
      call.function.name === 'add_custom_face' &&
      (result.collection_submitted === true ||
        result.reconciled_previous_add === true) &&
      result.description_confirmed !== true
    ) {
      wake.customFaceNeedsReview = true;
      wake.managementNeedsReview = true;
    }
    if (this.deps.tools.isSideEffect(call.function.name)) {
      const confirmed =
        result.status === 'executed' || result.effect_confirmed === true;
      if (!result.cached && !result.duplicate) {
        if (outgoing) {
          if (confirmed) {
            stats.sentMessages++;
          } else if (result.status === 'ok' && result.submitted === true) {
            stats.sentSubmissions++;
          }
        } else {
          if (confirmed) {
            stats.managementExecuted++;
          } else if (result.status === 'ok' && result.submitted === true) {
            stats.managementSubmitted++;
          }
          if (result.status === 'unknown') {
            stats.managementUnknown++;
          }
        }
      }
      if (result.status === 'error' || result.status === 'unknown') {
        wake.managementNeedsReview = true;
      }
    }
    if (
      call.function.name === 'execute_javascript' &&
      isObject(result.tool_calls) &&
      Array.isArray(result.tool_calls.abnormal) &&
      result.tool_calls.abnormal.length
    ) {
      wake.managementNeedsReview = true;
    }
    return result;
  }
}
