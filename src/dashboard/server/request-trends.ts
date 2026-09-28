import type { Availability, Range } from '../contracts/contracts.js';
import type { ReviewRequest } from '../contracts/review.js';
import type { RequestTrendBucket, RequestTrendsResponse } from '../contracts/request-trends.js';
import { ResourceLimit } from './repository.js';

/** Same hard ceiling as ReviewRepository: never return a silently sampled scatter plot. */
export const MAX_REQUEST_TREND_POINTS = 10000;
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
export function requestTrendBucketMs(range: Range): number {
  const span = range.until - range.since;
  return span <= 15 * MINUTE ? MINUTE : span <= 3 * 60 * MINUTE ? 5 * MINUTE :
    span <= DAY ? 30 * MINUTE : span <= 7 * DAY ? 3 * 60 * MINUTE : DAY;
}
/** Pure projection of already authorized, bounded ReviewRepository rows. */
export function buildRequestTrends(range: Range, availability: Availability, requests: readonly ReviewRequest[]): RequestTrendsResponse {
  if (requests.length > MAX_REQUEST_TREND_POINTS) throw new ResourceLimit();
  const bucketMs = requestTrendBucketMs(range);
  const points = requests.map(r => ({
    startedAt: r.startedAt, outcome: r.outcome,
    // A display fallback duration must not imply a known request interval.
    durationMs: r.performance.coverage.modelIntervalRequests === 1 ? r.durationMs : null,
    inputTokens: r.inputTokens, totalInputTokens: r.totalInputTokens,
    cachedInputTokens: r.cachedInputTokens, outputTokens: r.outputTokens, tps: r.tps, cacheHitRate: r.cacheHitRate,
  }));
  const buckets: RequestTrendBucket[] = [];
  if (availability.telemetry) {
    const first = Math.floor(range.since / bucketMs) * bucketMs;
    // ceil prevents an empty tail when until is exactly a bucket boundary.
    const count = Math.max(1, Math.ceil((range.until - first) / bucketMs));
    for (let i = 0; i < count; i++) buckets.push({
      bucketStart: Math.max(range.since, first + i * bucketMs),
      bucketEnd: Math.min(range.until, first + (i + 1) * bucketMs),
      counts: { running: 0, interrupted: 0, success: 0, failed: 0, timeout: 0, cancelled: 0, unknown: 0 },
      total: 0,
    });
    for (const point of points) {
      const index = Math.min(count - 1, Math.floor((point.startedAt - first) / bucketMs));
      const bucket = buckets[index];
      // Route queries are inclusive and already scoped; never count an out-of-range row.
      if (!bucket || point.startedAt < range.since || point.startedAt > range.until) continue;
      bucket.counts[point.outcome]++;
      bucket.total++;
    }
  }
  return { range, availability, points, bucketMs, buckets };
}
