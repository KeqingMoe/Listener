import { createHash } from 'node:crypto';
import { extractMessageContent } from './message-content.ts';
import { imageReferences } from '../onebot/image-references.ts';
import { forwardReferences } from '../onebot/forward-references.ts';
import type { TimelineEntry } from '../contracts/messages.ts';
import type {
  EventSource,
  WorldEventInput,
  WorldEventStore,
} from './events.ts';

const now = () => Date.now() / 1000;

function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** 在读取任何字段之前先拒绝访问器、循环引用和非JSON值，并限制节点数、深度与大小。原始事件包绝不持久化。 */
function boundedJson(value: unknown): boolean {
  let nodes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 12) {
      return false;
    }
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    ) {
      return true;
    }
    if (!v || typeof v !== 'object' || (!Array.isArray(v) && !object(v))) {
      return false;
    }
    return Reflect.ownKeys(v).every((key) => {
      if (Array.isArray(v) && key === 'length') {
        return true;
      }
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      return (
        typeof key === 'string' &&
        !!descriptor &&
        Object.hasOwn(descriptor, 'value') &&
        visit(descriptor.value, depth + 1)
      );
    });
  };
  try {
    return (
      visit(value, 0) &&
      Buffer.byteLength(JSON.stringify(value), 'utf8') <= 64 * 1024
    );
  } catch {
    return false;
  }
}

function id(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return;
    }
    value = String(value);
  }
  return typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value)
    ? value
    : undefined;
}

function messageId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      return;
    }
    value = String(value);
  }
  return typeof value === 'string' && /^(0|-?[1-9][0-9]{0,31})$/.test(value)
    ? value
    : undefined;
}

function metadataName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) {
    return;
  }
  // 显示名是不可信元数据，其中的URL一律遮蔽，绝不当作传输地址或访问凭据。
  const name = value
    .replace(/(?:https?:\/\/|file:\/\/|data:)\S*/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 256)
    .replace(/[\uD800-\uDBFF]$/, '');
  return name || undefined;
}

const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function timestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 9_999_999_999
  );
}

function eventIdentity(
  event: Record<string, unknown>,
  groupId: string,
  type: string,
): { dedupKey?: string } {
  // 没有provider提供的事件ID时，同一秒内完全相同的戳一戳/回应也可能是不同动作，
  // 此时不能用时间戳或内容拼出去重键。
  const identity = event.event_id;
  if (
    typeof identity !== 'string' ||
    !identity ||
    identity.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(identity)
  ) {
    return {};
  }
  return {
    dedupKey: `notice:${createHash('sha256')
      .update(JSON.stringify([groupId, type, identity]))
      .digest('hex')}`,
  };
}

function normalizeMessage(
  event: Record<string, unknown>,
  groupId: string,
  source: EventSource,
  observedAt: number,
  selfId: string,
): WorldEventInput | undefined {
  const msgId = messageId(event.message_id),
    userId = id(event.user_id),
    wire = event.message;
  if (
    msgId === undefined ||
    !userId ||
    (!Array.isArray(wire) && typeof wire !== 'string') ||
    (Array.isArray(wire) && wire.length > 128)
  ) {
    return;
  }
  const sender = object(event.sender) ? event.sender : {};
  if (sender.user_id !== undefined && id(sender.user_id) !== userId) {
    return;
  }
  const nickname =
    typeof sender.card === 'string' && sender.card
      ? sender.card
      : typeof sender.nickname === 'string' && sender.nickname
        ? sender.nickname
        : userId;
  const images = imageReferences(msgId, wire),
    forwards = forwardReferences(msgId, wire);
  const content = extractMessageContent(msgId, wire, images, forwards);
  // 仅作可读的回退文本，以结构化content为准。字符串或形似CQ码的内容绝不解析为操作；
  // 上游raw_message和任意元数据都不保留。
  const text = content.segments
    .map((segment) => {
      if (segment.type === 'text') {
        return segment.text;
      }
      if (segment.type === 'face') {
        return `[face:${segment.id}]`;
      }
      if (segment.type === 'at') {
        return `[at:${segment.user_id}]`;
      }
      if (segment.type === 'reply') {
        return '';
      }
      return `[${segment.type}]`;
    })
    .join('')
    .slice(0, 16_384);
  const replyTo = content.segments.findLast(
    (segment) => segment.type === 'reply',
  );
  const entry: TimelineEntry = {
    messageId: msgId,
    userId,
    nickname: nickname.slice(0, 256),
    text,
    time: timestamp(event.time) ? event.time : observedAt,
    ...content,
    ...(replyTo?.type === 'reply' ? { replyTo: replyTo.message_id } : {}),
    ...(images.length ? { images } : {}),
    ...(forwards.length ? { forwards } : {}),
    ...(userId === selfId ? { bot: true } : {}),
  };
  return {
    type: 'message.created',
    groupId,
    observedAt,
    ...(timestamp(event.time) ? { occurredAt: event.time } : {}),
    actorId: userId,
    subject: { kind: 'message', id: msgId },
    payload: { kind: 'message', message: entry },
    provenance: { source, verified: source !== 'migration' },
    dedupKey: `message:${msgId}`,
  };
}

/**
 * 按群范围做结构规范化，不做权限校验；调用方存储前仍需套用配置的群白名单。
 * 未知事件和私聊事件直接忽略，绝不猜测。
 */
export function normalizeOneBotEvent(
  event: unknown,
  selfId: string,
  source: EventSource = 'onebot',
  observedAt = now(),
): WorldEventInput | undefined {
  if (
    !boundedJson(event) ||
    !object(event) ||
    !id(selfId) ||
    !timestamp(observedAt) ||
    !['onebot', 'tool', 'migration'].includes(source)
  ) {
    return;
  }
  const groupId = id(event.group_id);
  if (
    !groupId ||
    event.message_type === 'private' ||
    (event.self_id !== undefined && id(event.self_id) !== selfId)
  ) {
    return;
  }
  if (event.time !== undefined && !timestamp(event.time)) {
    return;
  }
  if (event.post_type === 'message' && event.message_type === 'group') {
    return normalizeMessage(event, groupId, source, observedAt, selfId);
  }
  if (event.post_type !== 'notice') {
    return;
  }
  const base = {
    groupId,
    observedAt,
    ...(timestamp(event.time) ? { occurredAt: event.time } : {}),
    provenance: { source, verified: false },
  };
  if (event.notice_type === 'group_recall') {
    const msgId = messageId(event.message_id);
    if (msgId === undefined) {
      return;
    }
    // user_id是消息作者，不一定是撤回者；撤回者只取operator_id。
    const operator = id(event.operator_id);
    if (event.operator_id !== undefined && !operator) {
      return;
    }
    return {
      ...base,
      type: 'message.recalled',
      ...(operator ? { actorId: operator } : {}),
      subject: { kind: 'message', id: msgId },
      payload: {
        kind: 'message_recalled',
        message_id: msgId,
        ...(operator ? { recalled_by: operator } : {}),
      },
      dedupKey: `recall:${msgId}`,
    };
  }
  if (event.notice_type === 'group_msg_emoji_like') {
    const msgId = messageId(event.message_id);
    if (msgId === undefined) {
      return;
    }
    // NapCat的这类通知可能只是脏提示：不能把user_id/likes.count/is_add当作操作者、动作或准确计数。
    // 当前聚合值另行查询。
    return {
      ...base,
      type: 'reaction.changed',
      subject: { kind: 'message', id: msgId },
      payload: { kind: 'reaction', message_id: msgId },
      ...eventIdentity(event, groupId, 'reaction.changed'),
    };
  }
  if (event.notice_type === 'notify' && event.sub_type === 'poke') {
    const actor = id(event.user_id),
      target = id(event.target_id);
    if (!actor || !target) {
      return;
    }
    return {
      ...base,
      type: 'poke.created',
      actorId: actor,
      subject: { kind: 'member', id: target },
      payload: { kind: 'poke', user_id: target },
      ...eventIdentity(event, groupId, 'poke.created'),
    };
  }
  // 字段对应NapCat的OB11Group{Increase,Decrease,Ban,UploadNotice,Name}Event类。
  // 不合成通知ID，也不推断操作者或动作。
  if (
    event.notice_type === 'group_increase' ||
    event.notice_type === 'group_decrease' ||
    event.notice_type === 'group_ban'
  ) {
    const operator = id(event.operator_id);
    if (
      event.operator_id !== undefined &&
      event.operator_id !== 0 &&
      event.operator_id !== '0' &&
      !operator
    ) {
      return;
    }
    const operatorFields = operator ? { operator_id: operator } : {};
    const actorFields = operator ? { actorId: operator } : {};
    if (event.notice_type === 'group_ban') {
      const target =
        event.user_id === 0 || event.user_id === '0' ? '0' : id(event.user_id);
      if (
        !target ||
        (event.sub_type !== 'ban' && event.sub_type !== 'lift_ban') ||
        !natural(event.duration)
      ) {
        return;
      }
      return {
        ...base,
        type: 'group.ban_changed',
        ...actorFields,
        subject: {
          kind: target === '0' ? 'group' : 'member',
          id: target === '0' ? groupId : target,
        },
        payload: {
          kind: 'group_ban',
          user_id: target,
          sub_type: event.sub_type,
          duration: event.duration,
          ...operatorFields,
        },
        ...eventIdentity(event, groupId, 'group.ban_changed'),
      };
    }
    const target = id(event.user_id);
    if (!target) {
      return;
    }
    if (event.notice_type === 'group_increase') {
      if (event.sub_type !== 'approve' && event.sub_type !== 'invite') {
        return;
      }
      return {
        ...base,
        type: 'member.joined',
        ...actorFields,
        subject: { kind: 'member', id: target },
        payload: {
          kind: 'member_joined',
          user_id: target,
          sub_type: event.sub_type,
          ...operatorFields,
        },
        ...eventIdentity(event, groupId, 'member.joined'),
      };
    }
    if (
      event.sub_type !== 'leave' &&
      event.sub_type !== 'kick' &&
      event.sub_type !== 'kick_me' &&
      event.sub_type !== 'disband'
    ) {
      return;
    }
    return {
      ...base,
      type: 'member.left',
      ...actorFields,
      subject: { kind: 'member', id: target },
      payload: {
        kind: 'member_left',
        user_id: target,
        sub_type: event.sub_type,
        ...operatorFields,
      },
      ...eventIdentity(event, groupId, 'member.left'),
    };
  }
  if (event.notice_type === 'group_upload') {
    const uploader = id(event.user_id),
      file = event.file;
    if (!uploader || !object(file) || !natural(file.size)) {
      return;
    }
    const name = metadataName(file.name);
    if (!name) {
      return;
    }
    // 刻意丢弃file.id、busid、URL、路径及其他任意传输字段。
    return {
      ...base,
      type: 'file.uploaded',
      actorId: uploader,
      subject: { kind: 'group', id: groupId },
      payload: {
        kind: 'file_uploaded',
        user_id: uploader,
        name,
        size: file.size,
      },
      ...eventIdentity(event, groupId, 'file.uploaded'),
    };
  }
  if (event.notice_type === 'notify' && event.sub_type === 'group_name') {
    const name = metadataName(event.name_new),
      user = id(event.user_id);
    if (
      !name ||
      (event.user_id !== undefined &&
        event.user_id !== 0 &&
        event.user_id !== '0' &&
        !user)
    ) {
      return;
    }
    // user_id仅作为上报字段保留，不推断其为管理员或操作者。
    return {
      ...base,
      type: 'group.name_changed',
      subject: { kind: 'group', id: groupId },
      payload: { kind: 'group_name', name, ...(user ? { user_id: user } : {}) },
      ...eventIdentity(event, groupId, 'group.name_changed'),
    };
  }
  return undefined;
}

/**
 * 只有调用方能确认这是经过校验的真实发送ACK。无论echo先到还是ACK先到，
 * 都走store按消息ID的同一去重逻辑，绝不覆盖先写入的不可变事实。
 */
export function recordToolMessage(
  store: WorldEventStore,
  entry: TimelineEntry,
  observedAt = now(),
) {
  return store.appendMessage(
    { ...entry, bot: true },
    { source: 'tool', observedAt, verified: true },
  );
}
