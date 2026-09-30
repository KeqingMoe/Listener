import type { TimelineEntry } from '../contracts/messages.ts';

export const WORLD_EVENT_TYPES = [
  'message.created',
  'message.recalled',
  'reaction.changed',
  'poke.created',
  'member.joined',
  'member.left',
  'group.ban_changed',
  'file.uploaded',
  'group.name_changed',
] as const;

export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];
export type EventSource = 'onebot' | 'tool' | 'migration';

export interface EventProvenance {
  source: EventSource;
  verified: boolean;
}

export interface MessageCreatedPayload {
  kind: 'message';
  message: TimelineEntry;
}

export interface MessageRecalledPayload {
  kind: 'message_recalled';
  message_id: string;
  recalled_by?: string;
}

export interface ReactionChangedPayload {
  kind: 'reaction';
  message_id: string;
  emoji_id?: string;
  emoji_type?: string;
  action?: 'add' | 'remove';
  user_id?: string;
}

export interface PokeCreatedPayload {
  kind: 'poke';
  user_id: string;
}

export interface MemberJoinedPayload {
  kind: 'member_joined';
  user_id: string;
  sub_type: 'approve' | 'invite';
  operator_id?: string;
}

export interface MemberLeftPayload {
  kind: 'member_left';
  user_id: string;
  sub_type: 'leave' | 'kick' | 'kick_me' | 'disband';
  operator_id?: string;
}

/** 即使duration与sub_type看起来矛盾，也保留上游的分类。user_id=0是上游表示全群禁言的哨兵值。 */
export interface GroupBanPayload {
  kind: 'group_ban';
  user_id: string;
  sub_type: 'ban' | 'lift_ban';
  duration: number;
  operator_id?: string;
}

/** 仅为元数据：这个payload及其群subject都不授予读取文件的能力。 */
export interface FileUploadedPayload {
  kind: 'file_uploaded';
  user_id: string;
  name: string;
  size: number;
}

export interface GroupNamePayload {
  kind: 'group_name';
  name: string;
  user_id?: string;
}

export type WorldEventPayload =
  | MessageCreatedPayload
  | MessageRecalledPayload
  | ReactionChangedPayload
  | PokeCreatedPayload
  | MemberJoinedPayload
  | MemberLeftPayload
  | GroupBanPayload
  | FileUploadedPayload
  | GroupNamePayload;

export interface WorldEvent {
  eventId: string;
  sequence: number;
  type: WorldEventType;
  groupId: string;
  occurredAt?: number;
  observedAt: number;
  actorId?: string;
  subject?: { kind: string; id: string };
  payload: WorldEventPayload;
  provenance: EventProvenance;
}

export type WorldEventInput = Omit<
  WorldEvent,
  'eventId' | 'sequence' | 'groupId'
> & { eventId?: string; dedupKey?: string; groupId?: string };

export type ProjectedWorldEvent = Omit<WorldEvent, 'payload'> & {
  payload: WorldEventPayload | null;
  payload_omitted?: true;
  omission_reason?: 'output_limit';
};

export interface ReadEventsInput {
  limit: number;
  after?: number;
  before?: number;
  highWater?: number;
  direction?: 'forward' | 'backward';
  types?: WorldEventType[];
  actorId?: string;
  since?: number;
  until?: number;
}

export interface EventPage {
  events: ProjectedWorldEvent[];
  requested: number;
  returned: number;
  truncated: boolean;
  reason?: 'output_limit' | 'limit';
  nextCursor?: number;
  lastSequence?: number;
  highWater: number;
  queriedAt: number;
}

export interface MessageView extends TimelineEntry {
  recalled?: boolean;
  recalledAt?: number;
  recalledBy?: string;
  payload_omitted?: true;
  omission_reason?: 'output_limit';
}

export interface MessagePage {
  messages: MessageView[];
  requested: number;
  returned: number;
  truncated: boolean;
  reason?: 'output_limit' | 'limit';
  nextCursor?: number;
  lastSequence?: number;
  highWater: number;
  queriedAt: number;
}

export interface WorldState {
  groupId: string;
  latestSequence: number;
  unreadEvents: number;
  observationWatermark: number;
  unreadByType: Partial<Record<WorldEventType, number>>;
}

export type StoredRow = {
  event_id: string;
  sequence: number;
  type: WorldEventType;
  group_id: string;
  occurred_at: number | null;
  observed_at: number;
  actor_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  payload: string;
  source: EventSource;
  verified: number;
};
