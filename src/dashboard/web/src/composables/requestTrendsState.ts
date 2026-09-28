import type { RequestTrendSyncPoint, RequestTrendsResponse, RequestTrendsSyncResponse } from '../../../contracts/request-trends';

export function applyTrendSync(previous: ReadonlyMap<string, RequestTrendSyncPoint>, response: RequestTrendsSyncResponse) {
  const points = response.mode === 'snapshot' ? new Map<string, RequestTrendSyncPoint>() : new Map(previous);
  for (const key of response.removals) points.delete(key);
  for (const point of response.upserts) points.set(point.key, point);
  for (const [key, point] of points) {
    if (point.startedAt < response.range.since || point.startedAt > response.range.until) points.delete(key);
  }
  const data: RequestTrendsResponse = {
    range: response.range, availability: response.availability, bucketMs: response.bucketMs,
    buckets: response.buckets,
    points: [...points.values()].sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key)),
  };
  return { points, data, cursor: response.cursor };
}
