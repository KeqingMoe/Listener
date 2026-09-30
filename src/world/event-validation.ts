import { type JsonObject, isPlainObject } from '../contracts/json.ts';
import type { MessageSegment, TimelineEntry } from '../contracts/messages.ts';
import {
  WORLD_EVENT_TYPES,
  type StoredRow,
  type WorldEvent,
  type WorldEventInput,
  type WorldEventPayload,
  type WorldEventType,
} from './event-types.ts';

export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_ID = 256;
export const nowSeconds = () => Date.now() / 1000;
export const finiteTime = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 9_999_999_999;
export const text = (value: unknown, max = MAX_ID): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
export const safeJson = (value: unknown, max = MAX_EVENT_BYTES): string => {
  let nodes = 0;
  const check = (v: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 12) {
      throw new Error('Invalid event payload');
    }
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    ) {
      return;
    }
    if (
      !v ||
      typeof v !== 'object' ||
      (!Array.isArray(v) && !isPlainObject(v))
    ) {
      throw new Error('Invalid event payload');
    }
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('Invalid event payload');
      }
      check(descriptor.value, depth + 1);
    }
  };
  check(value, 0);
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result, 'utf8') > max) {
    throw new Error('Event payload too large');
  }
  return result;
};
export const allowedTypes = new Set<WorldEventType>(WORLD_EVENT_TYPES);
export const accountId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
export const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const only = (value: JsonObject, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
export const metadataName = (value: unknown): value is string =>
  text(value, 256) && !/(?:https?:\/\/|file:\/\/|data:)/i.test(value);

export function validSegment(value: unknown): value is MessageSegment {
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'text') {
    return typeof value.text === 'string' && value.text.length <= 4000;
  }
  if (value.type === 'face') {
    return (
      text(value.id, 64) &&
      (value.name === undefined ||
        (typeof value.name === 'string' && value.name.length <= 80))
    );
  }
  if (value.type === 'at') {
    return text(value.user_id, 64);
  }
  if (value.type === 'reply') {
    return text(value.message_id, 64);
  }
  if (value.type === 'record') {
    return (
      only(value, ['type', 'content_status']) &&
      value.content_status === 'not_transcribed'
    );
  }
  if (value.type === 'image') {
    return value.content_status === 'not_viewed';
  }
  if (value.type === 'forward') {
    return value.content_status === 'not_read';
  }
  return value.type === 'unsupported' && text(value.kind, 64);
}

export function validateMessage(value: unknown): value is TimelineEntry {
  if (
    !isPlainObject(value) ||
    !text(value.messageId) ||
    !text(value.userId) ||
    typeof value.nickname !== 'string' ||
    value.nickname.length > 256 ||
    typeof value.text !== 'string' ||
    value.text.length > 16_384 ||
    !finiteTime(value.time)
  ) {
    return false;
  }
  if (value.replyTo !== undefined && !text(value.replyTo)) {
    return false;
  }
  if (value.bot !== undefined && typeof value.bot !== 'boolean') {
    return false;
  }
  if (
    value.segments !== undefined &&
    (!Array.isArray(value.segments) ||
      value.segments.length > 128 ||
      !value.segments.every(validSegment))
  ) {
    return false;
  }
  return true;
}

export function validatePayload(
  type: WorldEventType,
  payload: unknown,
): payload is WorldEventPayload {
  if (!isPlainObject(payload) || typeof payload.kind !== 'string') {
    return false;
  }
  if (type === 'message.created') {
    return payload.kind === 'message' && validateMessage(payload.message);
  }
  if (type === 'message.recalled') {
    return (
      payload.kind === 'message_recalled' &&
      text(payload.message_id) &&
      (payload.recalled_by === undefined || text(payload.recalled_by))
    );
  }
  if (type === 'reaction.changed') {
    return (
      payload.kind === 'reaction' &&
      text(payload.message_id) &&
      (payload.emoji_id === undefined || text(payload.emoji_id, 64)) &&
      (payload.emoji_type === undefined || text(payload.emoji_type, 16)) &&
      (payload.action === undefined ||
        payload.action === 'add' ||
        payload.action === 'remove') &&
      (payload.user_id === undefined || text(payload.user_id, 64))
    );
  }
  if (type === 'poke.created') {
    return payload.kind === 'poke' && text(payload.user_id, 64);
  }
  if (type === 'member.joined' || type === 'member.left') {
    return (
      only(payload, ['kind', 'user_id', 'sub_type', 'operator_id']) &&
      accountId(payload.user_id) &&
      (payload.operator_id === undefined || accountId(payload.operator_id)) &&
      (type === 'member.joined'
        ? payload.kind === 'member_joined' &&
          typeof payload.sub_type === 'string' &&
          ['approve', 'invite'].includes(payload.sub_type)
        : payload.kind === 'member_left' &&
          typeof payload.sub_type === 'string' &&
          ['leave', 'kick', 'kick_me', 'disband'].includes(payload.sub_type))
    );
  }
  if (type === 'group.ban_changed') {
    return (
      only(payload, [
        'kind',
        'user_id',
        'sub_type',
        'duration',
        'operator_id',
      ]) &&
      payload.kind === 'group_ban' &&
      (payload.user_id === '0' || accountId(payload.user_id)) &&
      typeof payload.sub_type === 'string' &&
      ['ban', 'lift_ban'].includes(payload.sub_type) &&
      natural(payload.duration) &&
      (payload.operator_id === undefined || accountId(payload.operator_id))
    );
  }
  if (type === 'file.uploaded') {
    return (
      only(payload, ['kind', 'user_id', 'name', 'size']) &&
      payload.kind === 'file_uploaded' &&
      accountId(payload.user_id) &&
      metadataName(payload.name) &&
      natural(payload.size)
    );
  }
  if (type === 'group.name_changed') {
    return (
      only(payload, ['kind', 'name', 'user_id']) &&
      payload.kind === 'group_name' &&
      metadataName(payload.name) &&
      (payload.user_id === undefined || accountId(payload.user_id))
    );
  }
  return false;
}

export function subjectFor(
  input: WorldEventInput,
  groupId: string,
): { kind: string; id: string } {
  const payload = input.payload;
  switch (payload.kind) {
    case 'message':
      return { kind: 'message', id: payload.message.messageId };
    case 'message_recalled':
    case 'reaction':
      return { kind: 'message', id: payload.message_id };
    case 'poke':
    case 'member_joined':
    case 'member_left':
      return { kind: 'member', id: payload.user_id };
    case 'group_ban':
      return payload.user_id === '0'
        ? { kind: 'group', id: groupId }
        : { kind: 'member', id: payload.user_id };
    case 'file_uploaded':
    case 'group_name':
      return { kind: 'group', id: groupId };
  }
}

export function eventFrom(row: StoredRow): WorldEvent {
  const event: WorldEvent = {
    eventId: row.event_id,
    sequence: row.sequence,
    type: row.type,
    groupId: row.group_id,
    observedAt: row.observed_at,
    payload: JSON.parse(row.payload) as WorldEventPayload,
    provenance: { source: row.source, verified: row.verified === 1 },
  };
  if (row.occurred_at !== null) {
    event.occurredAt = row.occurred_at;
  }
  if (row.actor_id !== null) {
    event.actorId = row.actor_id;
  }
  if (row.subject_kind !== null && row.subject_id !== null) {
    event.subject = { kind: row.subject_kind, id: row.subject_id };
  }
  return event;
}

/**
 * 单个群的世界事件SQLite存储：追加式事件日志、消息快照和按consumer的观察水位。
 * 一个数据库文件只绑定一个群（world_identity），打开时群不匹配直接报错。
 */
