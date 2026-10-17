import type { NCWebsocket } from 'node-napcat-ts';
import type { Append, Client } from './client';
import {
  type GroupId,
  messageId,
  Time,
  groupId as toGroupId,
  userId as toUserId,
} from './id';
import { toWebp } from './image';
import { read, write } from './message';

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
  const chats = new Map<GroupId, Set<Append>>();

  const unsub = ws.subscribe('message.group', event => {
    const id = toGroupId(event.group_id);
    if (id === undefined) {
      return;
    }
    const group = chats.get(id);
    if (group === undefined) {
      return;
    }
    const stored = read(event);
    if (stored === undefined) {
      return;
    }
    for (const append of group) {
      void append(stored).catch(() => {});
    }
  });

  return {
    watch(groupId, append) {
      let group = chats.get(groupId);
      if (group === undefined) {
        group = new Set();
        chats.set(groupId, group);
      }
      group.add(append);
      return () => {
        const current = chats.get(groupId);
        if (current === undefined) {
          return;
        }
        current.delete(append);
        if (current.size === 0) {
          chats.delete(groupId);
        }
      };
    },

    dispose() {
      unsub();
      chats.clear();
    },

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

    async info(groupId, userId) {
      const raw = await ws
        .send('get_group_member_info', {
          group_id: Number(groupId),
          user_id: Number(userId),
        })
        .catch(() => undefined);
      if (raw === undefined) {
        return;
      }
      const joinTime = Time(raw.join_time * 1000);
      if (joinTime === undefined) {
        return;
      }
      return {
        nickname: raw.nickname,
        card: raw.card || undefined,
        role: raw.role === 'member' ? undefined : raw.role,
        title: raw.title || undefined,
        sex: raw.sex,
        age: raw.age,
        area: raw.area,
        level: raw.level,
        qqLevel: raw.qq_level,
        joinTime,
        lastActiveTime:
          raw.last_sent_time > 0 ? Time(raw.last_sent_time * 1000) : undefined,
        isRobot: raw.is_robot || undefined,
      };
    },

    async avatar(userId, size) {
      try {
        const url = `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`;
        const resp = await fetch(url);
        if (!resp.ok) return;
        const buffer = Buffer.from(await resp.arrayBuffer());
        const webp = await toWebp(buffer, size);
        return {
          data: webp.toString('base64'),
          mimeType: 'image/webp',
        };
      } catch {
        return;
      }
    },

    async message(msgId) {
      const raw = await ws
        .send('get_msg', { message_id: Number(msgId) })
        .catch(failure);
      const userId = toUserId(raw.user_id);
      const time = Time(Math.floor(raw.time * 1000));
      if (userId === undefined || time === undefined) {
        return;
      }
      return {
        type: 'message.created',
        msgId,
        time,
        userId,
        segments: [],
      };
    },
  };
}
