import type { JsonObject } from '../contracts/json.ts';
import type { TurnContext } from '../contracts/tools.ts';
import {
  DuplicateMessageAckError,
  writeFailure,
} from '../onebot/operation-result.ts';
import type { PreparedMessage } from '../tools/messaging/tools.ts';
import type { GroupSender, SentMessage } from './group-sender.ts';
import type { SideEffectPacer } from './pacing.ts';
import type { TurnStats } from './turn-outcome.ts';
import { spaceSends, type WakeFlags } from './wake-shared.ts';

export interface WakeSendDeps {
  pacer: SideEffectPacer;
  sender: GroupSender;
  stats: TurnStats;
  wake: WakeFlags;
  valid: () => boolean;
  /** 发送已被ACK且wake仍有效。 */
  onSent: (entry: SentMessage) => void;
}

/** 一次wake内的send_message：相同内容在结果未知后不再重发。 */
export class WakeSend {
  private readonly results = new Map<string, JsonObject>();

  constructor(private readonly deps: WakeSendDeps) {}

  /** 返回undefined表示wake已失效。 */
  async send(
    prepared: PreparedMessage,
    context: TurnContext,
    signal: AbortSignal,
  ): Promise<JsonObject | undefined> {
    const { stats, wake, valid } = this.deps;
    let result: JsonObject;
    const key = JSON.stringify(prepared);
    const cached = this.results.get(key);
    if (cached) {
      result = { ...cached, duplicate: true };
    } else {
      if (wake.lastSendAt) {
        await spaceSends(wake.lastSendAt, signal);
      }
      if (!valid()) {
        return undefined;
      }
      await this.deps.pacer.take(signal);
      if (!valid()) {
        return undefined;
      }
      wake.sending = true;
      try {
        const entry = await this.deps.sender.sendPart(
          prepared,
          context,
          signal,
        );
        if (valid()) {
          this.deps.onSent(entry);
        }
        stats.sentMessages++;
        result = {
          status: 'ok',
          effect_confirmed: true,
          message_id: entry.messageId,
          ...(!valid() || entry.cancelled_after_dispatch
            ? { cancelled_after_dispatch: true }
            : {}),
          ...(entry.local_projection_failed
            ? { local_projection_failed: true }
            : {}),
        };
      } catch (error) {
        result = writeFailure(
          error,
          error instanceof DuplicateMessageAckError
            ? 'duplicate_message_ack'
            : 'delivery_unknown',
        );
      } finally {
        wake.sending = false;
        wake.lastSendAt = Date.now();
      }
      if (result.status === 'unknown') {
        this.results.set(key, structuredClone(result));
      }
    }
    if (result.status === 'error' || result.status === 'unknown') {
      wake.managementNeedsReview = true;
    }
    return result;
  }
}
