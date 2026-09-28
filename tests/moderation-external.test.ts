import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLogging } from '../src/observability/logger.js';
import { submittedResult } from '../src/onebot/operation-result.js';
import { Moderation, type ExternalModerationProposal } from '../src/tools/management/moderation.js';
import { LISTENER_GROUP, OWNER_ID } from '../src/contracts/identity.js';
import { type Api } from '../src/contracts/onebot.js';
import { type JsonObject } from '../src/contracts/json.js';
import { type TurnContext } from '../src/contracts/tools.js';

const selfId = '999', actorId = '123', targetId = '456';
const original: TurnContext = {groupId:LISTENER_GROUP,actorId,selfId,messageId:'11'};
const owner: TurnContext = {...original,actorId:OWNER_ID,messageId:'22'};
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
function fixture(options: ConstructorParameters<typeof Moderation>[2] = {}) {
  let now=1000;
  const calls:Array<{action:string;params?:JsonObject}>=[];
  const api:Api={async call(action,params){
    calls.push({action,params});
    if(action==='get_login_info')return {user_id:selfId};
    if(action==='get_group_member_info')return {group_id:LISTENER_GROUP,user_id:params!.user_id,role:params!.user_id===selfId?'admin':'member'};
    return null;
  }};
  return {api,calls,moderation:new Moderation(api,()=>now,options),setNow(value:number){now=value;}};
}
function input(execute: ExternalModerationProposal['execute'] = async()=>({status:'executed'})):ExternalModerationProposal {
  return {name:'kick_member',description:'移出本群 QQ 456（不拒绝重新申请）',execute};
}
function proposal(moderation:Moderation, execute?:ExternalModerationProposal['execute'], signal?:AbortSignal):string {
  const result=moderation.requestExternal(input(execute),original,signal);
  assert.equal(result.status,'confirmation_required');assert.match(result.code as string,/^[0-9a-f]{32}$/);
  return result.code as string;
}

test('external proposal uses default group and existing confirmation protocol without RPC or execution',async()=>{
  const f=fixture({confirmationTtlSeconds:7});let invoked=0;
  const r=f.moderation.requestExternal(input(async()=>{invoked++;return {status:'unknown'};}),original);
  assert.deepEqual(Object.keys(r).sort(),['code','description','expires_in_seconds','status']);
  assert.match(r.code as string,/^[a-f0-9]{32}$/);assert.equal(r.expires_in_seconds,7);
  assert.equal(r.description,`群 ${LISTENER_GROUP}：移出本群 QQ 456（不拒绝重新申请）`);
  assert.equal(invoked,0);assert.equal(f.calls.length,0);
  assert.deepEqual(await f.moderation.confirm(r.code as string,owner),{status:'unknown'});
  assert.equal(invoked,1);
});

test('scope validation rejects malformed group actor self and message identities before queuing',()=>{
  const f=fixture();
  for(const context of [ {...original,groupId:'888'}, {...original,actorId:'0'}, {...original,actorId:' 123'}, {...original,selfId:OWNER_ID}, {...original,selfId:'0'}, {...original,messageId:'01'}, {...original,messageId:'9007199254740992'} ]){
    assert.equal(f.moderation.requestExternal(input(),context).error,'forbidden_context');
  }
  assert.equal(f.calls.length,0);
});

test('external input rejects unknown fields accessors and unsafe metadata without invoking getters',()=>{
  const f=fixture();let reads=0;
  const getter={...input()};Object.defineProperty(getter,'description',{enumerable:true,get(){reads++;return 'secret';}});
  for(const value of [getter,{...input(),extra:true},{...input(),name:'other/api'},{...input(),description:''},{...input(),description:'secret\0'},{...input(),description:'x'.repeat(4097)},{...input(),execute:null},Object.create(input())]){
    assert.equal(f.moderation.requestExternal(value as ExternalModerationProposal,original).error,'invalid_arguments');
  }
  assert.equal(reads,0);assert.equal(f.calls.length,0);
});

test('metadata and context are copied and confirmation uses the new owner command context',async()=>{
  const f=fixture();let received:TurnContext|undefined;
  const info=input(async context=>{received=context;return {status:'executed'};});
  const context={...original};
  const p=f.moderation.requestExternal(info,context);info.name='changed';info.description='changed';info.execute=async()=>({status:'error'});context.selfId='444';
  assert.deepEqual(await f.moderation.confirm(p.code as string,owner),{status:'executed'});
  assert.deepEqual(received,owner);
});

test('nonowner wrong group and wrong self never consume another owners valid code',async()=>{
  const f=fixture();let invoked=0;const code=proposal(f.moderation,async()=>{invoked++;return {status:'executed'};});
  for(const context of [original,{...owner,groupId:'888'},{...owner,selfId:'777'}])assert.equal((await f.moderation.confirm(code,context)).status,'error');
  assert.equal(invoked,0);assert.deepEqual(await f.moderation.confirm(code,owner),{status:'executed'});assert.equal(invoked,1);
  assert.equal((await f.moderation.confirm(code,owner)).error,'confirmation_denied');
});

test('expired and cancelled proposals are single use and do not execute',async()=>{
  const f=fixture({confirmationTtlSeconds:1});let writes=0;const code=proposal(f.moderation,async()=>{writes++;return {status:'executed'};});
  f.setNow(2000);assert.equal((await f.moderation.confirm(code,owner)).error,'confirmation_expired');
  assert.equal((await f.moderation.confirm(code,owner)).error,'confirmation_denied');assert.equal(writes,0);
  const next=proposal(f.moderation);assert.equal(f.moderation.cancelPending(next),true);assert.equal(f.moderation.cancelPending(next),false);
  assert.equal((await f.moderation.confirm(next,owner)).error,'confirmation_denied');
});

test('proposal signal is checked only when queuing and not retained for later owner confirmation',async()=>{
  const f=fixture();const oldWake=new AbortController();const code=proposal(f.moderation,undefined,oldWake.signal);
  oldWake.abort('sensitive wake reason');
  assert.equal(f.moderation.requestExternal(input(),original,oldWake.signal).error,'cancelled');
  assert.deepEqual(await f.moderation.confirm(code,owner),{status:'executed'});
});

test('shared pending capacity includes legacy and external proposals and expires without RPC',async()=>{
  const f=fixture({mute:'confirm',confirmationTtlSeconds:1});
  const legacy=await f.moderation.request('mute_member',{user_id:targetId,seconds:1},original);assert.equal(legacy.status,'confirmation_required');
  for(let n=0;n<9;n++)proposal(f.moderation);
  assert.equal(f.moderation.requestExternal(input(),original).error,'confirmation_limit');
  const reads=f.calls.length;assert.equal((await f.moderation.request('mute_member',{user_id:targetId,seconds:1},original)).error,'confirmation_limit');assert.equal(f.calls.length,reads);
  f.setNow(2000);proposal(f.moderation);assert.equal(f.calls.length,reads);
});

test('legacy async preflight cannot overfill capacity when external proposals fill the queue',async()=>{
  const f=fixture({mute:'confirm'}),proof=deferred<unknown>();
  const m=new Moderation({call:(action,params)=>action==='get_login_info'?proof.promise:f.api.call(action,params)},()=>1000,{mute:'confirm'});
  for(let n=0;n<9;n++)proposal(m);
  const legacy=m.request('mute_member',{user_id:targetId,seconds:1},original);
  proposal(m);proof.resolve({user_id:selfId});
  assert.equal((await legacy).error,'confirmation_limit');
  assert.equal(f.calls.some(call=>call.action==='set_group_ban'),false);
});

test('concurrent confirmations consume before the callback first await and cannot execute twice',async()=>{
  const f=fixture(),gate=deferred<JsonObject>();let invoked=0;
  const code=proposal(f.moderation,async()=>{invoked++;return gate.promise;});
  const first=f.moderation.confirm(code,owner),second=f.moderation.confirm(code,owner);
  assert.equal((await second).error,'confirmation_denied');assert.equal(invoked,1);
  assert.equal(f.moderation.cancelPending(code),false);gate.resolve({status:'executed'});
  assert.deepEqual(await first,{status:'executed'});
});

test('confirmation TTL aborts the callback while permission verification awaits and prevents a write',async()=>{
  const f=fixture({confirmationTtlSeconds:1});let writes=0,seen:AbortSignal|undefined;
  const code=proposal(f.moderation,async(_context,signal)=>{seen=signal;await delay(30);if(signal.aborted)return {status:'error',error:'cancelled'};writes++;return {status:'executed'};});
  f.setNow(1990);assert.equal((await f.moderation.confirm(code,owner)).status,'error');assert.equal(seen!.aborted,true);assert.equal(writes,0);
});

test('dispose aborts an active confirmation and prevents later writes after verification',async()=>{
  const f=fixture(),read=deferred<void>();let signalSeen:AbortSignal|undefined,writes=0;
  const code=proposal(f.moderation,async(_context,signal)=>{signalSeen=signal;await read.promise;if(signal.aborted)return {status:'error',error:'cancelled'};writes++;return {status:'executed'};});
  const confirmed=f.moderation.confirm(code,owner);f.moderation.dispose();assert.equal(signalSeen!.aborted,true);read.resolve();
  assert.equal((await confirmed).status,'error');assert.equal(writes,0);assert.equal(f.moderation.requestExternal(input(),original).error,'cancelled');
});

test('caller cancellation has fresh lifetime and pre-aborted confirmation does not consume code',async()=>{
  const f=fixture(),cancel=new AbortController();cancel.abort();const code=proposal(f.moderation);
  assert.equal((await f.moderation.confirm(code,owner,cancel.signal)).error,'cancelled');
  assert.deepEqual(await f.moderation.confirm(code,owner),{status:'executed'});
  const controller=new AbortController(),gate=deferred<void>();let seen:AbortSignal|undefined;
  const next=proposal(f.moderation,async(_c,signal)=>{seen=signal;await gate.promise;return {status:'error',error:'cancelled'};});
  const pending=f.moderation.confirm(next,owner,controller.signal);controller.abort('SECRET');assert.equal(seen!.aborted,true);gate.resolve();assert.equal((await pending).status,'error');
});

test('late real acknowledgement and unknown survive cancellation dispose and deadline',async()=>{
  for(const result of [{status:'executed',message_id:'55'},{status:'unknown',error:'delivery_unknown'}]){
    const f=fixture({confirmationTtlSeconds:1}),gate=deferred<JsonObject>();let writes=0,seen:AbortSignal|undefined;
    const code=proposal(f.moderation,async(_context,signal)=>{writes++;seen=signal;return gate.promise;});f.setNow(1990);
    const confirmed=f.moderation.confirm(code,owner);await delay(20);assert.equal(seen!.aborted,true);f.moderation.dispose();gate.resolve(result);
    assert.deepEqual(await confirmed,result);assert.equal(writes,1);
  }
});

test('opaque callback exceptions malformed results and rejection reasons never leak secrets',async()=>{
  const f=fixture();
  for(const execute of [async()=>{throw new Error('https://secret/PRIVATE');},async()=>({status:'https://secret/PRIVATE'}),async()=>null as unknown as JsonObject]){
    const code=proposal(f.moderation,execute);assert.deepEqual(await f.moderation.confirm(code,owner),{status:'unknown',error:'delivery_unknown',effect_unknown:true,retry_allowed:false});
  }
  for(const code of ['PRIVATE','A'.repeat(32),'0'.repeat(31)])assert.deepEqual(await f.moderation.confirm(code,owner),{status:'error',error:'confirmation_denied'});
});

test('external audit retains tool and trusted context but never confirmation codes descriptions or exceptions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moderation-external-audit-'));
  const logger=configureLogging({level:'debug',console:false,file:true,directory,retentionDays:1,maxFileMb:1,maxTotalMb:2});
  try {
    const f=fixture(),p=f.moderation.requestExternal({...input(),description:'PRIVATE-description',execute:async()=>{throw new Error('PRIVATE-exception');}},original);
    await f.moderation.confirm(p.code as string,owner);await logger.flush();
    const content=(await Promise.all((await readdir(directory)).map(name=>readFile(join(directory,name),'utf8')))).join('');
    assert.doesNotMatch(content,/PRIVATE/);assert.equal(content.includes(p.code as string),false);
    const rows=content.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as JsonObject);
    assert.ok(rows.some(row=>row.action==='kick_member'&&row.group_id===LISTENER_GROUP&&row.phase==='confirm'&&row.actor_id===OWNER_ID));
  } finally {await logger.close();await rm(directory,{recursive:true,force:true});}
});

test('external confirmation submission stays a submission in the shared queue and sanitized audit',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moderation-submitted-audit-'));
 const logger=configureLogging({level:'debug',console:false,file:true,directory,retentionDays:1,maxFileMb:1,maxTotalMb:2});
 try{
  const f=fixture(),result=submittedResult({action:'kick_member'});
  const code=proposal(f.moderation,async()=>result);
  assert.deepEqual(await f.moderation.confirm(code,owner),result);
  assert.equal((await f.moderation.confirm(code,owner)).status,'error');
  await logger.flush();
  const content=(await Promise.all((await readdir(directory)).map(name=>readFile(join(directory,name),'utf8')))).join('');
  const rows=content.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as JsonObject);
  assert.ok(rows.some(row=>row.action==='kick_member'&&row.phase==='confirm'&&row.outcome==='submitted'));
  assert.ok(!rows.some(row=>row.action==='kick_member'&&row.outcome==='executed'));
  assert.equal(content.includes(code),false);
 }finally{await logger.close();await rm(directory,{recursive:true,force:true});}
});

test('legacy confirmations still execute and disposal still revokes both kinds of pending code',async()=>{
  const f=fixture({mute:'confirm'});const p=await f.moderation.request('mute_member',{user_id:targetId,seconds:5},original);
  assert.deepEqual(await f.moderation.confirm(p.code as string,owner),{status:'executed'});
  assert.deepEqual(f.calls.at(-1),{action:'set_group_ban',params:{group_id:LISTENER_GROUP,user_id:targetId,duration:5}});
  const external=proposal(f.moderation);const legacy=await f.moderation.request('mute_member',{user_id:targetId,seconds:5},original);f.moderation.dispose();
  assert.equal((await f.moderation.confirm(external,owner)).error,'cancelled');assert.equal((await f.moderation.confirm(legacy.code as string,owner)).error,'cancelled');
});
