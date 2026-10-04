import type { Availability, Range } from '../contracts/contracts.ts';
import type { ReviewRequest } from '../contracts/review.ts';
import type {
  RequestTrendBucket,
  RequestTrendPoint,
  RequestTrendsResponse,
} from '../contracts/request-trends.ts';
import { ResourceLimit } from './repository.ts';

/** 与ReviewRepository相同的硬上限：超出时报错，绝不悄悄返回采样过的散点图。 */
export const MAX_REQUEST_TREND_POINTS = 10000;
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

export function requestTrendBucketMs(range: Range): number {
  const span = range.until - range.since;
  return span <= 15 * MINUTE
    ? MINUTE
    : span <= 3 * 60 * MINUTE
      ? 5 * MINUTE
      : span <= DAY
        ? 30 * MINUTE
        : span <= 7 * DAY
          ? 3 * 60 * MINUTE
          : DAY;
}

/** 对已授权、有界的ReviewRepository行做纯投影。 */
export function buildRequestTrends(
  range: Range,
  availability: Availability,
  requests: readonly ReviewRequest[],
): RequestTrendsResponse {
  if (requests.length > MAX_REQUEST_TREND_POINTS) {
    throw new ResourceLimit();
  }
  const points = requests.map((r) => ({
    startedAt: r.startedAt,
    outcome: r.outcome,
    // 展示用的回退耗时不能被当作已知的请求区间。
    durationMs:
      r.performance.coverage.modelIntervalRequests === 1 ? r.durationMs : null,
    inputTokens: r.inputTokens,
    totalInputTokens: r.totalInputTokens,
    cachedInputTokens: r.cachedInputTokens,
    outputTokens: r.outputTokens,
    tps: r.tps,
    ttftMs: r.ttftMs,
    reasoningDurationMs: r.reasoningDurationMs,
    reasoningTimingStatus: r.reasoningTimingStatus,
    cacheHitRate: r.cacheHitRate,
  }));
  return buildRequestTrendBuckets(range, availability, points);
}

/** 从有界的、仅含元数据的缓存点集重新精确计算分桶。 */
export function buildRequestTrendBuckets(
  range: Range,
  availability: Availability,
  points: RequestTrendPoint[],
): RequestTrendsResponse {
  if (points.length > MAX_REQUEST_TREND_POINTS) {
    throw new ResourceLimit();
  }
  const bucketMs = requestTrendBucketMs(range);
  const buckets: RequestTrendBucket[] = [];
  if (availability.telemetry) {
    const first = Math.floor(range.since / bucketMs) * bucketMs;
    // 用ceil，until恰好落在桶边界时不会多出一个空的尾桶。
    const count = Math.max(1, Math.ceil((range.until - first) / bucketMs));
    for (let i = 0; i < count; i++) {
      buckets.push({
        bucketStart: Math.max(range.since, first + i * bucketMs),
        bucketEnd: Math.min(range.until, first + (i + 1) * bucketMs),
        counts: {
          running: 0,
          interrupted: 0,
          success: 0,
          failed: 0,
          timeout: 0,
          cancelled: 0,
          unknown: 0,
        },
        total: 0,
      });
    }
    for (const point of points) {
      const index = Math.min(
        count - 1,
        Math.floor((point.startedAt - first) / bucketMs),
      );
      const bucket = buckets[index];
      // 路由查询的范围是闭区间且已限定作用域，这里仍跳过越界的行，绝不计入。
      if (
        !bucket ||
        point.startedAt < range.since ||
        point.startedAt > range.until
      ) {
        continue;
      }
      bucket.counts[point.outcome]++;
      bucket.total++;
    }
  }
  return { range, availability, points, bucketMs, buckets };
}
