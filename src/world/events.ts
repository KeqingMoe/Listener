import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveGroupId } from '../contracts/identity.js';
import { type JsonObject } from '../contracts/json.js';
import { type MessageSegment, type TimelineEntry } from '../contracts/messages.js';

export const WORLD_EVENT_TYPES = ['message.created', 'message.recalled', 'reaction.changed', 'poke.created', 'member.joined', 'member.left', 'group.ban_changed', 'file.uploaded', 'group.name_changed'] as const;
export type WorldEventType = typeof WORLD_EVENT_TYPES[number];
export type EventSource = 'onebot' | 'tool' | 'migration';
export interface EventProvenance { source: EventSource; verified: boolean }
export interface MessageCreatedPayload { kind: 'message'; message: TimelineEntry }
export interface MessageRecalledPayload { kind: 'message_recalled'; message_id: string; recalled_by?: string }
export interface ReactionChangedPayload { kind: 'reaction'; message_id: string; emoji_id?: string; emoji_type?: string; action?: 'add' | 'remove'; user_id?: string }
export interface PokeCreatedPayload { kind: 'poke'; user_id: string }
export interface MemberJoinedPayload { kind: 'member_joined'; user_id: string; sub_type: 'approve' | 'invite'; operator_id?: string }
export interface MemberLeftPayload { kind: 'member_left'; user_id: string; sub_type: 'leave' | 'kick' | 'kick_me' | 'disband'; operator_id?: string }
/** Preserve the upstream classification even if duration and subtype appear inconsistent. user_id=0 is the upstream whole-group sentinel. */
export interface GroupBanPayload { kind: 'group_ban'; user_id: string; sub_type: 'ban' | 'lift_ban'; duration: number; operator_id?: string }
/** Metadata only: neither this payload nor its group subject grants a file-reading capability. */
export interface FileUploadedPayload { kind: 'file_uploaded'; user_id: string; name: string; size: number }
export interface GroupNamePayload { kind: 'group_name'; name: string; user_id?: string }
export type WorldEventPayload = MessageCreatedPayload | MessageRecalledPayload | ReactionChangedPayload | PokeCreatedPayload | MemberJoinedPayload | MemberLeftPayload | GroupBanPayload | FileUploadedPayload | GroupNamePayload;
export interface WorldEvent {
  eventId: string; sequence: number; type: WorldEventType; groupId: string;
  occurredAt?: number; observedAt: number; actorId?: string;
  subject?: { kind: string; id: string }; payload: WorldEventPayload; provenance: EventProvenance;
}
export type WorldEventInput = Omit<WorldEvent, 'eventId' | 'sequence' | 'groupId'> & { eventId?: string; dedupKey?: string; groupId?: string };
export type ProjectedWorldEvent = Omit<WorldEvent, 'payload'> & { payload: WorldEventPayload | null; payload_omitted?: true; omission_reason?: 'output_limit' };
export interface ReadEventsInput { limit: number; after?: number; before?: number; highWater?: number; direction?: 'forward' | 'backward'; types?: WorldEventType[]; actorId?: string; since?: number; until?: number }
export interface EventPage { events: ProjectedWorldEvent[]; requested: number; returned: number; truncated: boolean; reason?: 'output_limit' | 'limit'; nextCursor?: number; lastSequence?: number; highWater: number; queriedAt: number }
export interface MessageView extends TimelineEntry { recalled?: boolean; recalledAt?: number; recalledBy?: string; payload_omitted?: true; omission_reason?: 'output_limit' }
export interface MessagePage { messages: MessageView[]; requested: number; returned: number; truncated: boolean; reason?: 'output_limit' | 'limit'; nextCursor?: number; lastSequence?: number; highWater: number; queriedAt: number }
export interface WorldState { groupId: string; latestSequence: number; unreadEvents: number; observationWatermark: number; unreadByType: Partial<Record<WorldEventType, number>> }

type StoredRow = { event_id: string; sequence: number; type: WorldEventType; group_id: string; occurred_at: number | null; observed_at: number; actor_id: string | null; subject_kind: string | null; subject_id: string | null; payload: string; source: EventSource; verified: number };
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_ID = 256;
const nowSeconds = () => Date.now() / 1000;
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9_999_999_999;
const text = (value: unknown, max = MAX_ID): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const safeJson = (value: unknown, max = MAX_EVENT_BYTES): string => {
  let nodes = 0;
  const check = (v: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 12) throw new Error('Invalid event payload');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (!v || typeof v !== 'object' || (!Array.isArray(v) && !object(v))) throw new Error('Invalid event payload');
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid event payload');
      check(descriptor.value, depth + 1);
    }
  };
  check(value, 0);
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result, 'utf8') > max) throw new Error('Event payload too large');
  return result;
};
const allowedTypes = new Set<WorldEventType>(WORLD_EVENT_TYPES);
const accountId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const only = (value: JsonObject, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const metadataName = (value: unknown): value is string => text(value, 256) && !/(?:https?:\/\/|file:\/\/|data:)/i.test(value);

function validSegment(value: unknown): value is MessageSegment {
  if (!object(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string' && value.text.length <= 4000;
  if (value.type === 'face') return text(value.id, 64) && (value.name === undefined || (typeof value.name === 'string' && value.name.length <= 80));
  if (value.type === 'at') return text(value.user_id, 64);
  if (value.type === 'reply') return text(value.message_id, 64);
  if (value.type === 'image') return value.content_status === 'not_viewed';
  if (value.type === 'forward') return value.content_status === 'not_read';
  return value.type === 'unsupported' && text(value.kind, 64);
}
function validateMessage(value: unknown): value is TimelineEntry {
  if (!object(value) || !text(value.messageId) || !text(value.userId) || typeof value.nickname !== 'string' || value.nickname.length > 256 || typeof value.text !== 'string' || value.text.length > 16_384 || !finiteTime(value.time)) return false;
  if (value.replyTo !== undefined && !text(value.replyTo)) return false;
  if (value.bot !== undefined && typeof value.bot !== 'boolean') return false;
  if (value.segments !== undefined && (!Array.isArray(value.segments) || value.segments.length > 128 || !value.segments.every(validSegment))) return false;
  return true;
}
function validatePayload(type: WorldEventType, payload: unknown): payload is WorldEventPayload {
  if (!object(payload) || typeof payload.kind !== 'string') return false;
  if (type === 'message.created') return payload.kind === 'message' && validateMessage(payload.message);
  if (type === 'message.recalled') return payload.kind === 'message_recalled' && text(payload.message_id) && (payload.recalled_by === undefined || text(payload.recalled_by));
  if (type === 'reaction.changed') return payload.kind === 'reaction' && text(payload.message_id) && (payload.emoji_id === undefined || text(payload.emoji_id, 64)) && (payload.emoji_type === undefined || text(payload.emoji_type, 16)) && (payload.action === undefined || payload.action === 'add' || payload.action === 'remove') && (payload.user_id === undefined || text(payload.user_id, 64));
  if (type === 'poke.created') return payload.kind === 'poke' && text(payload.user_id, 64);
  if (type === 'member.joined' || type === 'member.left') return only(payload, ['kind','user_id','sub_type','operator_id']) && accountId(payload.user_id) && (payload.operator_id === undefined || accountId(payload.operator_id)) && (type === 'member.joined' ? payload.kind === 'member_joined' && typeof payload.sub_type === 'string' && ['approve','invite'].includes(payload.sub_type) : payload.kind === 'member_left' && typeof payload.sub_type === 'string' && ['leave','kick','kick_me','disband'].includes(payload.sub_type));
  if (type === 'group.ban_changed') return only(payload, ['kind','user_id','sub_type','duration','operator_id']) && payload.kind === 'group_ban' && (payload.user_id === '0' || accountId(payload.user_id)) && typeof payload.sub_type === 'string' && ['ban','lift_ban'].includes(payload.sub_type) && natural(payload.duration) && (payload.operator_id === undefined || accountId(payload.operator_id));
  if (type === 'file.uploaded') return only(payload, ['kind','user_id','name','size']) && payload.kind === 'file_uploaded' && accountId(payload.user_id) && metadataName(payload.name) && natural(payload.size);
  if (type === 'group.name_changed') return only(payload, ['kind','name','user_id']) && payload.kind === 'group_name' && metadataName(payload.name) && (payload.user_id === undefined || accountId(payload.user_id));
  return false;
}
function subjectFor(input: WorldEventInput, groupId: string): {kind: string; id: string} {
  const payload = input.payload;
  switch (payload.kind) {
    case 'message': return {kind:'message',id:payload.message.messageId};
    case 'message_recalled': case 'reaction': return {kind:'message',id:payload.message_id};
    case 'poke': case 'member_joined': case 'member_left': return {kind:'member',id:payload.user_id};
    case 'group_ban': return payload.user_id === '0' ? {kind:'group',id:groupId} : {kind:'member',id:payload.user_id};
    case 'file_uploaded': case 'group_name': return {kind:'group',id:groupId};
  }
}
function eventFrom(row: StoredRow): WorldEvent {
  const event: WorldEvent = { eventId: row.event_id, sequence: row.sequence, type: row.type, groupId: row.group_id, observedAt: row.observed_at, payload: JSON.parse(row.payload) as WorldEventPayload, provenance: { source: row.source, verified: row.verified === 1 } };
  if (row.occurred_at !== null) event.occurredAt = row.occurred_at;
  if (row.actor_id !== null) event.actorId = row.actor_id;
  if (row.subject_kind !== null && row.subject_id !== null) event.subject = { kind: row.subject_kind, id: row.subject_id };
  return event;
}

export class WorldEventStore {
  private readonly db: DatabaseSync;
  readonly groupId: string;
  private readonly retentionDays: number;
  private closed = false;
  constructor(options: { path: string; groupId: string; retentionDays?: number }) {
    this.groupId = resolveGroupId(options.groupId);
    this.retentionDays = options.retentionDays ?? 30;
    if (!Number.isFinite(this.retentionDays) || this.retentionDays <= 0 || this.retentionDays > 3650) throw new Error('Invalid event retention');
    if (!text(options.path, 4096)) throw new Error('Invalid event store path');
    if (options.path !== ':memory:') {
      const fd = openSync(options.path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid event store file');
        if (info.size > 0) {
          const probe = new DatabaseSync(options.path, { readOnly: true });
          try {
            const identity = probe.prepare('SELECT group_id FROM world_identity WHERE singleton=1').get();
            if (identity?.group_id !== this.groupId) throw new Error('Event store group mismatch');
          } finally { probe.close(); }
        }
        const current = lstatSync(options.path);
        if (current.isSymbolicLink() || current.ino !== info.ino || current.dev !== info.dev) throw new Error('Event store file changed');
        fchmodSync(fd, 0o600);
      } finally { closeSync(fd); }
    }
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS world_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), group_id TEXT NOT NULL);');
      this.db.prepare('INSERT OR IGNORE INTO world_identity VALUES(1,?)').run(this.groupId);
      const identity = this.db.prepare('SELECT group_id FROM world_identity WHERE singleton=1').get() as { group_id?: string } | undefined;
      if (identity?.group_id !== this.groupId) throw new Error('Event store group mismatch');
      this.db.exec(`CREATE TABLE IF NOT EXISTS world_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, group_id TEXT NOT NULL, occurred_at REAL, observed_at REAL NOT NULL, actor_id TEXT, subject_kind TEXT, subject_id TEXT, payload TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL, dedup_key TEXT UNIQUE);
        CREATE INDEX IF NOT EXISTS world_events_type_seq ON world_events(type, sequence);
        CREATE INDEX IF NOT EXISTS world_events_observed ON world_events(observed_at);
        CREATE TABLE IF NOT EXISTS world_messages (message_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, entry TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS world_observers (consumer TEXT PRIMARY KEY, sequence INTEGER NOT NULL); COMMIT;`);
      this.prune();
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} this.db.close(); throw error; }
  }
  private ensureOpen(): void { if (this.closed) throw new Error('Event store is closed'); }
  private cutoff(now = nowSeconds()): number { return now - this.retentionDays * 86400; }
  prune(now = nowSeconds()): number {
    this.ensureOpen(); if (!finiteTime(now)) throw new Error('Invalid prune time');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM world_messages WHERE sequence IN (SELECT sequence FROM world_events WHERE observed_at < ?)').run(this.cutoff(now));
      const result = this.db.prepare('DELETE FROM world_events WHERE observed_at < ?').run(this.cutoff(now));
      this.db.exec('COMMIT'); return Number(result.changes);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  append(input: WorldEventInput): WorldEvent {
    this.ensureOpen();
    safeJson(input);
    if (!object(input) || (input.groupId !== undefined && input.groupId !== this.groupId) || !allowedTypes.has(input.type) || !validatePayload(input.type, input.payload) || !object(input.provenance) || Object.keys(input.provenance).some(key => !['source','verified'].includes(key)) || !['onebot','tool','migration'].includes(input.provenance.source)) throw new Error('Invalid world event');
    if (!text(input.provenance.source, 16) || typeof input.provenance.verified !== 'boolean' || !finiteTime(input.observedAt) || (input.occurredAt !== undefined && !finiteTime(input.occurredAt)) || (input.actorId !== undefined && !text(input.actorId)) || (input.subject !== undefined && (!object(input.subject) || !text(input.subject.kind, 64) || !text(input.subject.id)))) throw new Error('Invalid world event');
    const eventId = input.eventId ?? `we_${randomUUID().replaceAll('-', '')}`; if (!text(eventId)) throw new Error('Invalid event id');
    const dedup = input.dedupKey ?? (input.type === 'message.created' ? `message:${(input.payload as MessageCreatedPayload).message.messageId}` : undefined); if (dedup !== undefined && !text(dedup)) throw new Error('Invalid dedup key');
    const subject = subjectFor(input, this.groupId);
    if (input.subject && (input.subject.kind !== subject.kind || input.subject.id !== subject.id)) throw new Error('Invalid event subject');
    if (['member.joined','member.left','group.ban_changed','file.uploaded','group.name_changed'].includes(input.type)) {
      const p = input.payload;
      const expectedActor = p.kind === 'file_uploaded' ? p.user_id : p.kind === 'member_joined' || p.kind === 'member_left' || p.kind === 'group_ban' ? p.operator_id : undefined;
      if (input.actorId !== undefined && input.actorId !== expectedActor) throw new Error('Invalid event actor');
    }
    const actorId = input.actorId ?? (input.type === 'message.created' ? (input.payload as MessageCreatedPayload).message.userId : undefined);
    const payload = safeJson(input.payload); this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = (input.type === 'message.created' ? this.db.prepare('SELECT world_events.* FROM world_events JOIN world_messages USING(sequence) WHERE world_messages.message_id=?').get((input.payload as MessageCreatedPayload).message.messageId) : undefined) as StoredRow | undefined ?? (dedup ? this.db.prepare('SELECT * FROM world_events WHERE dedup_key=?').get(dedup) as StoredRow | undefined : undefined);
      if (existing) { this.db.exec('COMMIT'); return eventFrom(existing); }
      this.db.prepare('INSERT INTO world_events(event_id,type,group_id,occurred_at,observed_at,actor_id,subject_kind,subject_id,payload,source,verified,dedup_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(eventId, input.type, this.groupId, input.occurredAt ?? null, input.observedAt, actorId ?? null, subject.kind, subject.id, payload, input.provenance.source, input.provenance.verified ? 1 : 0, dedup ?? null);
      const row = this.db.prepare('SELECT * FROM world_events WHERE event_id=?').get(eventId) as StoredRow;
      if (input.type === 'message.created') this.db.prepare('INSERT OR IGNORE INTO world_messages(message_id,sequence,entry) VALUES(?,?,?)').run((input.payload as MessageCreatedPayload).message.messageId, row.sequence, JSON.stringify((input.payload as MessageCreatedPayload).message));
      this.db.exec('COMMIT'); return eventFrom(row);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  appendMessage(entry: TimelineEntry, options: { source: EventSource; observedAt?: number; occurredAt?: number; actorId?: string; verified?: boolean } = { source: 'onebot' }): WorldEvent {
    safeJson(entry); safeJson(options);
    if (!validateMessage(entry)) throw new Error('Invalid message');
    return this.append({ type: 'message.created', observedAt: options.observedAt ?? nowSeconds(), occurredAt: options.occurredAt ?? entry.time, actorId: options.actorId ?? entry.userId, payload: { kind: 'message', message: structuredClone(entry) }, provenance: { source: options.source, verified: options.verified ?? options.source !== 'migration' } });
  }
  appendRecall(messageId: string, options: { observedAt?: number; occurredAt?: number; actorId?: string; recalledBy?: string; verified?: boolean } = {}): WorldEvent {
    if (!text(messageId)) throw new Error('Invalid message id');
    return this.append({ type: 'message.recalled', observedAt: options.observedAt ?? nowSeconds(), ...(options.occurredAt !== undefined ? { occurredAt: options.occurredAt } : {}), ...(options.actorId !== undefined ? { actorId: options.actorId } : {}), subject: { kind: 'message', id: messageId }, payload: { kind: 'message_recalled', message_id: messageId, ...(options.recalledBy !== undefined ? { recalled_by: options.recalledBy } : {}) }, provenance: { source: 'onebot', verified: options.verified ?? false }, dedupKey: `recall:${messageId}:${options.recalledBy ?? ''}` });
  }
  private latestSequence(): number {
    return Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='world_events'").get()?.seq ?? 0);
  }
  private where(input: ReadEventsInput, highWater: number): { sql: string; params: (string | number)[] } {
    if (!object(input) || !Number.isSafeInteger(input.limit) || input.limit <= 0) throw new Error('Invalid event limit');
    if (Object.keys(input).some(key => !['limit','after','before','highWater','direction','types','actorId','since','until'].includes(key))) throw new Error('Invalid query field');
    if (input.direction !== undefined && !['forward','backward'].includes(input.direction)) throw new Error('Invalid direction');
    for (const key of ['after','before','highWater'] as const) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key]! < 0)) throw new Error('Invalid cursor');
    if (input.highWater !== undefined && input.highWater > this.latestSequence()) throw new Error('Invalid high water');
    if (input.since !== undefined && !finiteTime(input.since)) throw new Error('Invalid since');
    if (input.until !== undefined && !finiteTime(input.until)) throw new Error('Invalid until');
    if (input.since !== undefined && input.until !== undefined && input.since > input.until) throw new Error('Invalid time range');
    const conditions = ['group_id=?', 'sequence<=?']; const params: (string | number)[] = [this.groupId, highWater];
    if (input.after !== undefined) { conditions.push('sequence>?'); params.push(input.after); }
    if (input.before !== undefined) { conditions.push('sequence<?'); params.push(input.before); }
    if (input.types !== undefined) {
      if (!Array.isArray(input.types) || input.types.length < 1 || input.types.length > allowedTypes.size || !input.types.every(type => allowedTypes.has(type))) throw new Error('Invalid event types');
      conditions.push(`type IN (${input.types.map(() => '?').join(',')})`); params.push(...input.types);
    }
    if (input.actorId !== undefined) { if (!text(input.actorId)) throw new Error('Invalid actor'); conditions.push('actor_id=?'); params.push(input.actorId); }
    if (input.since !== undefined) { conditions.push('observed_at>=?'); params.push(input.since); }
    if (input.until !== undefined) { conditions.push('observed_at<=?'); params.push(input.until); }
    return { sql: `SELECT * FROM world_events WHERE ${conditions.join(' AND ')} ORDER BY sequence ${input.direction === 'backward' ? 'DESC' : 'ASC'} LIMIT ?`, params: [...params, input.limit < Number.MAX_SAFE_INTEGER ? input.limit + 1 : input.limit] };
  }
  /** Sequence cursors are trusted internal values. Public tools must bind opaque cursors to scope/filter/direction. */
  readEvents(input: ReadEventsInput, maxBytes = 24_000): EventPage {
    return this.readPage(input, maxBytes, false) as EventPage;
  }
  readMessages(input: ReadEventsInput, maxBytes = 24_000): MessagePage {
    if (!object(input) || (input.types !== undefined && (input.types.length !== 1 || input.types[0] !== 'message.created'))) throw new Error('Invalid message query');
    return this.readPage({ ...input, types: ['message.created'] }, maxBytes, true) as MessagePage;
  }
  private messageView(entry: TimelineEntry, highWater: number): MessageView {
    const view: MessageView = structuredClone(entry);
    const recall = this.db.prepare("SELECT observed_at,occurred_at,payload FROM world_events WHERE type='message.recalled' AND subject_kind='message' AND subject_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1").get(entry.messageId, highWater) as { observed_at: number; occurred_at: number | null; payload: string } | undefined;
    if (recall) {
      const payload = JSON.parse(recall.payload) as MessageRecalledPayload;
      view.recalled = true; view.recalledAt = recall.occurred_at ?? recall.observed_at;
      if (payload.recalled_by !== undefined) view.recalledBy = payload.recalled_by;
    }
    return view;
  }
  private readPage(input: ReadEventsInput, maxBytes: number, messages: boolean): EventPage | MessagePage {
    this.ensureOpen(); if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048 || maxBytes > 24_000) throw new Error('Invalid event output limit');
    // One short read transaction binds rows, recall projections and high water consistently;
    // subsequent calls start fresh unless the caller explicitly passes the prior highWater.
    this.db.exec('BEGIN');
    try {
      const queriedAt = nowSeconds(); const highWater = input?.highWater ?? this.latestSequence();
      const { sql, params } = this.where(input, highWater);
      const items: (ProjectedWorldEvent | MessageView)[] = [];
      let lastSequence: number | undefined, reason: 'output_limit' | 'limit' | undefined, hasMore = false;
      const frame = (values = items) => ({ [messages ? 'messages' : 'events']: values, requested: input.limit, returned: values.length, truncated: true, reason: 'output_limit', nextCursor: Number.MAX_SAFE_INTEGER, lastSequence: Number.MAX_SAFE_INTEGER, highWater, queriedAt });
      const fits = (item: ProjectedWorldEvent | MessageView) => Buffer.byteLength(JSON.stringify(frame([...items, item])), 'utf8') <= maxBytes;
      for (const row of this.db.prepare(sql).iterate(...params) as Iterable<StoredRow>) {
        if (items.length === input.limit) { hasMore = true; reason ??= 'limit'; break; }
        const event = eventFrom(row);
        let item: ProjectedWorldEvent | MessageView = messages ? this.messageView((event.payload as MessageCreatedPayload).message, highWater) : event;
        if (!fits(item)) {
          if (items.length) { hasMore = true; reason = 'output_limit'; break; }
          if (messages) {
            const view = item as MessageView;
            item = { messageId: view.messageId, userId: view.userId, nickname: view.nickname, time: view.time, text: '', content_truncated: true, payload_omitted: true, omission_reason: 'output_limit', ...(view.recalled ? { recalled: true, recalledAt: view.recalledAt, ...(view.recalledBy ? { recalledBy: view.recalledBy } : {}) } : {}) };
          } else item = { ...event, payload: null, payload_omitted: true, omission_reason: 'output_limit' };
          if (!fits(item)) throw new Error('Event metadata exceeds output limit');
          reason = 'output_limit';
        }
        items.push(item); lastSequence = row.sequence;
      }
      const metadata = { requested: input.limit, returned: items.length, truncated: reason !== undefined, ...(reason ? { reason } : {}), ...(hasMore && lastSequence !== undefined ? { nextCursor: lastSequence } : {}), ...(lastSequence !== undefined ? { lastSequence } : {}), highWater, queriedAt };
      const page = messages ? { ...metadata, messages: items as MessageView[] } : { ...metadata, events: items as ProjectedWorldEvent[] };
      this.db.exec('COMMIT'); return page;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  findMessage(messageId: string, highWater?: number): MessageView | undefined {
    this.ensureOpen(); if (!text(messageId)) return undefined;
    const watermark = highWater ?? this.latestSequence();
    if (!Number.isSafeInteger(watermark) || watermark < 0) throw new Error('Invalid high water');
    const row = this.db.prepare('SELECT entry FROM world_messages WHERE message_id=? AND sequence<=?').get(messageId, watermark);
    return row ? this.messageView(JSON.parse(row.entry as string) as TimelineEntry, watermark) : undefined;
  }
  /** Internal convenience view with the same 24KB output resource boundary as readMessages. */
  recentMessages(limit: number): MessageView[] { return this.readMessages({ limit, direction: 'backward' }).messages.reverse(); }
  getState(consumer = 'default'): WorldState {
    this.ensureOpen(); if (!text(consumer, 128)) throw new Error('Invalid consumer');
    const latestSequence = this.latestSequence();
    const watermark = Number(this.db.prepare('SELECT sequence FROM world_observers WHERE consumer=?').get(consumer)?.sequence ?? 0);
    const unreadEvents = Number(this.db.prepare('SELECT COUNT(*) AS value FROM world_events WHERE sequence>?').get(watermark)!.value);
    const counts: Partial<Record<WorldEventType, number>> = {};
    for (const row of this.db.prepare('SELECT type,COUNT(*) AS count FROM world_events WHERE sequence>? GROUP BY type').iterate(watermark)) counts[row.type as WorldEventType] = Number(row.count);
    return { groupId: this.groupId, latestSequence, unreadEvents, observationWatermark: watermark, unreadByType: counts };
  }
  /** Explicit caller acknowledgement only: filtered reads NEVER advance observation watermarks. */
  ack(consumer: string, throughSequence: number): number {
    this.ensureOpen(); if (!text(consumer, 128) || !Number.isSafeInteger(throughSequence) || throughSequence < 0) throw new Error('Invalid observation cursor');
    if (throughSequence > this.latestSequence()) throw new Error('Observation cursor ahead');
    this.db.prepare('INSERT INTO world_observers(consumer,sequence) VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET sequence=MAX(world_observers.sequence,excluded.sequence)').run(consumer, throughSequence);
    return Number(this.db.prepare('SELECT sequence FROM world_observers WHERE consumer=?').get(consumer)!.sequence);
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
