import type { WakeDeliveryBatch } from '../contracts/review.ts';

export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function contextUpdate(content: unknown) {
  try {
    const value: unknown =
      typeof content === 'string' ? JSON.parse(content) : content;
    const update = record(record(value)?.context_update);
    return update && Array.isArray(update.items) ? update : null;
  } catch {
    return null;
  }
}

export const counter = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
export const sequence = (value: unknown): number | null => {
  const n = counter(value);
  return n !== null && n > 0 ? n : null;
};

export interface DeliveryRead {
  seq: number | null;
  sessionId: string | null;
  wakeId: string | null;
  payload: unknown;
  createdAt: number | null;
  complete: boolean;
}

/** No timestamps or input_checkpoint heuristics. Legacy matching requires the entire snapshot. */
export function matchDeliveryReads(
  batches: WakeDeliveryBatch[],
  reads: DeliveryRead[],
  complete: boolean,
): void {
  const scope = (a: WakeDeliveryBatch, b: DeliveryRead) =>
    a.sessionId !== null &&
    a.wakeId !== null &&
    a.sessionId === b.sessionId &&
    a.wakeId === b.wakeId;
  const sameWatermark = (a: WakeDeliveryBatch, b: DeliveryRead) =>
    a.readThrough !== null &&
    a.readThrough === counter(record(b.payload)?.read_through);
  for (const batch of batches) {
    if (batch.messageSeq === null || batch.contentTruncated) {
      continue;
    }
    const candidates = reads.filter(
      (r) =>
        scope(batch, r) && record(r.payload)?.message_seq === batch.messageSeq,
    );
    if (candidates.length !== 1) {
      continue;
    }
    const read = candidates[0]!;
    if (
      read.complete &&
      read.seq !== null &&
      sameWatermark(batch, read) &&
      batches.filter(
        (b) =>
          b.sessionId === batch.sessionId &&
          b.wakeId === batch.wakeId &&
          b.messageSeq === batch.messageSeq,
      ).length === 1
    ) {
      batch.createdAt = read.createdAt;
    }
  }
  if (!complete) {
    return;
  }
  for (const batch of batches) {
    const bs = batches.filter(
      (b) => b.sessionId === batch.sessionId && b.wakeId === batch.wakeId,
    );
    const rs = reads.filter((r) => scope(batch, r));
    // Mixed new/legacy evidence must not weaken the explicit-sequence rule.
    if (
      rs.some(
        (r) =>
          !r.complete ||
          !record(r.payload) ||
          'message_seq' in record(r.payload)! ||
          r.seq === null,
      ) ||
      bs.some((b) => b.contentTruncated || b.messageSeq === null) ||
      bs.length !== rs.length ||
      new Set(bs.map((b) => b.messageSeq)).size !== bs.length ||
      new Set(rs.map((r) => r.seq)).size !== rs.length
    ) {
      continue;
    }
    bs.sort((a, b) => a.messageSeq! - b.messageSeq!);
    rs.sort((a, b) => a.seq! - b.seq!);
    if (bs.every((b, i) => sameWatermark(b, rs[i]!))) {
      bs.forEach((b, i) => {
        b.createdAt = rs[i]!.createdAt;
      });
    }
  }
}
