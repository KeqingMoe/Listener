import type { Availability, Range } from './contracts.js';
import type { ReviewRequest } from './review.js';

export type RequestTrendOutcome = ReviewRequest['outcome'];
export const REQUEST_TREND_OUTCOMES = ['running', 'interrupted', 'success', 'failed', 'timeout', 'cancelled', 'unknown'] as const satisfies readonly RequestTrendOutcome[];
/** One unsampled request; no identifiers, models, diagnostics or content. Unknown is null, not zero. */
export type RequestTrendPoint = Pick<ReviewRequest,
  'startedAt' | 'outcome' | 'durationMs' | 'inputTokens' | 'totalInputTokens' |
  'cachedInputTokens' | 'outputTokens' | 'tps' | 'ttftMs' | 'cacheHitRate'>;
export interface RequestTrendBucket {
  bucketStart: number;
  bucketEnd: number;
  counts: Record<RequestTrendOutcome, number>;
  total: number;
}
/** GET /api/request-trends?since&until&groupId; authenticated, range <=31 days. */
/** Stable, collision-free JSON tuple of authorized group id and request id. */
export type RequestTrendSyncPoint = RequestTrendPoint & { key: string };
export interface RequestTrendsSyncResponse extends Omit<RequestTrendsResponse, 'points'> {
  mode: 'snapshot' | 'delta';
  cursor: string;
  /** Snapshot: complete point set. Delta: replace these keys. */
  upserts: RequestTrendSyncPoint[];
  removals: string[];
}
export interface RequestTrendsResponse {
  range: Range;
  availability: Availability;
  points: RequestTrendPoint[];
  bucketMs: number;
  /** Clipped epoch-aligned buckets. Last bucket includes until; a zero-width range has one bucket.
   * Unavailable telemetry has no buckets, rather than fabricated zero counts. */
  buckets: RequestTrendBucket[];
}
