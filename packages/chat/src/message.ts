import type { GroupMessage, SendMessageSegment } from 'node-napcat-ts';
import { Structs } from 'node-napcat-ts';
import type { MessageCreated, Segment, Send } from './event';
import { type MessageId, messageId, Time, userId as toUserId } from './id';

export function read(event: GroupMessage): MessageCreated | undefined {
  const userId = toUserId(event.user_id);
  const id = messageId(event.message_id);
  const time = Time(Math.floor(event.time * 1000));
  if (userId === undefined || id === undefined || time === undefined) {
    return;
  }

  let replyTo: MessageId | undefined;
  const segments: Segment[] = [];
  for (const segment of event.message) {
    switch (segment.type) {
      case 'reply':
        replyTo ??= messageId(segment.data.id);
        break;
      case 'text':
        segments.push(segment.data.text);
        break;
      case 'at': {
        if (segment.data.qq === 'all') {
          segments.push({ type: 'at.all' });
          break;
        }
        const atId = toUserId(segment.data.qq);
        if (atId === undefined) {
          segments.push({ type: 'unsupported' });
        } else {
          segments.push({ type: 'at', userId: atId });
        }
        break;
      }
      default:
        segments.push({ type: 'unsupported' });
    }
  }

  return {
    type: 'message.created',
    msgId: id,
    time,
    userId,
    segments,
    replyTo,
  };
}

export function write(message: Send): SendMessageSegment[] {
  const napcat: SendMessageSegment[] = [];
  if (message.replyTo !== undefined) {
    napcat.push(Structs.reply(message.replyTo));
  }
  for (const segment of message.segments) {
    if (typeof segment === 'string') {
      napcat.push(Structs.text(segment));
      continue;
    }
    switch (segment.type) {
      case 'at':
        napcat.push(Structs.at(segment.userId));
        break;
      case 'at.all':
        napcat.push(Structs.at('all'));
        break;
      case 'unsupported':
        break;
    }
  }
  return napcat;
}
