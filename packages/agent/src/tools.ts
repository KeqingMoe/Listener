import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat, Mentioned } from '@listener/chat';
import { readEvents } from './tools/readEvents';
import { sendMessage } from './tools/sendMessage';
import { unwatch } from './tools/unwatch';

export { toolError } from './tools/error';

export function tools(
  chat: Chat,
  signal: AbortSignal,
  mentioned: Mentioned,
): AgentTool[] {
  return [
    sendMessage(chat),
    readEvents(chat),
    unwatch(chat, signal, mentioned),
  ];
}
