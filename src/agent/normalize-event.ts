import { canonicalMessageId, id } from '../onebot/identity.ts';
import { resolveGroupId } from '../contracts/identity.ts';
import type { TimelineEntry } from '../contracts/messages.ts';
import { isObject } from '../contracts/json.ts';
import { imageReferences, imageMarker } from '../onebot/image-references.ts';
import {
  forwardReferences,
  forwardMarker,
} from '../onebot/forward-references.ts';
import { faceMarker } from '../tools/faces/tools.ts';
import { extractMessageContent } from '../world/message-content.ts';

/** 把OneBot群消息事件规范化为TimelineEntry；非本群、非本bot账号或bot自己发的消息返回undefined。 */
export function normalizeEvent(
  event: unknown,
  selfId: string,
  groupId: string,
): TimelineEntry | undefined {
  const expectedGroup = resolveGroupId(groupId);
  if (
    !isObject(event) ||
    event.post_type !== 'message' ||
    event.message_type !== 'group' ||
    id(event.group_id) !== expectedGroup ||
    id(event.self_id) !== selfId
  ) {
    return;
  }
  const userId = id(event.user_id);
  const msgId = canonicalMessageId(event.message_id);
  if (
    !userId ||
    userId.length > 32 ||
    msgId === undefined ||
    !Array.isArray(event.message) ||
    event.message.length > 128 ||
    userId === selfId
  ) {
    return;
  }
  let text = '';
  let replyTo: string | undefined;
  // 先扫描完整片段数组取引用：后续内容截断不能抹掉位于数组靠后位置的真实引用来源。
  for (const segment of event.message) {
    if (
      isObject(segment) &&
      segment.type === 'reply' &&
      isObject(segment.data)
    ) {
      replyTo = canonicalMessageId(segment.data.id);
    }
  }
  const images = imageReferences(msgId, event.message);
  const forwards = forwardReferences(msgId, event.message);
  for (const [index, segment] of event.message.entries()) {
    if (!isObject(segment) || !isObject(segment.data)) {
      continue;
    }
    if (segment.type === 'text' && typeof segment.data.text === 'string') {
      text += segment.data.text;
    } else if (segment.type === 'at') {
      text += `[at:${id(segment.data.qq) || 'unknown'}]`;
    } else if (segment.type === 'reply') {
      continue;
    } else if (segment.type === 'image') {
      const ref = images.find((image) => image.index === index);
      text += ref ? imageMarker(ref) : '[图片：超出单消息附件数量限制]';
    } else if (segment.type === 'face') {
      text += faceMarker(segment.data.id);
    } else if (forwards.some((ref) => ref.index === index)) {
      text += forwardMarker(forwards.find((ref) => ref.index === index)!);
    } else if (segment.type === 'forward') {
      text += '[合并转发：本消息可读取引用上限或格式不支持]';
    } else {
      text += '[非文本消息]';
    }
    if (text.length > 4000) {
      text = text.slice(0, 4000) + '…';
      break;
    }
  }
  const sender = isObject(event.sender) ? event.sender : {};
  const nickname =
    typeof sender.card === 'string' && sender.card
      ? sender.card
      : typeof sender.nickname === 'string'
        ? sender.nickname
        : userId;
  const time =
    typeof event.time === 'number' && Number.isFinite(event.time)
      ? Math.floor(event.time)
      : Math.floor(Date.now() / 1000);
  return {
    messageId: msgId,
    userId,
    nickname: nickname.slice(0, 80),
    text,
    time,
    ...extractMessageContent(msgId, event.message, images, forwards),
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(images.length ? { images } : {}),
    ...(forwards.length ? { forwards } : {}),
  };
}
