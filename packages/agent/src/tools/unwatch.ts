import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat, Mentioned } from '@listener/chat';
import type { Logger } from 'pino';
import { Type } from 'typebox';

const unwatchParameters = Type.Object({
  ms: Type.Integer({ minimum: 0 }),
});

type Reason = 'timeout' | 'event' | 'abort';

export function unwatch(
  chat: Chat,
  signal: AbortSignal,
  mentioned: Mentioned,
  parent: Logger,
): AgentTool<typeof unwatchParameters> {
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
    async execute(toolCallId, params) {
      const log = parent.child({ tool: 'unwatch', toolCallId });
      const doLog = (reason: Reason) => {
        log.info({ ms: params.ms, reason });
        return { content: [], details: undefined };
      };

      if (signal.aborted) {
        return doLog('abort');
      }
      if (hits(chat.unreadMentioned)) {
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
      const off = chat.on(payload => {
        if (!hits(payload.mentioned)) return;
        finish('event');
      });
      const timer = setTimeout(() => finish('timeout'), params.ms);
      signal.addEventListener('abort', onAbort, { once: true });

      const reason = await promise;
      return doLog(reason);
    },
  };
}
