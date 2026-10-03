import type { ReviewTool } from '../../../../contracts/review';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function deliveryItems(content: unknown): unknown[] {
  let value = content;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const items = record(record(value)?.context_update)?.items;
  return Array.isArray(items) ? items : [];
}

export type DeliveryBlock =
  | { kind: 'events'; events: unknown[] }
  | { kind: 'job' | 'other'; value: unknown };

/** Group adjacent events only. A job remains between its original neighbours. */
export function deliveryBlocks(items: readonly unknown[]): DeliveryBlock[] {
  const blocks: DeliveryBlock[] = [];
  for (const item of items) {
    const row = record(item);
    if (row?.type === 'world_event') {
      const previous = blocks.at(-1);
      if (previous?.kind === 'events') {
        previous.events.push(row.event);
      } else {
        blocks.push({ kind: 'events', events: [row.event] });
      }
    } else {
      blocks.push({
        kind: row?.type === 'job_result' ? 'job' : 'other',
        value: item,
      });
    }
  }
  return blocks;
}

/** An explicit settled receipt, not the finish request or a generic success label. */
export function finishReceipt(tool: ReviewTool): string | null {
  if (tool.name !== 'finish') {
    return null;
  }
  const result = record(tool.result),
    args = record(tool.arguments);
  if (
    tool.state !== 'finished' ||
    tool.outcome !== 'handled' ||
    result?.status !== 'ok' ||
    typeof result.closed !== 'boolean'
  ) {
    return null;
  }
  const mode =
    args?.mode === 'soft' || args?.mode === 'hard' ? args.mode : null;
  const outcome = result.closed
    ? '本轮已关闭'
    : mode === 'soft'
      ? '本轮继续'
      : '本轮未关闭';
  return `关闭回执：${outcome}${mode ? `（${mode}）` : ''}`;
}
