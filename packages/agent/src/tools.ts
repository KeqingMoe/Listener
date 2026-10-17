import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat, Mentioned } from '@listener/chat';
import type { Logger } from 'pino';
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
  log: Logger,
): AgentTool[] {
  return [
    sendMessage(chat, log),
    readEvents(chat, log),
    readMember(chat, log),
    wait(chat, signal, log),
    unwatch(chat, signal, mentioned, log),
  ];
}
