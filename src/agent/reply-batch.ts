import { resolveOwnerId } from '../contracts/identity.ts';
import { type JsonObject } from '../contracts/json.ts';
import { type Memory, type TimelineEntry } from '../contracts/messages.ts';
import { type TurnContext } from '../contracts/tools.ts';
import { newTraceId } from '../observability/logger.ts';
import type { AttentionHit } from './attention.ts';
import { projectMessage } from '../world/message-content.ts';

export interface BatchItem {
  entry: TimelineEntry;
  context: TurnContext;
  sequence: number;
  received: number;
  trigger?: 'mention' | 'quote';
  unverifiedQuote?: boolean;
}

const MAX_ITEMS = 64;
const MAX_PAYLOAD = 24_000;
const copy = <T>(value: T): T => structuredClone(value);

/**
 * 一个turn待处理的消息批次，只负责按到达顺序保存和有界保留。调度、随机抽取和日志
 * 由Listener负责。满64条时优先淘汰普通消息，保留触发消息（@或引用）。
 */
export class ReplyBatch {
  readonly turnId = newTraceId();
  items: BatchItem[] = [];
  openedAt: number;
  readyAt: number;
  randomSelected: boolean;
  readonly attentionHits: AttentionHit[] = [];
  omittedAttentionHits = 0;
  addAttention(hits: readonly AttentionHit[]): void {
    for (const hit of hits) {
      if (
        this.attentionHits.some((previous) => previous.plan_id === hit.plan_id)
      ) {
        continue;
      }
      if (this.attentionHits.length >= 64) {
        this.omittedAttentionHits++;
        continue;
      }
      this.attentionHits.push(copy(hit));
    }
  }

  omittedMessages = 0;
  omittedDirect = 0;
  hasNonOwnerDirect = false;
  hasUnverifiedQuote = false;
  private readonly seen = new Set<string>();
  private firstDirectSequence = Infinity;

  private readonly ownerId: string;
  constructor(
    item: BatchItem,
    delayMs: number,
    randomSelected = false,
    ownerId: string,
  ) {
    this.ownerId = resolveOwnerId(ownerId);
    this.openedAt = item.received;
    this.readyAt = item.received + delayMs;
    this.randomSelected = randomSelected;
    this.add(item, delayMs);
  }

  add(item: BatchItem, delayMs: number): void {
    if (item.trigger && item.entry.userId !== this.ownerId) {
      this.hasNonOwnerDirect = true;
    }
    if (item.unverifiedQuote) {
      this.hasUnverifiedQuote = true;
    }
    if (
      this.seen.has(item.entry.messageId) ||
      this.items.some(
        (existing) => existing.entry.messageId === item.entry.messageId,
      )
    ) {
      return;
    }
    this.seen.add(item.entry.messageId);
    // 传输层去重由Listener的memory负责，这里只保留有界的本地FIFO。
    if (this.seen.size > 256) {
      this.seen.delete(this.seen.values().next().value!);
    }
    this.openedAt = Math.min(this.openedAt, item.received);
    if (item.trigger && item.sequence < this.firstDirectSequence) {
      this.readyAt =
        this.firstDirectSequence === Infinity
          ? item.received + delayMs
          : Math.min(this.readyAt, item.received + delayMs);
      this.firstDirectSequence = item.sequence;
    }
    if (this.items.length === MAX_ITEMS) {
      const ordinary = this.items.findIndex((existing) => !existing.trigger);
      this.omittedMessages++;
      if (ordinary < 0) {
        if (!item.trigger) {
          return;
        }
        this.omittedDirect++;
        // 引用查询较慢时，先到达的消息可能后加入批次。
        // 按到达序号保留最早的消息，而不是最先完成查询的消息。
        if (item.sequence >= this.items[this.items.length - 1]!.sequence) {
          return;
        }
        this.items.pop();
      } else {
        if (!item.trigger && item.sequence <= this.items[ordinary]!.sequence) {
          return;
        }
        this.items.splice(ordinary, 1);
      }
    }
    this.items.push(copy(item));
    this.items.sort((a, b) => a.sequence - b.sequence);
  }

  get direct(): BatchItem[] {
    return this.items.filter((item) => item.trigger);
  }

  get kind(): 'direct' | 'attention' | 'random' {
    return this.direct.length
      ? 'direct'
      : this.attentionHits.length
        ? 'attention'
        : 'random';
  }

  get primary(): BatchItem {
    return this.direct[0] ?? this.items[this.items.length - 1]!;
  }

  payload(): JsonObject {
    const trusted = this.direct.map(({ entry, trigger }) => ({
      message_id: entry.messageId,
      user_id: entry.userId,
      trigger,
    }));
    const render = (
      limit: number,
      names: boolean,
      compactMetadata = false,
    ): JsonObject => {
      const truncated: string[] = [];
      const messages = this.items.map(({ entry }) => {
        const message = projectMessage(entry, limit);
        // 带类型的媒体片段已包含引用，不再重复输出根级列表。
        delete message.images;
        delete message.forwards;
        if (names) {
          message.nickname = entry.nickname
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
            .slice(0, 24);
        } else {
          delete message.nickname;
        }
        if (message.content_truncated || message.text_truncated) {
          truncated.push(entry.messageId);
        }
        return message;
      });
      return {
        current_batch: {
          messages,
          omitted_messages: this.omittedMessages,
          omitted_direct: this.omittedDirect,
          unverified_references: this.hasUnverifiedQuote,
          ...(compactMetadata
            ? {
                truncated_messages: truncated.length,
                truncated_ids_omitted: truncated.length,
              }
            : { truncated_message_ids: truncated }),
          ...(truncated.length
            ? {
                reason: Number.isFinite(limit)
                  ? 'payload_character_limit'
                  : 'source_content_incomplete',
              }
            : {}),
        },
        trusted_direct_requests: trusted,
        trigger_kind: this.kind,
      };
    };
    const full = render(Infinity, true);
    if (JSON.stringify(full).length <= MAX_PAYLOAD) {
      return full;
    }
    // 超出预算时先舍弃昵称和重复的附件元数据；消息来源和呼唤者信息不可舍弃。
    const withoutNames = render(Infinity, false);
    if (JSON.stringify(withoutNames).length <= MAX_PAYLOAD) {
      return withoutNames;
    }
    let low = 0;
    let high = Math.max(
      16000,
      ...this.items.map((item) => JSON.stringify(item.entry.text).length),
    );
    let compactMetadata = false;
    let best = render(0, false);
    if (JSON.stringify(best).length > MAX_PAYLOAD) {
      // 每条消息的截断标记旁已有相同ID，只丢弃这份重复名单，
      // 绝不丢弃消息、呼唤者或引用的来源信息。
      compactMetadata = true;
      best = render(0, false, true);
    }
    if (JSON.stringify(best).length > MAX_PAYLOAD) {
      // 合法OneBot ID最多32位，即使64条都是呼唤也放得下，走到这里说明数据异常。
      throw new RangeError('Reply batch provenance exceeds payload limit');
    }
    // 二分查找统一的单条正文上限，让长消息平分空间而不丢掉较早的呼唤者。
    // 以序列化后的JSON长度衡量，包含转义、框架、名单和截断标记。
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = render(middle, false, compactMetadata);
      if (JSON.stringify(candidate).length <= MAX_PAYLOAD) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }
}

/** 在await压缩之前同步截取只读快照；写入为空操作，之后也不会回读原memory。 */
export function snapshotMemory(
  memory: Memory,
  batchEntries: TimelineEntry[],
  excludeIds = new Set<string>(),
): Memory {
  const rawContext = memory.context();
  let context = rawContext;
  try {
    const parsed: unknown = JSON.parse(rawContext);
    const keep = (entry: unknown): boolean =>
      !entry ||
      typeof entry !== 'object' ||
      !('messageId' in entry) ||
      !excludeIds.has(String(entry.messageId));
    if (Array.isArray(parsed)) {
      context = JSON.stringify(parsed.filter(keep));
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      'messages' in parsed &&
      Array.isArray(parsed.messages)
    ) {
      parsed.messages = parsed.messages.filter(keep);
      context = JSON.stringify(parsed);
    }
  } catch {
    /* context可能是纯文本而非JSON，此时原样使用。 */
  }
  const entries = new Map<string, TimelineEntry>();
  for (const entry of memory.recent().slice(-300)) {
    if (!excludeIds.has(entry.messageId)) {
      entries.set(entry.messageId, copy(entry));
    }
  }
  // 可信的批次条目覆盖过时记录，也不受未解析ID排除列表影响。
  for (const entry of batchEntries.slice(0, MAX_ITEMS)) {
    entries.set(entry.messageId, copy(entry));
  }
  return {
    recent: () => copy([...entries.values()]),
    find: (id) => {
      const entry = entries.get(id);
      return entry ? copy(entry) : undefined;
    },
    context: () => context,
    append: () => false,
    compact: async () => {},
    clear: () => {},
    close: () => {},
  };
}
