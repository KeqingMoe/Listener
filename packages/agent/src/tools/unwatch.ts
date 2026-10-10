import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat, Mentioned } from '@listener/chat';
import { Type } from 'typebox';

const unwatchParameters = Type.Object({
  ms: Type.Integer({ minimum: 0 }),
});

export type UnwatchResult = {
  reason: 'timeout' | 'event' | 'abort';
};

export function unwatch(
  chat: Chat,
  signal: AbortSignal,
  mentioned: Mentioned,
): AgentTool<typeof unwatchParameters, UnwatchResult> {
  const hits = (arg: Mentioned) =>
    (arg.at && mentioned.at) || (arg.reply && mentioned.reply);
  return {
    name: 'unwatch',
    label: '关群',
    description: [
      '不再盯当前群，',
      'ms 毫秒后回来看未读。',
      mentioned.at || mentioned.reply ? '被提及则提前回来。' : '',
    ].join(''),
    parameters: unwatchParameters,
    executionMode: 'sequential',
    async execute(_, params) {
      const done = (reason: UnwatchResult['reason']) => ({
        content: [],
        details: { reason },
      });

      if (signal.aborted) return done('abort');
      if (hits(chat.unreadMentioned)) {
        return done('event');
      }

      const reason = await new Promise<UnwatchResult['reason']>(resolve => {
        const finish = (why: UnwatchResult['reason']) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          off();
          resolve(why);
        };

        const onAbort = () => finish('abort');
        const off = chat.on(payload => {
          if (!hits(payload.mentioned)) return;
          finish('event');
        });
        const timer = setTimeout(() => finish('timeout'), params.ms);
        signal.addEventListener('abort', onAbort, { once: true });
      });

      return done(reason);
    },
  };
}
