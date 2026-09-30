import type { Config } from '../config/onebot.ts';

import { id } from './identity.ts';

export function parseCommand(
  message: unknown,
  selfId: string,
): '/ping' | '/help' | undefined {
  if (!Array.isArray(message) || message.length > 64) {
    return undefined;
  }
  let text = '';
  let mentioned = false;
  for (const segment of message) {
    if (!segment || typeof segment !== 'object' || !segment.data) {
      return undefined;
    }
    if (segment.type === 'text' && typeof segment.data.text === 'string') {
      text += segment.data.text;
      if (text.length > 256) {
        return undefined;
      }
    } else if (
      segment.type === 'at' &&
      id(segment.data.qq) === selfId &&
      !mentioned &&
      !text.trim()
    ) {
      mentioned = true;
    } else {
      return undefined;
    }
  }
  const command = text.trim();
  return command === '/ping' || command === '/help' ? command : undefined;
}

export interface Reply {
  action: 'send_group_msg' | 'send_private_msg';
  params: Record<string, unknown>;
}

export class Bot {
  private recent = new Map<string, number>();
  private conversations = new Map<string, number>();
  constructor(
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {}

  handle(event: any, selfId: string): Reply | undefined {
    if (
      !event ||
      event.post_type !== 'message' ||
      id(event.self_id) !== selfId
    ) {
      return undefined;
    }
    const userId = id(event.user_id);
    if (!userId || userId === selfId) {
      return undefined;
    }
    let conversation: string;
    let action: Reply['action'];
    let target: Record<string, unknown>;
    if (event.message_type === 'group') {
      const groupId = id(event.group_id);
      if (!groupId || !this.config.allowedGroups.has(groupId)) {
        return undefined;
      }
      conversation = `g:${groupId}`;
      action = 'send_group_msg';
      target = { group_id: groupId };
    } else if (event.message_type === 'private') {
      if (
        !this.config.allowPrivate ||
        (this.config.allowedUsers.size > 0 &&
          !this.config.allowedUsers.has(userId))
      ) {
        return undefined;
      }
      conversation = `u:${userId}`;
      action = 'send_private_msg';
      target = { user_id: userId };
    } else {
      return undefined;
    }
    const command = parseCommand(event.message, selfId);
    if (!command) {
      return undefined;
    }
    const messageId = event.message_id;
    if (!(
      (typeof messageId === 'number' && Number.isSafeInteger(messageId)) ||
      (typeof messageId === 'string' && /^-?\d{1,32}$/.test(messageId))
    )) {
      return undefined;
    }
    const now = this.now();
    for (const [key, expiry] of this.recent) {
      if (expiry <= now) {
        this.recent.delete(key);
      } else {
        break;
      }
    }
    const key = `${conversation}:${userId}:${messageId}`;
    if (this.recent.has(key)) {
      return undefined;
    }
    if (this.recent.size >= this.config.dedupMax) {
      this.recent.delete(this.recent.keys().next().value!);
    }
    this.recent.set(key, now + this.config.dedupTtlMs);
    for (const [key, expiry] of this.conversations) {
      if (expiry <= now) {
        this.conversations.delete(key);
      }
    }
    if (
      this.conversations.has(conversation) ||
      this.conversations.size >= this.config.conversationMax
    ) {
      return undefined;
    }
    this.conversations.set(conversation, now + this.config.rateLimitMs);
    return {
      action,
      params: {
        ...target,
        message: [
          {
            type: 'text',
            data: {
              text:
                command === '/ping'
                  ? 'pong'
                  : '/ping — pong\n/help — show commands',
            },
          },
        ],
      },
    };
  }
}
