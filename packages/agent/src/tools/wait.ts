import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat } from '@listener/chat';
import { Type } from 'typebox';

const waitParameters = Type.Object({
  ms: Type.Integer({ minimum: 0 }),
});

export type WaitResult = {
  reason: 'timeout' | 'event' | 'abort';
};

export function wait(
  chat: Chat,
  signal: AbortSignal,
): AgentTool<typeof waitParameters, WaitResult> {
  return {
    name: 'wait',
    label: '等待',
    description: '等 ms 毫秒或群里的下一条消息。',
    parameters: waitParameters,
    executionMode: 'sequential',
    async execute(_, params) {
      const done = (reason: WaitResult['reason']) => ({
        content: [],
        details: { reason },
      });

      if (signal.aborted) return done('abort');
      if (chat.unread > 0) return done('event');

      const reason = await new Promise<WaitResult['reason']>(resolve => {
        const finish = (why: WaitResult['reason']) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          off();
          resolve(why);
        };

        const onAbort = () => finish('abort');
        const off = chat.on(() => finish('event'));
        const timer = setTimeout(() => finish('timeout'), params.ms);
        signal.addEventListener('abort', onAbort, { once: true });
      });

      return done(reason);
    },
  };
}
