import type { Memory, TimelineEntry } from '../contracts/messages.ts';
import { projectMessage } from '../world/message-content.ts';

/** 在封存的memory之上叠加本轮已发出的消息，使后续工具能看到自己刚发的内容。 */
export function withSentEntries(
  frozen: Memory,
  sentEntries: ReadonlyMap<string, TimelineEntry>,
): Memory {
  return {
    ...frozen,
    recent: () =>
      [...frozen.recent(), ...sentEntries.values()].map((entry) =>
        structuredClone(entry),
      ),
    find: (messageId: string) =>
      sentEntries.get(messageId)
        ? structuredClone(sentEntries.get(messageId)!)
        : frozen.find(messageId),
    context: () => {
      try {
        const parsed = JSON.parse(frozen.context()) as {
          messages?: unknown;
        } | null;
        if (parsed && Array.isArray(parsed.messages)) {
          parsed.messages.push(
            ...[...sentEntries.values()].map((entry) => projectMessage(entry)),
          );
          return JSON.stringify(parsed);
        }
      } catch {}
      return frozen.context();
    },
  };
}
