import type { NCWebsocket } from 'node-napcat-ts';
import type { Client } from './client';
import { type GroupId, messageId, userId as toUserId, UnixTime } from './id';
import { write } from './message';

function text(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  return JSON.stringify(error) ?? String(error);
}

function failure(error: unknown): never {
  throw error instanceof Error
    ? error
    : new Error(text(error), { cause: error });
}

export function napcat(ws: NCWebsocket): Client {
  return {
    async send(groupId: GroupId, message) {
      const result = await ws
        .send('send_group_msg', {
          group_id: Number(groupId),
          message: write(message),
        })
        .catch(failure);
      const id = messageId(result.message_id);
      if (id === undefined) {
        throw new Error('认不出回执');
      }
      return id;
    },

    async message(msgId) {
      const raw = await ws
        .send('get_msg', { message_id: Number(msgId) })
        .catch(failure);
      const userId = toUserId(raw.user_id);
      const timestamp = UnixTime(Math.floor(raw.time));
      if (userId === undefined || timestamp === undefined) {
        return;
      }
      return {
        type: 'message.created',
        msgId,
        timestamp,
        userId,
        segments: [],
      };
    },
  };
}
