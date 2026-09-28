import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestTrends, MAX_REQUEST_TREND_POINTS, requestTrendBucketMs } from '../../../src/dashboard/server/request-trends.js';
import { ResourceLimit } from '../../../src/dashboard/server/repository.js';
import { REQUEST_TREND_OUTCOMES } from '../../../src/dashboard/contracts/request-trends.js';
import type { ReviewRequest } from '../../../src/dashboard/contracts/review.js';
import { performanceMetrics } from '../../../src/dashboard/contracts/metrics.js';
const availability = { telemetry: true, sessions: [] };
const row = (startedAt: number, patch: Partial<ReviewRequest> = {}): ReviewRequest => ({
  requestId: 'private-id', groupId: '11', model: 'private-model',
  startedAt, outcome: 'success', durationMs: 0, inputTokens: 0, totalInputTokens: 0,
  cachedInputTokens: 0, outputTokens: 0, tps: null, cacheHitRate: null,
  performance: performanceMetrics([{ started_at: startedAt, ended_at: startedAt, status: 'success', output_tokens: 0 }]),
  ...patch,
} as ReviewRequest);
test('bucket size includes every threshold and changes immediately above it', () => {
  for (const [span, at, after] of [[900000,60000,300000],[10800000,300000,1800000],[86400000,1800000,10800000],[604800000,10800000,86400000]]) {
    assert.equal(requestTrendBucketMs({since: 17, until: 17 + span!}), at);
    assert.equal(requestTrendBucketMs({since: 17, until: 18 + span!}), after);
  }
  assert.equal(requestTrendBucketMs({since: 0, until: 31*86400000}), 86400000);
});
test('clipped boundaries, inclusive until, no empty tail, every outcome conserved without sampling', () => {
  for (const range of [{since:123,until:120000},{since:123,until:120001},{since:60000,until:60000},{since:123,until:123}]) {
    const requests = REQUEST_TREND_OUTCOMES.map((outcome,i) => row(i % 2 ? range.since : range.until, {outcome}));
    const result = buildRequestTrends(range,availability,requests);
    assert.equal(result.points.length, requests.length);
    assert.equal(result.buckets[0]!.bucketStart,range.since);
    assert.equal(result.buckets.at(-1)!.bucketEnd,range.until);
    assert.equal(result.buckets.reduce((n,b)=>n+b.total,0),requests.length);
    for (const outcome of REQUEST_TREND_OUTCOMES) assert.equal(result.buckets.reduce((n,b)=>n+b.counts[outcome],0),1);
    for (const b of result.buckets) {
      assert.ok(b.bucketStart >= range.since && b.bucketEnd <= range.until);
      assert.equal(Object.values(b.counts).reduce((n,v)=>n+v,0),b.total);
      assert.ok(range.since===range.until || b.bucketStart<b.bucketEnd);
    }
    for(let i=1;i<result.buckets.length;i++) assert.equal(result.buckets[i-1]!.bucketEnd,result.buckets[i]!.bucketStart);
  }
  const result=buildRequestTrends({since:123,until:120000},availability,[row(59999),row(60000),row(120000)]);
  assert.deepEqual(result.buckets.map(b=>b.total),[1,2]);
});
test('projection preserves zeros, unknowns, TPS and emits only the compact fields', () => {
  const request = row(100,{durationMs:250,tps:7,inputTokens:null,cachedInputTokens:null,performance:performanceMetrics([])});
  const points=buildRequestTrends({since:0,until:100},availability,[row(0),request]).points;
  assert.deepEqual(points[0],{startedAt:0,outcome:'success',durationMs:0,inputTokens:0,totalInputTokens:0,cachedInputTokens:0,outputTokens:0,tps:null,cacheHitRate:null});
  assert.deepEqual(points[1],{startedAt:100,outcome:'success',durationMs:null,inputTokens:null,totalInputTokens:0,cachedInputTokens:null,outputTokens:0,tps:7,cacheHitRate:null});
});
test('unavailable is not all zero, empty available data is, and point limit throws rather than truncates', () => {
  const range={since:0,until:60000};
  assert.deepEqual(buildRequestTrends(range,{telemetry:false,sessions:[]},[]).buckets,[]);
  assert.equal(buildRequestTrends(range,availability,[]).buckets[0]!.total,0);
  assert.equal(buildRequestTrends(range,availability,Array(MAX_REQUEST_TREND_POINTS).fill(row(0))).points.length,MAX_REQUEST_TREND_POINTS);
  assert.throws(()=>buildRequestTrends(range,availability,Array(MAX_REQUEST_TREND_POINTS+1).fill(row(0))),ResourceLimit);
});
