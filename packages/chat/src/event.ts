import type { GapId, MessageId, UnixTime, UserId } from './id';

export type AtSegment = {
  type: 'at';
  userId: UserId;
};

export type AtAllSegment = {
  type: 'at.all';
};

export type UnsupportedSegment = {
  type: 'unsupported';
};

export type Segment = string | AtSegment | AtAllSegment | UnsupportedSegment;

export type MessageCreated = {
  type: 'message.created';
  msgId: MessageId;
  timestamp: UnixTime;
  userId: UserId;
  replyTo?: MessageId;
  segments: Segment[];
};

export type UnreadGap = {
  type: 'gap';
  gapId: GapId;
  skipped: number;
  mentioned: boolean;
};

export type Send = {
  segments: Segment[];
  replyTo?: MessageId;
};

export type ChatEvent = MessageCreated;

export type Event = ChatEvent | UnreadGap;
