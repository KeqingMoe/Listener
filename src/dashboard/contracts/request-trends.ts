import type { Availability, Range } from './contracts.ts';
import type { ReviewRequest } from './review.ts';

export type RequestTrendOutcome = ReviewRequest['outcome'];

export const REQUEST_TREND_OUTCOMES = [
  'running',
  'interrupted',
  'success',
  'failed',
  'timeout',
  'cancelled',
  'unknown',
] as const satisfies readonly RequestTrendOutcome[];

/** 单个未经采样的请求，不含标识符、模型、诊断信息或内容。未知值为null而非0。 */
export type RequestTrendPoint = Pick<
  ReviewRequest,
  | 'startedAt'
  | 'outcome'
  | 'durationMs'
  | 'inputTokens'
  | 'totalInputTokens'
  | 'cachedInputTokens'
  | 'outputTokens'
  | 'tps'
  | 'ttftMs'
  | 'cacheHitRate'
>;

export interface RequestTrendBucket {
  bucketStart: number;
  bucketEnd: number;
  counts: Record<RequestTrendOutcome, number>;
  total: number;
}

/** key是由已授权group id与request id组成的JSON元组，稳定且不会冲突。 */
export type RequestTrendSyncPoint = RequestTrendPoint & { key: string };

export interface RequestTrendsSyncResponse extends Omit<
  RequestTrendsResponse,
  'points'
> {
  mode: 'snapshot' | 'delta';
  cursor: string;
  /** snapshot模式为完整点集；delta模式为需要替换的key。 */
  upserts: RequestTrendSyncPoint[];
  removals: string[];
}

/** GET /api/request-trends?since&until&groupId，需认证，范围不超过31天。 */
export interface RequestTrendsResponse {
  range: Range;
  availability: Availability;
  points: RequestTrendPoint[];
  bucketMs: number;
  /**
   * 按epoch对齐并裁剪到范围内的桶。最后一个桶包含until；零宽范围只有一个桶。
   * 遥测不可用时不返回桶，而不是伪造零计数。
   */
  buckets: RequestTrendBucket[];
}
