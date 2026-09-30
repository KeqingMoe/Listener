import type { Api } from '../contracts/onebot.ts';
import type { Memory, TimelineEntry } from '../contracts/messages.ts';
import type { TurnContext } from '../contracts/tools.ts';
import { isObject } from '../contracts/json.ts';
import { canonicalMessageId, id } from '../onebot/identity.ts';
import { OneBotError } from '../onebot/client.ts';
import {
  DuplicateMessageAckError,
  UnverifiedMessageAckError,
  writeFailure,
} from '../onebot/operation-result.ts';
import type { PreparedMessage } from '../tools/messaging/tools.ts';
import type { SendReceiptSnapshot } from '../tools/media/tools.ts';
import type { Reminder, DeliveryOutcome } from '../reminders/store.ts';
import type { WorldEventStore } from '../world/events.ts';
import { recordToolMessage } from '../world/ingest.ts';
import { extractMessageContent } from '../world/message-content.ts';
import { log } from '../observability/logger.ts';

export type SentMessage = TimelineEntry & {
  cancelled_after_dispatch?: boolean;
  local_projection_failed?: boolean;
};

export interface GroupSenderDeps {
  api: Api;
  groupId: string;
  botName?: string;
  world?: WorldEventStore;
  memory: () => Memory | undefined;
  generation: () => number;
  /** 仍连接且未停止。 */
  live: () => boolean;
  remindersEnabled: () => boolean;
}

/**
 * 本群唯一的发送通道：所有消息串行派发，校验并登记每个ACK，
 * 再把自身消息投影到world与聊天记录。
 */
export class GroupSender {
  constructor(private readonly deps: GroupSenderDeps) {}

  // 在reset和断线后仍保留；更早的Listener实例的记录由world持久化覆盖。
  private readonly claimedMessageAcks = new Set<string>();
  captureSendReceipt(): SendReceiptSnapshot {
    const worldHighWater = this.deps.world?.getState().latestSequence;
    let memoryIds: ReadonlySet<string>;
    try {
      memoryIds = new Set(
        this.deps
          .memory()
          ?.recent()
          .map((entry) => entry.messageId) ?? [],
      );
    } catch (error) {
      // 基于world的会话可能有意禁止读取memory快照，
      // 此时以持久化的world水位作为发送前历史的权威依据。
      if (worldHighWater === undefined) {
        throw error;
      }
      memoryIds = new Set();
    }
    return {
      ...(worldHighWater !== undefined ? { worldHighWater } : {}),
      memoryIds,
    };
  }

  claimMessageAck(entry: TimelineEntry, receipt?: SendReceiptSnapshot): void {
    try {
      const id = entry.messageId;
      const world = this.deps.world;
      const known = world?.findMessage(id);
      const remembered = this.deps.memory()?.find(id);
      // 只有在本次派发之后观察到、且内容匹配的自身回显才允许先于ACK出现。
      if (
        !receipt ||
        this.claimedMessageAcks.has(id) ||
        receipt.memoryIds.has(id) ||
        (known &&
          (known.userId !== entry.userId ||
            receipt.worldHighWater === undefined ||
            world!.findMessage(id, receipt.worldHighWater))) ||
        (remembered && remembered.userId !== entry.userId)
      ) {
        throw new DuplicateMessageAckError();
      }
      // 在任何投影之前先登记：即使追加失败，这个ACK也不能被再次使用。
      this.claimedMessageAcks.add(id);
      if (this.claimedMessageAcks.size > 65536) {
        this.claimedMessageAcks.delete(
          this.claimedMessageAcks.values().next().value!,
        );
      }
    } catch (error) {
      if (error instanceof DuplicateMessageAckError) {
        throw error;
      }
      throw new UnverifiedMessageAckError();
    }
  }

  private sendQueue: Promise<void> = Promise.resolve();
  async sendReminder(
    reminder: Reminder,
    claim: () => boolean,
  ): Promise<DeliveryOutcome> {
    const run = this.sendQueue.then(async (): Promise<DeliveryOutcome> => {
      if (
        !this.deps.live() ||
        reminder.groupId !== this.deps.groupId ||
        !this.deps.remindersEnabled()
      ) {
        throw new Error('reminder_unavailable');
      }
      const login = await this.deps.api.call('get_login_info', {});
      if (
        !isObject(login) ||
        id(login.user_id) !== reminder.selfId ||
        !this.deps.live()
      ) {
        throw new Error('reminder_unavailable');
      }
      if (!claim()) {
        throw new Error('reminder_not_pending');
      }
      const late = Date.now() - reminder.dueAt > 60_000;
      const text = `${late ? `【延后提醒，原定 ${new Date(reminder.dueAt).toLocaleString('zh-CN', { timeZone: reminder.timeZone })} ${reminder.timeZone}】\n` : '【提醒】\n'}${reminder.text}`;
      try {
        const entry = await this.dispatchMessage(
          { text, segments: [{ type: 'text', data: { text } }] },
          {
            groupId: this.deps.groupId,
            selfId: reminder.selfId,
            actorId: reminder.creatorId,
            messageId: reminder.sourceMessageId,
          },
        );
        return { state: 'sent', messageId: entry.messageId };
      } catch (error) {
        return writeFailure(error).status === 'error'
          ? { state: 'failed', reason: 'delivery_failed' }
          : { state: 'unknown', reason: 'dispatch_unknown' };
      }
    });
    this.sendQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async sendPart(
    part: PreparedMessage,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<SentMessage> {
    const generation = this.deps.generation();
    const run = this.sendQueue.then(async () => {
      if (signal?.aborted || generation !== this.deps.generation()) {
        throw new Error('cancelled');
      }
      return this.dispatchMessage(part, context, signal);
    });
    this.sendQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private async dispatchMessage(
    part: PreparedMessage,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<SentMessage> {
    if (!this.deps.live() || context.groupId !== this.deps.groupId) {
      throw new Error('cancelled');
    }
    const { text, replyTo } = part;
    const generation = this.deps.generation();
    const message: unknown[] = [];
    if (replyTo !== undefined) {
      message.push({ type: 'reply', data: { id: replyTo } });
    }
    message.push(...part.segments);
    const started = Date.now();
    log('info', 'send.start', {
      bytes: Buffer.byteLength(JSON.stringify(message)),
      reply_to: replyTo,
    });
    let result: unknown;
    const receipt = this.captureSendReceipt();
    try {
      result = await this.deps.api.call('send_group_msg', {
        group_id: this.deps.groupId,
        message,
      });
    } catch (error) {
      log('warn', 'send.failed', {
        reason: error instanceof OneBotError ? error.code : 'api_failed',
        outcome:
          writeFailure(error).status === 'error'
            ? 'rejected'
            : 'delivery_unknown',
        duration_ms: Date.now() - started,
      });
      throw error;
    }
    const msgId = isObject(result)
      ? canonicalMessageId(result.message_id)
      : undefined;
    log('info', 'send.complete', {
      message_id: msgId,
      duration_ms: Date.now() - started,
    });
    if (msgId === undefined || msgId.length > 33) {
      throw new Error('delivery_unknown');
    }
    const entry = {
      messageId: msgId,
      userId: context.selfId,
      nickname: this.deps.botName ?? 'Listener',
      text,
      ...extractMessageContent(msgId, message),
      time: Math.floor(Date.now() / 1000),
      bot: true,
      ...(replyTo !== undefined ? { replyTo } : {}),
    };
    const stale =
      signal?.aborted ||
      generation !== this.deps.generation() ||
      !this.deps.live();
    // 重复的消息ID不能证明发生了新的发送。真正的新ACK不会因取消或本地投影失败而撤销，
    // 也不能让已清空的对话记忆重新出现。
    this.claimMessageAck(entry, receipt);
    let projectionFailed = false;
    try {
      if (this.deps.world) {
        recordToolMessage(this.deps.world, entry);
      }
      if (!stale && !this.deps.memory()?.find(entry.messageId)) {
        this.deps.memory()?.append(entry);
      }
    } catch {
      projectionFailed = true;
      log('warn', 'send.projection_failed', {
        reason: 'local_projection_failed',
      });
    }
    return {
      ...entry,
      ...(stale ? { cancelled_after_dispatch: true } : {}),
      ...(projectionFailed ? { local_projection_failed: true } : {}),
    };
  }
}
