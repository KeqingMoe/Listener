import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type Chat, GapId } from '@listener/chat';
import type { Logger } from 'pino';
import { Type } from 'typebox';
import { toolError } from './error';

const readParameters = Type.Object({
  gapId: Type.Integer({ minimum: 0 }),
  side: Type.Union([Type.Literal('earliest'), Type.Literal('latest')]),
  limit: Type.Integer({ minimum: 0 }),
});

export function readEvents(
  chat: Chat,
  parent: Logger,
): AgentTool<typeof readParameters> {
  return {
    name: 'readEvents',
    label: '读事件',
    description: [
      '打开 prompt 里的一条 gap。',
      '一条只能开一次，开过作废；',
      '没揭完会给你新的 gap。',
    ].join(''),
    parameters: readParameters,
    async execute(toolCallId, params) {
      const log = parent.child({ tool: 'readEvents', toolCallId });
      const gapId = GapId(params.gapId);
      if (gapId === undefined) {
        throw new Error(toolError.invalid);
      }
      const events = chat.readEvents({
        gapId,
        side: params.side,
        limit: params.limit,
      });
      log.info({ count: events.length });
      return {
        content: [{ type: 'text', text: JSON.stringify(events) }],
        details: undefined,
      };
    },
  };
}
