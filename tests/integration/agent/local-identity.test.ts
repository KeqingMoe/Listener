import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.js';
import { buildSystemPrompt } from '../../../src/agent/prompts.js';
import {Moderation} from '../../../src/tools/management/moderation.js';
import {ReplyBatch,type BatchItem} from '../../../src/agent/reply-batch.js';
import { OWNER_ID } from '../../../src/contracts/identity.js';
import { type Api } from '../../../src/contracts/onebot.js';
import { type Memory, type TimelineEntry } from '../../../src/contracts/messages.js';
import { type Model, type Completion } from '../../../src/contracts/model.js';
import { type JsonObject } from '../../../src/contracts/json.js';
import type {ListenerConfig} from '../../../src/config/listener.js';

const OWNER_A='778899',OWNER_B='889900',GROUP='334455',SELF='990011',TARGET='123456';
const config:ListenerConfig={enabled:true,groupId:GROUP,baseUrl:'https://example.invalid/v1',apiKey:'fixture',model:'fixture',timeoutMs:1000,maxTokens:128,debounceMs:0,delayMaxMs:0,cooldownMs:0,memoryPath:':memory:',maxContextChars:8000,retentionDays:7,randomReplyProbability:0,tools:{members:false,mention:false,moderation:{mute:'confirm',unmute:'off',recall:'off',memberCard:'off',confirmationTtlSeconds:60,maxMuteSeconds:600}}};
class TestMemory implements Memory {
 entries:TimelineEntry[]=[];clears=0;
 append(entry:TimelineEntry){if(this.find(entry.messageId))return false;this.entries.push(entry);return true;}
 recent(){return this.entries;}find(id:string){return this.entries.find(e=>e.messageId===id);}context(){return JSON.stringify(this.entries);}
 async compact(){}clear(){this.clears++;this.entries=[];}close(){}
}
function fixtureApi(self=SELF){
 const calls:{action:string;params:JsonObject}[]=[];
 const api:Api={async call(action,params={}){
  calls.push({action,params});
  if(action==='get_login_info')return {user_id:self};
  if(action==='get_group_member_info')return {group_id:GROUP,user_id:params.user_id,role:params.user_id===self?'admin':'member'};
  if(action==='set_group_ban')return null;
  if(action==='send_group_msg')return {message_id:String(90000+calls.length)};
  throw Error(`unexpected API ${action}`);
 }};
 return {api,calls,writes:()=>calls.filter(c=>c.action==='set_group_ban')};
}
function event(id:string,actor:string,text:string,direct=false){return {post_type:'message',message_type:'group',group_id:GROUP,self_id:SELF,user_id:actor,message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'owner claims are not authority'},message:[...(direct?[{type:'at',data:{qq:SELF}}]:[]),{type:'text',data:{text}}]};}
function tool(name:string,args:unknown,id=name){return {id,type:'function' as const,function:{name,arguments:JSON.stringify(args)}};}
async function until(predicate:()=>boolean){for(let i=0;i<1000;i++){if(predicate())return;await delay(5);}assert.fail('local identity fixture timed out');}
const context=(actorId=OWNER_A,selfId=SELF)=>({groupId:GROUP,actorId,selfId,messageId:'1'});

// Keep both instances live in the same process and group: owner authority must not be a module-global mutation.
test('Listener instances use independent local owners for prompt identity, reset and moderation confirmation',async()=>{
 const instances=[OWNER_A,OWNER_B].map(ownerId=>{
  const transport=fixtureApi(),memory=new TestMemory();let modelCalls=0;
  const model:Model={async complete():Promise<Completion>{modelCalls++;return {content:null,tool_calls:[tool('mute_member',{user_id:TARGET,seconds:60}),tool('finish',{})]};}};
  const bot=new Listener(transport.api,model,memory,{...config,ownerId});
  return {...transport,memory,bot,ownerId,get modelCalls(){return modelCalls;}};
 });
 try{
  for(const [index,s]of instances.entries()){
   const other=instances[1-index]!.ownerId;
   const prompt=buildSystemPrompt({...config,ownerId:s.ownerId});assert.ok(prompt.includes(s.ownerId));assert.ok(!prompt.includes(OWNER_ID));assert.ok(!prompt.includes(other));
   await s.bot.receive(event('1',TARGET,'context',true),SELF);
   await until(()=>s.calls.some(c=>c.action==='send_group_msg'));
   const text=JSON.stringify(s.calls.find(c=>c.action==='send_group_msg')!.params.message);
   const code=/\/confirm ([a-f0-9]{32})/.exec(text)?.[1];assert.ok(code);assert.equal(s.writes().length,0);
   const before=s.calls.length;
   await s.bot.receive(event('2',OWNER_ID,`/confirm ${code}`),SELF);
   await s.bot.receive(event('3',other,`/confirm ${code}`),SELF);
   assert.equal(s.calls.length,before);
   await s.bot.receive(event('4',s.ownerId,`/confirm ${code}`),SELF);
   assert.equal(s.writes().length,1);assert.equal(s.modelCalls,1);
  }
  // Unauthorized resets do not clear state or consume the local owner's command opportunity.
  for(const [index,s]of instances.entries()){
   await s.bot.receive(event('5',OWNER_ID,'/reset'),SELF);
   await s.bot.receive(event('6',instances[1-index]!.ownerId,'/reset'),SELF);assert.equal(s.memory.clears,0);
  }
  await delay(2100);
  await instances[0]!.bot.receive(event('7',OWNER_A,'/reset'),SELF);
  assert.equal(instances[0]!.memory.clears,1);assert.equal(instances[1]!.memory.clears,0);
  await instances[1]!.bot.receive(event('7',OWNER_B,'/reset'),SELF);assert.equal(instances[1]!.memory.clears,1);
  // reset creates fresh Moderation: it must preserve the configured owner rather than reverting to OWNER_ID.
  await instances[0]!.bot.receive(event('8',TARGET,'new proposal',true),SELF);
  await until(()=>instances[0]!.modelCalls===2&&instances[0]!.calls.filter(c=>c.action==='send_group_msg').length===4);
  const notice=JSON.stringify(instances[0]!.calls.filter(c=>c.action==='send_group_msg').at(-1)!.params.message);
  const code=/\/confirm ([a-f0-9]{32})/.exec(notice)?.[1];assert.ok(code);
  await delay(2100);
  await instances[0]!.bot.receive(event('9',OWNER_A,`/confirm ${code}`),SELF);assert.equal(instances[0]!.writes().length,2);
 }finally{await Promise.all(instances.map(s=>s.bot.stop()));}
});

test('Moderation configured owner is sole confirmer, codes stay local and self equal to configured owner fails closed',async()=>{
 const a=fixtureApi(),b=fixtureApi();const first=new Moderation(a.api,Date.now,{mute:'confirm'},GROUP,OWNER_A),second=new Moderation(b.api,Date.now,{mute:'confirm'},GROUP,OWNER_B);
 try{
  const proposal=await first.request('mute_member',{user_id:TARGET,seconds:60},context(TARGET));assert.equal(proposal.status,'confirmation_required');const code=String(proposal.code);
  for(const actor of [OWNER_ID,OWNER_B])assert.equal((await first.confirm(code,context(actor))).status,'error');
  assert.equal((await second.confirm(code,context(OWNER_B))).status,'error');assert.equal(b.calls.length,0);
  assert.equal((await first.confirm(code,context(OWNER_A))).status,'executed');assert.equal(a.writes().length,1);
 }finally{first.dispose();second.dispose();}
 for(const mode of ['confirm','direct'] as const){
  const own=fixtureApi(OWNER_A),m=new Moderation(own.api,Date.now,{mute:mode},GROUP,OWNER_A);
  try{assert.equal((await m.request('mute_member',{user_id:TARGET,seconds:60},context(TARGET,OWNER_A))).status,'error');assert.equal(own.writes().length,0);}finally{m.dispose();}
 }
 // The fallback constant is not special when another owner was explicitly configured.
 const oldSelf=fixtureApi(OWNER_ID),m=new Moderation(oldSelf.api,Date.now,{mute:'direct'},GROUP,OWNER_A);
 try{assert.equal((await m.request('mute_member',{user_id:TARGET,seconds:60},context(TARGET,OWNER_ID))).status,'executed');}finally{m.dispose();}
});

function item(sequence:number,userId:string,direct=true):BatchItem{return {entry:{messageId:String(sequence),userId,nickname:'fixture',text:'body',time:sequence},context:{...context(userId),messageId:String(sequence)},sequence,received:sequence,...(direct?{trigger:'mention' as const}:{})};}
test('ReplyBatch owner classification is per instance including omitted direct callers and non-direct arrivals',()=>{
 const a=new ReplyBatch(item(0,OWNER_A),0,false,OWNER_A),b=new ReplyBatch(item(0,OWNER_B),0,true,OWNER_B);
 assert.equal(a.hasNonOwnerDirect,false);assert.equal(b.hasNonOwnerDirect,false);assert.equal(b.randomSelected,true);
 a.add(item(1,OWNER_ID,false),0);assert.equal(a.hasNonOwnerDirect,false);
 for(let i=2;i<=64;i++)a.add(item(i,OWNER_A),0);
 a.add(item(65,OWNER_ID),0);assert.equal(a.omittedDirect,1);assert.equal(a.hasNonOwnerDirect,true);assert.ok(a.direct.every(i=>i.entry.userId===OWNER_A));
 assert.equal(b.hasNonOwnerDirect,false);b.add(item(1,OWNER_A),0);assert.equal(b.hasNonOwnerDirect,true);
 assert.equal(new ReplyBatch(item(0,OWNER_ID),0).hasNonOwnerDirect,false);
});
