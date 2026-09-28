import test from 'node:test';
import assert from 'node:assert/strict';
import { OneBotError } from '../../../src/onebot/client.js';
import { submittedResult, writeFailure, afterDispatch } from '../../../src/onebot/operation-result.js';

test('provider submission is successful without claiming a QQ state or permitting replay',()=>{
  const result=submittedResult({action:'set_group_title',group_id:'123',status:'executed',submitted:false,effect_confirmed:true});
  assert.equal(result.status,'ok');assert.equal(result.submitted,true);assert.equal(result.effect_confirmed,false);
  assert.equal(result.delivery_confirmed,false);assert.equal(result.retry_allowed,false);assert.equal(result.error,undefined);
});
test('only provably unsent and audited pre-handler rejections are definite errors',()=>{
  for(const error of [new OneBotError('unavailable'),new OneBotError('busy'),new OneBotError('api_failed',1400)]){
    const result=writeFailure(error);assert.equal(result.status,'error');assert.equal(result.dispatched,false);
  }
});
test('handler failure 1200 does not claim that a write never happened',()=>{
  const result=writeFailure(new OneBotError('api_failed',1200),'operation_result_unknown');
  assert.equal(result.status,'unknown');assert.equal(result.error,'operation_result_unknown');
  assert.equal(result.provider_reported_failure,true);assert.equal(result.provider_code,1200);
  assert.equal(result.effect_unknown,true);assert.equal(result.dispatched,undefined);assert.equal(result.retry_allowed,false);
});
test('network failures and unmapped provider failures remain genuinely uncertain',()=>{
  for(const error of [new OneBotError('timeout'),new OneBotError('send_failed'),new OneBotError('disconnected'),new OneBotError('stopped'),new OneBotError('api_failed',-1),new OneBotError('api_failed')]){
    assert.equal(writeFailure(error).status,'unknown');assert.equal(writeFailure(error).effect_unknown,true);
  }
});
test('exception bodies and untrusted error-shaped values never reach results',()=>{
  let accesses=0;const forged={get code(){accesses++;throw Error('PRIVATE');}};
  for(const error of [Error('PRIVATE signed URL or token'),forged,'PRIVATE',undefined]){
    const result=writeFailure(error);assert.equal(result.status,'unknown');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  }
  assert.equal(accesses,0);
});
test('a definitely unsent rejection never claims cancellation after dispatch',()=>{
  const result=writeFailure(new OneBotError('unavailable'));
  assert.deepEqual(afterDispatch(result,true),result);
});
test('cancellation adds a fact without rewriting accepted or confirmed outcomes',()=>{
  for(const result of [submittedResult(),{status:'executed',message_id:'123'},{status:'ok',uploaded:true,effect_confirmed:true},{status:'error',error:'provider_rejected'}]){
    assert.deepEqual(afterDispatch(result,true),{...result,cancelled_after_dispatch:true});
    assert.deepEqual(afterDispatch(result,false),result);assert.equal(result.cancelled_after_dispatch,undefined);
  }
});
