import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat } from '@listener/chat';
import type { Logger } from 'pino';
import { Type } from 'typebox';

const waitParameters = Type.Object({
  ms: Type.Integer({ minimum: 0 }),
});

type Reason = 'timeout' | 'event' | 'abort';

export function wait(
  chat: Chat,
  signal: AbortSignal,
  parent: Logger,
): AgentTool<typeof waitParameters> {
  return {
    name: 'wait',
    label: '等待',
    description: '等 ms 毫秒或群里的下一条消息。',
    parameters: waitParameters,
    executionMode: 'sequential',
    async execute(toolCallId, params) {
      const log = parent.child({ tool: 'wait', toolCallId });
      const doLog = (reason: Reason) => {
        log.info({ ms: params.ms, reason });
        return { content: [], details: undefined };
      };

      if (signal.aborted) {
        return doLog('abort');
      }
      if (chat.unread > 0) {
        return doLog('event');
      }

      const { promise, resolve } = Promise.withResolvers<Reason>();
      const finish = (why: Reason) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        off();
        resolve(why);
      };

      const onAbort = () => finish('abort');
      const off = chat.on(() => finish('event'));
      const timer = setTimeout(() => finish('timeout'), params.ms);
      signal.addEventListener('abort', onAbort, { once: true });

      const reason = await promise;
      return doLog(reason);
    },
  };
}
