import { createHash } from 'node:crypto';
import { extractMessageContent } from './message-content.js';
import { imageReferences } from './image-tools.js';
import { forwardReferences } from './forward-references.js';
import type { TimelineEntry } from './contracts.js';
import type { EventSource, WorldEventInput, WorldEventStore } from './world-events.js';

const now = () => Date.now() / 1000;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
/** Reject accessors/cycles/non-JSON values BEFORE inspecting fields. Never persist the raw envelope. */
function boundedJson(value: unknown): boolean {
  let nodes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 12) return false;
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return true;
    if (!v || typeof v !== 'object' || (!Array.isArray(v) && !object(v))) return false;
    return Reflect.ownKeys(v).every(key => {
      if (Array.isArray(v) && key === 'length') return true;
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      return typeof key === 'string' && !!descriptor && Object.hasOwn(descriptor, 'value') && visit(descriptor.value, depth + 1);
    });
  };
  try { return visit(value, 0) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 64 * 1024; } catch { return false; }
}
function id(value: unknown): string | undefined {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value <= 0) return; value = String(value); }
  return typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value) ? value : undefined;
}
function messageId(value: unknown): string | undefined {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) return; value = String(value); }
  return typeof value === 'string' && /^(0|-?[1-9][0-9]{0,31})$/.test(value) ? value : undefined;
}
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9_999_999_999; }
function eventIdentity(event: Record<string, unknown>, groupId: string, type: string): { dedupKey?: string } {
  // Without a provider event identity, identical pokes/reactions in one second can be
  // distinct actions. Do not invent a dedup key from timestamp/body in that case.
  const identity = event.event_id;
  if (typeof identity !== 'string' || !identity || identity.length > 256 || /[\u0000-\u001f\u007f]/.test(identity)) return {};
  return { dedupKey: `notice:${createHash('sha256').update(JSON.stringify([groupId, type, identity])).digest('hex')}` };
}
function normalizeMessage(event: Record<string, unknown>, groupId: string, source: EventSource, observedAt: number, selfId: string): WorldEventInput | undefined {
  const msgId = messageId(event.message_id), userId = id(event.user_id), wire = event.message;
  if (msgId === undefined || !userId || (!Array.isArray(wire) && typeof wire !== 'string') || (Array.isArray(wire) && wire.length > 128)) return;
  const sender = object(event.sender) ? event.sender : {};
  if (sender.user_id !== undefined && id(sender.user_id) !== userId) return;
  const nickname = typeof sender.card === 'string' && sender.card ? sender.card : typeof sender.nickname === 'string' && sender.nickname ? sender.nickname : userId;
  const images = imageReferences(msgId, wire), forwards = forwardReferences(msgId, wire);
  const content = extractMessageContent(msgId, wire, images, forwards);
  // Human-readable fallback only; typed content remains authoritative. Strings/CQ lookalikes
  // are never parsed into operations. No upstream raw_message or arbitrary metadata survives.
  const text = content.segments.map(segment => {
    if (segment.type === 'text') return segment.text;
    if (segment.type === 'face') return `[face:${segment.id}]`;
    if (segment.type === 'at') return `[at:${segment.user_id}]`;
    if (segment.type === 'reply') return '';
    return `[${segment.type}]`;
  }).join('').slice(0, 16_384);
  const replyTo = content.segments.findLast(segment => segment.type === 'reply');
  const entry: TimelineEntry = {
    messageId: msgId, userId, nickname: nickname.slice(0, 256), text,
    time: timestamp(event.time) ? event.time : observedAt, ...content,
    ...(replyTo?.type === 'reply' ? { replyTo: replyTo.message_id } : {}),
    ...(images.length ? { images } : {}), ...(forwards.length ? { forwards } : {}),
    ...(userId === selfId ? { bot: true } : {}),
  };
  return {
    type: 'message.created', groupId, observedAt, ...(timestamp(event.time) ? { occurredAt: event.time } : {}),
    actorId: userId, subject: { kind: 'message', id: msgId }, payload: { kind: 'message', message: entry },
    provenance: { source, verified: source !== 'migration' }, dedupKey: `message:${msgId}`,
  };
}

/** Group-scoped structural normalization, not permission verification. Caller still applies its
 * configured group allowlist before storing. Unknown/private events are ignored, never guessed. */
export function normalizeOneBotEvent(event: unknown, selfId: string, source: EventSource = 'onebot', observedAt = now()): WorldEventInput | undefined {
  if (!boundedJson(event) || !object(event) || !id(selfId) || !timestamp(observedAt) || !['onebot','tool','migration'].includes(source)) return;
  const groupId = id(event.group_id);
  if (!groupId || event.message_type === 'private' || (event.self_id !== undefined && id(event.self_id) !== selfId)) return;
  if (event.time !== undefined && !timestamp(event.time)) return;
  if (event.post_type === 'message' && event.message_type === 'group') return normalizeMessage(event, groupId, source, observedAt, selfId);
  if (event.post_type !== 'notice') return;
  const base = { groupId, observedAt, ...(timestamp(event.time) ? { occurredAt: event.time } : {}), provenance: { source, verified: false } };
  if (event.notice_type === 'group_recall') {
    const msgId = messageId(event.message_id); if (msgId === undefined) return;
    // user_id is the message author, NOT necessarily the person who recalled it.
    const operator = id(event.operator_id);
    if (event.operator_id !== undefined && !operator) return;
    return { ...base, type: 'message.recalled', ...(operator ? { actorId: operator } : {}),
      subject: { kind: 'message', id: msgId }, payload: { kind: 'message_recalled', message_id: msgId, ...(operator ? { recalled_by: operator } : {}) }, dedupKey: `recall:${msgId}` };
  }
  if (event.notice_type === 'group_msg_emoji_like') {
    const msgId = messageId(event.message_id); if (msgId === undefined) return;
    // NapCat notices may be dirty hints. Do NOT attribute user_id/likes.count/is_add
    // to an actor, action or exact count. The current aggregate is queried separately.
    return { ...base, type: 'reaction.changed', subject: { kind: 'message', id: msgId },
      payload: { kind: 'reaction', message_id: msgId }, ...eventIdentity(event, groupId, 'reaction.changed') };
  }
  if (event.notice_type === 'notify' && event.sub_type === 'poke') {
    const actor = id(event.user_id), target = id(event.target_id); if (!actor || !target) return;
    return { ...base, type: 'poke.created', actorId: actor, subject: { kind: 'member', id: target },
      payload: { kind: 'poke', user_id: target }, ...eventIdentity(event, groupId, 'poke.created') };
  }
  return undefined;
}

/** Only the caller can establish that this is an actual validated send ACK. Echo-first/ACK-first
 * use the store's same message-ID dedup and never overwrite the original immutable fact. */
export function recordToolMessage(store: WorldEventStore, entry: TimelineEntry, observedAt = now()) {
  return store.appendMessage({ ...entry, bot: true }, { source: 'tool', observedAt, verified: true });
}
