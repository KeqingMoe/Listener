import type { JsonObject } from '../contracts/json.ts';
import type { Memory } from '../contracts/messages.ts';

/** 把reaction观测结果作为只读标注附加到模型可见的消息投影上，受字符预算限制，不改动原始记录。 */

export type ReactionLookup = (messageId: string) => JsonObject | undefined;

const ADDED_LIMIT = 6000,
  SNAPSHOT_LIMIT = 1000,
  BATCH_LIMIT = 24000,
  ITEM_LIMIT = 8;
const statuses = new Set(['observed', 'stale', 'partial', 'empty_snapshot']);

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function encoded(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function id(message: unknown): string | undefined {
  return object(message) &&
    typeof message.messageId === 'string' &&
    message.messageId.length > 0
    ? message.messageId
    : undefined;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  return Array.from(value.slice(0, max * 2))
    .slice(0, max)
    .join('');
}

/** 只投影观测字段：这些计数不代表bot自己参与过reaction。 */
function snapshot(value: unknown): JsonObject | undefined {
  if (
    !object(value) ||
    typeof value.status !== 'string' ||
    !statuses.has(value.status) ||
    typeof value.observed_at !== 'number' ||
    !Number.isFinite(value.observed_at) ||
    value.observed_at < 0 ||
    !Array.isArray(value.items)
  ) {
    return undefined;
  }
  const items: JsonObject[] = [];
  for (const entry of value.items.slice(0, ITEM_LIMIT)) {
    if (
      !object(entry) ||
      typeof entry.emoji_id !== 'string' ||
      !/^\d{1,32}$/.test(entry.emoji_id) ||
      typeof entry.count !== 'number' ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 0
    ) {
      continue;
    }
    const kind =
      typeof entry.emoji_type === 'number' &&
      Number.isSafeInteger(entry.emoji_type)
        ? String(entry.emoji_type)
        : entry.emoji_type;
    if (typeof kind !== 'string' || !/^\d{1,16}$/.test(kind)) {
      continue;
    }
    const name = boundedText(entry.name, 64),
      emoji = boundedText(entry.emoji, 16);
    items.push({
      emoji_id: entry.emoji_id,
      emoji_type: kind,
      ...(name ? { name } : {}),
      ...(emoji ? { emoji } : {}),
      count: entry.count,
    });
  }
  let omitted =
    typeof value.omitted === 'number' &&
    Number.isSafeInteger(value.omitted) &&
    value.omitted > 0
      ? value.omitted
      : 0;
  omitted = Math.min(
    Number.MAX_SAFE_INTEGER,
    omitted + value.items.length - items.length,
  );
  const result: JsonObject = {
    status: value.status,
    observed_at: value.observed_at,
    items,
  };
  const markOmitted = () => {
    if (omitted) {
      result.omitted = omitted;
      if (result.status !== 'stale') {
        result.status = 'partial';
      }
    }
  };
  markOmitted();
  while (
    (encoded({ reactions: result })?.length ?? Infinity) + 1 >
    SNAPSHOT_LIMIT
  ) {
    if (!items.length) {
      return undefined;
    }
    items.pop();
    omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
    markOmitted();
  }
  return result;
}

function observation(
  message: unknown,
  lookup: ReactionLookup,
): JsonObject | undefined {
  const messageId = id(message);
  if (!messageId || !object(message) || Object.hasOwn(message, 'reactions')) {
    return undefined;
  }
  try {
    return snapshot(lookup(messageId));
  } catch {
    return undefined;
  }
}

function candidates(
  messages: unknown[],
  lookup: ReactionLookup,
): Array<{ message: JsonObject; info: JsonObject; index: number }> {
  const result: Array<{
    message: JsonObject;
    info: JsonObject;
    index: number;
  }> = [];
  messages.forEach((message, index) => {
    if (!object(message)) {
      return;
    }
    const info = observation(message, lookup);
    if (info) {
      result.push({ message, info, index });
    }
  });
  // 有限的标注空间优先给有实际reaction的消息，其次是空快照，同类中优先较新的消息。
  // 只排序候选列表，不改变对话本身的顺序。
  return result.sort(
    (a, b) =>
      Number((b.info.items as unknown[]).length > 0) -
        Number((a.info.items as unknown[]).length > 0) || b.index - a.index,
  );
}

/** 只修改新克隆或新解析出的副本，绝不修改Memory中的条目。超出预算的标注会被撤回。 */
function decorate(
  root: unknown,
  messages: unknown[],
  lookup: ReactionLookup,
  maximum: number,
): boolean {
  const initial = encoded(root);
  if (initial === undefined || initial.length >= maximum) {
    return false;
  }
  const limit = Math.min(maximum, initial.length + ADDED_LIMIT);
  let changed = false;
  for (const { message, info } of candidates(messages, lookup)) {
    message.reactions = info;
    const current = encoded(root);
    if (current === undefined || current.length > limit) {
      delete message.reactions;
    } else {
      changed = true;
    }
  }
  return changed;
}

/** 保留全部原始消息文本和来源信息；输入本身已超预算时不做标注，也不裁剪原文。 */
export function annotateReactionBatch(
  payload: JsonObject,
  lookup: ReactionLookup,
): JsonObject {
  const copy = structuredClone(payload);
  if (
    object(copy.current_batch) &&
    Array.isArray(copy.current_batch.messages)
  ) {
    decorate(copy, copy.current_batch.messages, lookup, BATCH_LIMIT);
  }
  return copy;
}

/** 仅用于展示的投影；摘要仍以原始context为输入。 */
export function annotateReactionContext(
  memory: Memory,
  lookup: ReactionLookup,
): string {
  const source = memory.context();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    /* 纯文本context无法按文本匹配改写，改为在末尾追加观测记录。 */
  }
  const messages = Array.isArray(parsed)
    ? parsed
    : object(parsed) && Array.isArray(parsed.messages)
      ? parsed.messages
      : undefined;
  if (messages) {
    return decorate(parsed, messages, lookup, source.length + ADDED_LIMIT)
      ? JSON.stringify(parsed)
      : source;
  }
  const observations: JsonObject[] = [],
    seen = new Set<string>();
  let trailer = '';
  const entries = memory.recent().filter((entry) => {
    const messageId = id(entry);
    if (!messageId || seen.has(messageId)) {
      return false;
    }
    seen.add(messageId);
    return true;
  });
  for (const { message, info } of candidates(entries, lookup)) {
    const messageId = id(message)!;
    observations.push({ message_id: messageId, reactions: info });
    const next = JSON.stringify({ reaction_observations: observations });
    if (next.length + 1 > ADDED_LIMIT) {
      observations.pop();
      continue;
    }
    trailer = next;
  }
  return trailer ? `${source}\n${trailer}` : source;
}

/** 调用方只对成功且限定在本群范围内的read_message结果调用。 */
export function annotateReactionReadResult(
  result: JsonObject,
  lookup: ReactionLookup,
): JsonObject {
  const copy = structuredClone(result);
  if (copy.status !== 'ok' || !object(copy.message)) {
    return copy;
  }
  const info = observation(copy.message, lookup);
  if (info) {
    copy.message.reactions = info;
  }
  return copy;
}
