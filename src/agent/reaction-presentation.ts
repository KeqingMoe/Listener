import { type JsonObject, isObject } from '../contracts/json.ts';

/** 把reaction观测结果作为只读标注附加到read_message结果上，受字符预算限制，不改动原始记录。 */

export type ReactionLookup = (messageId: string) => JsonObject | undefined;

const SNAPSHOT_LIMIT = 1000,
  ITEM_LIMIT = 8;
const statuses = new Set(['observed', 'stale', 'partial', 'empty_snapshot']);

function encoded(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function id(message: unknown): string | undefined {
  return isObject(message) &&
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
    !isObject(value) ||
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
      !isObject(entry) ||
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
  if (!messageId || !isObject(message) || Object.hasOwn(message, 'reactions')) {
    return undefined;
  }
  try {
    return snapshot(lookup(messageId));
  } catch {
    return undefined;
  }
}

/** 调用方只对成功且限定在本群范围内的read_message结果调用。 */
export function annotateReactionReadResult(
  result: JsonObject,
  lookup: ReactionLookup,
): JsonObject {
  const copy = structuredClone(result);
  if (copy.status !== 'ok' || !isObject(copy.message)) {
    return copy;
  }
  const info = observation(copy.message, lookup);
  if (info) {
    copy.message.reactions = info;
  }
  return copy;
}
