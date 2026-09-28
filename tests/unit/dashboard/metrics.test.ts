import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceMetrics, intervalUnion, intervalDuration } from '../../../src/dashboard/contracts/metrics.js';
import { summarize } from '../../../src/dashboard/server/repository.js';
const request=(start:number,end:number,output:number|null,status='success')=>({started_at:start,ended_at:end,duration_ms:end-start,output_tokens:output,status});
test('cache ratios use the same valid paired samples, retaining zero and unknown usage',()=>{
 const u=summarize([{input_tokens:100,cached_input_tokens:50},{input_tokens:900,cached_input_tokens:null},{input_tokens:200,cached_input_tokens:0},{input_tokens:10,cached_input_tokens:11},{input_tokens:null,cached_input_tokens:20}]);
 assert.equal(u.cacheHitRate,50/300);assert.equal(u.cachedInputTokens,50);assert.equal(u.uncachedInputTokens,250);
 assert.equal(summarize([{input_tokens:100,cached_input_tokens:0}]).cacheHitRate,0);
 assert.equal(summarize([{input_tokens:0,cached_input_tokens:0}]).cacheHitRate,null);
 for (const row of [{input_tokens:null,cached_input_tokens:null},{input_tokens:100,cached_input_tokens:null},{input_tokens:null,cached_input_tokens:20},{input_tokens:10,cached_input_tokens:11}]) {
  const missing=summarize([row]);
  assert.equal(missing.cacheHitRate,null);assert.equal(missing.cachedInputTokens,null);assert.equal(missing.uncachedInputTokens,null);
 }
 const zero=summarize([{input_tokens:0,cached_input_tokens:0}]);
 assert.equal(zero.cachedInputTokens,0);assert.equal(zero.uncachedInputTokens,0);
});
test('TPS is paired output over duration, not average TPS nor all-request cumulative duration',()=>{
 const p=performanceMetrics([request(0,1000,100),request(2000,5000,30),request(6000,10000,99,'error'),request(10000,12000,null)]);
 assert.equal(p.modelTps,130/4);assert.notEqual(p.modelTps,(100+10)/2);assert.equal(p.modelDurationMs,10000);
 assert.equal(p.tpsOutputTokens,130);assert.equal(p.tpsDurationMs,4000);assert.equal(p.coverage.tpsRequests,2);
 assert.equal(p.wallDurationMs,null);assert.equal(p.roundTps,null);assert.equal(p.otherDurationMs,null);
});
test('zero durations preserve paired numerator, invalid or unfinished durations do not fabricate times',()=>{
 const p=performanceMetrics([request(0,0,10),request(0,1000,20),{...request(0,100,30),ended_at:null},{...request(0,200,50),status:'running'},request(20,10,70)]);
 assert.equal(p.modelTps,30);assert.equal(p.modelDurationMs,1000);assert.equal(p.coverage.tpsRequests,2);
 assert.equal(performanceMetrics([request(0,0,10)]).modelTps,null);
 assert.equal(intervalDuration(5,3),null);assert.equal(intervalDuration(null,3),null);
 assert.equal(performanceMetrics([{ended_at:100,duration_ms:50,status:'error'}]).modelDurationMs,50);
 assert.equal(performanceMetrics([{ended_at:100,duration_ms:50,status:'interrupted'}]).modelDurationMs,50);
 assert.equal(performanceMetrics([{ended_at:null,duration_ms:50,status:'interrupted'}]).modelDurationMs,null);
});
test('wake wall decomposition unions overlapping nested intervals; tool sum is not additive wall time',()=>{
 const rows=[request(100,800,70),request(200,400,20),request(700,900,20)];
 const p=performanceMetrics(rows,{attribution:'wake',startedAt:0,finishedAt:1000,sourceComplete:true,tools:[{started_at:300,finished_at:600},{started_at:400,finished_at:500},{started_at:800,finished_at:950}]});
 assert.equal(intervalUnion([[100,800],[200,400],[700,900]]),800);
 assert.equal(p.modelDurationMs,1100);assert.equal(p.modelWallDurationMs,800);assert.equal(p.otherDurationMs,200);
 assert.equal(p.toolDurationMs,550);assert.equal(p.toolWallDurationMs,450);assert.equal(p.wallDurationMs,1000);
 assert.ok(Math.abs(p.modelTps!-100)<1e-10);assert.equal(p.roundTps,110);assert.equal(p.complete,true);
});
test('rotation across wake scope and missing evidence return null, never clamp negative residuals',()=>{
 const options={attribution:'wake' as const,startedAt:100,finishedAt:200,sourceComplete:true};
 const p=performanceMetrics([request(50,300,50)],options);
 assert.equal(p.wallDurationMs,100);assert.equal(p.modelDurationMs,250);assert.equal(p.otherDurationMs,null);assert.equal(p.modelWallDurationMs,null);assert.equal(p.roundTps,null);assert.equal(p.whyIncomplete,'scope_crosses_wake');
 const missing=performanceMetrics([{status:'running',started_at:150}],options);assert.equal(missing.whyIncomplete,'active_or_missing_timestamps');assert.equal(missing.modelDurationMs,null);
 assert.equal(performanceMetrics([],{...options,sourceComplete:false}).otherDurationMs,null);
 assert.equal(performanceMetrics([request(100,150,null)],options).roundTps,null);
 const unknownTool=performanceMetrics([],{...options,tools:[{started_at:120,finished_at:null}]});assert.equal(unknownTool.toolDurationMs,null);assert.equal(unknownTool.toolWallDurationMs,null);assert.equal(unknownTool.coverage.toolDurationTools,0);
});
test('request HTTP time is not a claim about its world or subsequent tool time',()=>{
 const p=performanceMetrics([request(100,300,10,'error')],{attribution:'request'});
 assert.equal(p.wallDurationMs,200);assert.equal(p.modelDurationMs,200);assert.equal(p.modelTps,null);assert.equal(p.otherDurationMs,null);assert.equal(p.toolDurationMs,null);assert.equal(p.roundTps,null);
});
