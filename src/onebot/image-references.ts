import { canonicalMessageId } from './identity.ts';
import type { ImageReference } from '../contracts/messages.ts';
import { isObject } from '../contracts/json.ts';

const ID_PATTERN = '^img_(-?\\d{1,32})_(0|[1-9]\\d?|1[01]\\d|12[0-7])$';
const imageId = new RegExp(ID_PATTERN);

function parseId(
  value: unknown,
): { id: string; messageId: string; index: number } | undefined {
  if (typeof value !== 'string' || value.trim() !== value) {
    return;
  }
  const match = imageId.exec(value);
  if (match) {
    return { id: value, messageId: match[1]!, index: Number(match[2]) };
  }
}

function identifier(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v)) {
    v = String(v);
  }
  if (typeof v === 'string' && v.trim() === v && /^[1-9]\d{0,31}$/.test(v)) {
    return v;
  }
}

/** 只保存稳定引用（消息ID加段序号），绝不保存传输URL或QQ文件token。 */
export function imageReferences(
  messageId: string,
  segments: unknown,
): ImageReference[] {
  if (
    typeof messageId !== 'string' ||
    canonicalMessageId(messageId) !== messageId ||
    !Array.isArray(segments)
  ) {
    return [];
  }
  const refs: ImageReference[] = [];
  for (let index = 0; index < Math.min(segments.length, 128); index++) {
    const segment: unknown = segments[index];
    if (isObject(segment) && segment.type === 'image') {
      refs.push({ id: `img_${messageId}_${index}`, index });
    }
  }
  return refs;
}

export function imageMarker(ref: ImageReference): string {
  return parseId(ref.id) ? `[图片 id=${ref.id}：未分析]` : '[图片：未分析]';
}

export { ID_PATTERN, parseId, identifier };
