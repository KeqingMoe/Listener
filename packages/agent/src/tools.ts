import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat, Mentioned } from '@listener/chat';
import { readEvents } from './tools/readEvents';
import { readMember } from './tools/readMember';
import { sendMessage } from './tools/sendMessage';
import { unwatch } from './tools/unwatch';
import { wait } from './tools/wait';

export { toolError } from './tools/error';

export function tools(
  chat: Chat,
  signal: AbortSignal,
  mentioned: Mentioned,
): AgentTool[] {
  return [
    sendMessage(chat),
    readEvents(chat),
    readMember(chat),
    wait(chat, signal),
    unwatch(chat, signal, mentioned),
  ];
}
