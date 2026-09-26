import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay,setImmediate as flush} from 'node:timers/promises';
import {Listener} from '../src/listener.js';
import {GroupRouter} from '../src/group-router.js';
import {OWNER_ID,type Api,type ChatMessage,type Completion,type JsonObject,type Memory,type Model,type TimelineEntry,type ToolDefinition} from '../src/contracts.js';
import type {ListenerConfig} from '../src/listener-config.js';

const GROUP='22',SELF='99999',A='111';
const tools:NonNullable<ListenerConfig['tools']>={members:true,mention:true,reactions:true,moderation:{mute:'confirm',unmute:'confirm',recall:'confirm',memberCard:'confirm',confirmationTtlSeconds:60,maxMuteSeconds:600}};
const base:ListenerConfig={groupId:GROUP,enabled:true,baseUrl:'https://example.invalid/v1',apiKey:'fixture',model:'fixture',timeoutMs:2000,maxTokens:128,debounceMs:3,delayMaxMs:3,cooldownMs:0,memoryPath:':memory:',maxContextChars:8000,retentionDays:7,randomReplyProbability:0,attention:{enabled:true,maxPlans:16},tools};
const text=(value:string)=>({type:'text',data:{text:value}});
function event(id:string,direct=true,body=`body-${id}`,user=A){return {post_type:'message',message_type:'group',group_id:GROUP,self_id:SELF,user_id:user,message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'fixture'},message:[...(direct?[{type:'at',data:{qq:SELF}}]:[]),text(body)]};}
const row=(messageId:string):TimelineEntry=>({messageId,userId:A,nickname:'fixture',time:Math.floor(Date.now()/1000),text:`body-${messageId}`});
const notice=(id:string,group=GROUP)=>({post_type:'notice',notice_type:'group_msg_emoji_like',group_id:group,message_id:id,likes:[{emoji_id:'76',count:999999}],is_add:true});
const call=(name:string,args:unknown={})=>({id:`call_${name}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
const complete=(...calls:ReturnType<typeof call>[]):Completion=>({content:null,tool_calls:calls.map((c,i)=>({...c,id:`${c.id}_${i}`}))});
const silent=()=>call('finish');
const read=(id:string)=>call('read_message',{message_id:id});
const react=(id='1')=>call('react_message',{message_id:id,emoji_id:'76',action:'add'});
const next=()=>call('manage_attention',{operation:'create',any_of:[{type:'next_message'}],expires_in_seconds:60});
function gate<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
class Mem implements Memory {
 rows:TimelineEntry[]=[];closed=false;rawContexts:string[]=[];compactInputs:string[]=[];
 constructor(readonly summarize=false){ }
 append(entry:TimelineEntry){if(this.closed)throw Error('write after close');if(this.find(entry.messageId))return false;this.rows.push(structuredClone(entry));return true;}
 recent(){return this.rows;}find(id:string){return this.rows.find(e=>e.messageId===id);}
 context(){const value=JSON.stringify({groupId:GROUP,untrusted:true,summary:{untrusted:true,text:'original summary body'},messages:this.rows});this.rawContexts.push(value);return value;}
 async compact(model:Model,signal?:AbortSignal){const source=this.context();this.compactInputs.push(source);if(this.summarize)await model.complete([{role:'system',content:'fixture summary'},{role:'user',content:source}],[],signal);}
 clear(){this.rows=[];}close(){this.closed=true;}
}
type Request={messages:ChatMessage[];tools:ToolDefinition[];index:number};
function setup(options:{settings?:Partial<ListenerConfig>;summarize?:boolean;respond?:(r:Request)=>Completion|Promise<Completion>;api?:(action:string,params:JsonObject,normal:JsonObject)=>unknown|Promise<unknown>}={}){
 const memory=new Mem(options.summarize),requests:Request[]=[],summaries:ChatMessage[][]=[],calls:Array<{action:string;params:JsonObject}>=[],counts=new Map<string,number>(),wire=new Map<string,ReturnType<typeof event>>();
 const cfg={...base,...options.settings};
 const api:Api={async call(action,params={}){
  calls.push({action,params});const id=String(params.message_id),entry=memory.find(id);
  const normal=action==='get_msg'?{message_type:'group',group_id:cfg.groupId,message_id:id,sender:{user_id:entry?.userId??A},time:Math.floor(Date.now()/1000),message:wire.get(id)?.message??[text(`remote body-${id}`)],emoji_likes_list:[{emoji_id:'76',emoji_type:'1',likes_cnt:String(counts.get(id)??3)}]}:action==='send_group_msg'?{message_id:String(90000+calls.length)}:{result:0};
  if(options.api){const override=await options.api(action,params,normal);if(override!==undefined)return override;}
  if(!['get_msg','set_msg_emoji_like','send_group_msg'].includes(action))throw Error(`unexpected API ${action}`);return normal;
 }};
 const model:Model={async complete(messages,definitions=[]){if(messages[0]?.content==='fixture summary'){summaries.push(structuredClone(messages));return {content:'fixture summary response',tool_calls:[]};}const request={messages:structuredClone(messages),tools:structuredClone(definitions),index:requests.length};requests.push(request);return options.respond?options.respond(request):complete(silent());}};
 const bot=new Listener(api,model,memory,cfg,()=>0.5),router=new GroupRouter([[cfg.groupId!,bot]]);router.setConnected(true);
 return {bot,router,memory,requests,summaries,calls,counts,wire,async receive(value:ReturnType<typeof event>){wire.set(value.message_id,value);await router.receive(value,SELF);},async close(){await router.stop();}};
}
const payload=(r:Request)=>JSON.parse(r.messages.find(m=>m.role==='user')!.content as string);
const context=(r:Request)=>JSON.parse(payload(r).untrusted_group_context);
const snapshot=(s:ReturnType<typeof setup>,id:string)=>(s.bot as any).reactionObservations?.get(id);
const gets=(s:ReturnType<typeof setup>)=>s.calls.filter(c=>c.action==='get_msg');
const results=(r:Request)=>r.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(String(m.content)));
const idle=(s:ReturnType<typeof setup>)=>!(s.bot as any).running&&!(s.bot as any).admission;
async function until(predicate:()=>boolean){for(let n=0;n<400;n++){if(predicate())return;await delay(5);}assert.fail('observation condition timed out');}
const settled=async(s:ReturnType<typeof setup>,count:number)=>until(()=>s.requests.length>=count&&idle(s));

 test('automatic first-turn and history observations are inline without model read requests or memory writes',async()=>{
 const s=setup();try{
  s.memory.append(row('8'));s.counts.set('8',7);await s.receive(event('1'));await settled(s,1);
  assert.deepEqual(new Set(gets(s).map(c=>c.params.message_id)),new Set(['1','8']));assert.equal(s.calls.length,2);
  const first=payload(s.requests[0]!),history=context(s.requests[0]!);assert.equal(first.current_batch.messages[0].reactions.items[0].count,3);assert.equal(first.current_request.reactions.items[0].count,3);
  assert.equal(history.messages.find((m:any)=>m.messageId==='8').reactions.items[0].count,7);assert.deepEqual(history.summary,{untrusted:true,text:'original summary body'});
  assert.ok(history.messages.every((m:any)=>m.reactions.status==='observed'&&!Object.hasOwn(m.reactions,'contains_bot')));assert.deepEqual(first.reaction_state.recent,[]);
  assert.equal(s.memory.rows.length,2);assert.ok(s.memory.rows.every(m=>!Object.hasOwn(m,'reactions')));assert.equal(s.requests.length,1);
 }finally{await s.close();}
});

test('recent own replies and explicit reaction targets survive a busy batch prefetch budget',async()=>{
 const s=setup({settings:{debounceMs:30,delayMaxMs:30},api:(action,params,normal)=>action==='get_msg'&&String(params.message_id)==='50'?{...normal,emoji_likes_list:[]}:undefined});try{
  s.memory.append({...row('8'),userId:SELF,bot:true});s.memory.append({...row('9'),userId:SELF,bot:true});
  for(let i=10;i<40;i++)s.memory.append(row(String(i)));
  s.counts.set('8',5);s.counts.set('9',7);s.counts.set('42',4);
  const ask=event('50',true,'能看到我给你点的reaction吗');ask.message.push({type:'reply',data:{id:'42'}} as any);
  await s.receive(ask);for(let i=51;i<62;i++)await s.receive(event(String(i),false));await settled(s,1);
  assert.equal(gets(s).length,8);const ids=gets(s).map(c=>c.params.message_id);
  for(const id of ['50','42','8','9'])assert.ok(ids.includes(id));
  const history=context(s.requests[0]!);assert.equal(history.messages.find((m:any)=>m.messageId==='8').reactions.items[0].count,5);
  assert.equal(history.messages.find((m:any)=>m.messageId==='9').reactions.items[0].count,7);
  assert.equal(payload(s.requests[0]!).current_request.reactions.status,'empty_snapshot');
  const system=String(s.requests[0]!.messages[0]!.content);assert.match(system,/bot:true/);assert.match(system,/不是用户当前提问那条/);
 }finally{await s.close();}
});

test('automatic observation prefetch is bounded to eight messages with two concurrent RPCs',async()=>{
 let active=0,peak=0;const s=setup({api:async action=>{if(action!=='get_msg')return;active++;peak=Math.max(peak,active);await delay(2);active--;}});try{
  for(let i=1;i<=20;i++)s.memory.append(row(String(i)));await s.receive(event('21'));await settled(s,1);
  assert.equal(gets(s).length,8);assert.equal(peak,2);assert.equal(active,0);assert.ok(gets(s).some(c=>c.params.message_id==='21'));
  const messages=context(s.requests[0]!).messages;assert.equal(messages.length,21);assert.equal(messages.filter((m:any)=>m.reactions).length,8);assert.equal(payload(s.requests[0]!).current_batch.messages[0].reactions.status,'observed');
 }finally{await s.close();}
});

test('read_message returns cached local and verified remote quote annotations, but not errors or foreign IDs',async()=>{
 const s=setup({respond:r=>r.index===0?complete(read('1'),read('42'),read('999')):complete(silent())});try{
  s.counts.set('42',9);const value=event('1');value.message.push({type:'reply',data:{id:'42'}} as any);await s.receive(value);await settled(s,2);
  const returned=results(s.requests[1]!);assert.equal(returned[0].message.messageId,'1');assert.equal(returned[0].message.reactions.items[0].count,3);
  assert.equal(returned[1].message.messageId,'42');assert.equal(returned[1].message.reactions.items[0].count,9);assert.equal(returned[1].message.text,undefined);assert.deepEqual(returned[1].message.segments,[{type:'text',text:'remote body-42'}]);assert.equal(returned[2].error,'message_not_in_context');assert.ok(!returned[2].reactions);
  assert.deepEqual(gets(s).map(c=>c.params.message_id),['1','42','42']);assert.equal(s.memory.rows.length,1);assert.equal(s.memory.find('42'),undefined);assert.ok(!s.memory.context().includes('emoji_id'));
 }finally{await s.close();}
});

test('specific notices routed to a group only mark known snapshots dirty without RPC, history, attention or wake',async()=>{
 const s=setup({respond:r=>r.index===0?complete(next(),silent()):complete(silent())});try{
  await s.receive(event('1'));await settled(s,1);const apiCount=s.calls.length,sequence=(s.bot as any).arrivalSequence,plans=(s.bot as any).attention.snapshot(Date.now());
  await s.router.receive(notice('1','33'),SELF);assert.equal(snapshot(s,'1').status,'observed');
  await s.router.receive(notice('999'),SELF);assert.equal(snapshot(s,'999'),undefined);
  await s.router.receive(notice('1'),SELF);await delay(15);
  assert.equal(s.calls.length,apiCount);assert.equal(s.requests.length,1);assert.equal(s.memory.rows.length,1);assert.equal((s.bot as any).arrivalSequence,sequence);assert.equal((s.bot as any).unread.size,0);assert.deepEqual((s.bot as any).attention.snapshot(Date.now()),plans);
  assert.equal(snapshot(s,'1').status,'stale');assert.equal(snapshot(s,'1').items[0].count,3);
  s.counts.set('1',7);await s.receive(event('2'));await settled(s,2);
  const history=context(s.requests[1]!);assert.equal(history.messages.find((m:any)=>m.messageId==='1').reactions.items[0].count,7);assert.equal(history.messages.find((m:any)=>m.messageId==='1').reactions.status,'observed');assert.ok(!JSON.stringify(history).includes('999999'));assert.equal(s.memory.rows.length,2);
 }finally{await s.close();}
});

test('native writes make old counters stale without optimistic increments and a later local read refreshes them',async()=>{
 let beforeRead:any;const s=setup({respond:r=>{if(r.index===0)return complete(react());if(r.index===1){beforeRead=snapshot(s,'1');return complete(read('1'));}return complete(silent());},api:action=>{if(action==='set_msg_emoji_like')s.counts.set('1',7);}});try{
  await s.receive(event('1'));await settled(s,3);assert.equal(beforeRead.status,'stale');assert.equal(beforeRead.items[0].count,3);assert.ok(!Object.hasOwn(beforeRead,'contains_bot'));
  const returned=results(s.requests[2]!).find(r=>r.message);assert.equal(returned.message.reactions.status,'observed');assert.equal(returned.message.reactions.items[0].count,7);assert.equal(snapshot(s,'1').items[0].count,7);
  assert.equal(gets(s).length,3);assert.equal(s.calls.filter(c=>c.action==='set_msg_emoji_like').length,1);assert.ok(s.memory.rows.every(r=>!Object.hasOwn(r,'reactions')));
 }finally{await s.close();}
});

test('disabled reactions never prefetch and do not decorate any model context',async()=>{
 const s=setup({settings:{tools:{...tools,reactions:false}}});try{
  await s.receive(event('1'));await settled(s,1);await s.router.receive(notice('1'),SELF);await delay(10);assert.equal(s.calls.length,0);assert.equal(s.requests.length,1);
  assert.equal(payload(s.requests[0]!).current_batch.messages[0].reactions,undefined);assert.ok(context(s.requests[0]!).messages.every((m:any)=>!m.reactions));assert.equal(payload(s.requests[0]!).reaction_state,undefined);
 }finally{await s.close();}
});

test('summary sees only original undecorated memory and runs before observation lookups',async()=>{
 const s=setup({summarize:true,api:action=>{if(action==='get_msg')assert.equal(s.summaries.length,1);}});try{
  await s.receive(event('1'));await settled(s,1);assert.equal(s.summaries.length,1);const summarySource=JSON.parse(s.summaries[0]![1]!.content as string);
  assert.deepEqual(summarySource.summary,{untrusted:true,text:'original summary body'});assert.ok(summarySource.messages.every((m:any)=>!Object.hasOwn(m,'reactions')));assert.ok(payload(s.requests[0]!).current_batch.messages[0].reactions);
  assert.ok(s.memory.compactInputs.every(raw=>!raw.includes('emoji_id')));assert.ok(s.memory.rawContexts.every(raw=>!raw.includes('emoji_id')));assert.equal(s.memory.rows.length,1);
 }finally{await s.close();}
});

for(const invalid of ['group','sender','private'] as const)test(`automatic observation refuses ${invalid} provenance mismatch`,async()=>{
 const s=setup({api:(action,_params,normal)=>action==='get_msg'?{...normal,...(invalid==='group'?{group_id:'33'}:invalid==='sender'?{sender:{user_id:'555'}}:{message_type:'private'})}:undefined});try{
  await s.receive(event('1'));await settled(s,1);assert.equal(snapshot(s,'1'),undefined);assert.equal(payload(s.requests[0]!).current_batch.messages[0].reactions,undefined);assert.equal(context(s.requests[0]!).messages[0].reactions,undefined);assert.equal(s.calls.length,1);
 }finally{await s.close();}
});

test('reset aborts automatic prefetch and a late response cannot restore cleared observations',async()=>{
 const held=gate<unknown>();let remote:JsonObject|undefined;const s=setup({api:(action,params,normal)=>{if(action==='get_msg'&&params.message_id==='1'){remote=normal;return held.promise;}}});try{
  await s.receive(event('1'));await until(()=>gets(s).length===1);await s.receive(event('9',false,'/reset',OWNER_ID));await until(()=>idle(s));assert.equal(s.requests.length,0);assert.equal(snapshot(s,'1'),undefined);
  held.resolve(remote);await flush();await flush();assert.equal(snapshot(s,'1'),undefined);assert.equal(s.requests.length,0);
  await s.receive(event('2'));await settled(s,1);assert.equal(payload(s.requests[0]!).current_batch.messages[0].messageId,'2');assert.equal(snapshot(s,'1'),undefined);
 }finally{held.resolve(remote);await s.close();}
});

test('prefetch time budget releases the model and ignores late RPC results',async t=>{
 t.mock.timers.enable({apis:['setTimeout'],now:Date.now()});const held=gate<unknown>();let remote:JsonObject|undefined;
 const s=setup({api:(action,_params,normal)=>{if(action==='get_msg'){remote=normal;return held.promise;}}});try{
  await s.receive(event('1'));t.mock.timers.tick(3);await flush();await flush();assert.equal(gets(s).length,1);assert.equal(s.requests.length,0);
  t.mock.timers.tick(1501);await flush();await flush();assert.equal(s.requests.length,1);assert.ok(idle(s));assert.equal(payload(s.requests[0]!).current_batch.messages[0].reactions,undefined);
  held.resolve(remote);await flush();await flush();assert.equal(snapshot(s,'1'),undefined);assert.equal(s.requests.length,1);
 }finally{held.resolve(remote);await flush();await s.close();t.mock.timers.reset();}
});

test('messages arriving while automatic lookup waits stay outside its frozen scope until the next turn',async()=>{
 const held=gate<unknown>();let remote:JsonObject|undefined;const s=setup({api:(action,params,normal)=>{if(action==='get_msg'&&params.message_id==='1'){remote=normal;return held.promise;}}});try{
  await s.receive(event('1'));await until(()=>gets(s).length===1);await s.receive(event('2',false));held.resolve(remote);await settled(s,1);
  assert.deepEqual(gets(s).map(c=>c.params.message_id),['1']);assert.deepEqual(payload(s.requests[0]!).current_batch.messages.map((m:any)=>m.messageId),['1']);assert.deepEqual(context(s.requests[0]!).messages.map((m:any)=>m.messageId),['1']);assert.equal(snapshot(s,'2'),undefined);
  await s.receive(event('3'));await settled(s,2);assert.ok(gets(s).some(c=>c.params.message_id==='2'));assert.ok(context(s.requests[1]!).messages.find((m:any)=>m.messageId==='2').reactions);
 }finally{held.resolve(remote);await s.close();}
});

test('near-full real reply batches retain every bounded body and provenance instead of overflowing for counters',async()=>{
 const s=setup({settings:{debounceMs:30,delayMaxMs:30}});try{
  for(let i=1;i<=8;i++)await s.receive(event(String(i),true,`${i}:`+'正文'.repeat(3000)));
  const original=(s.bot as any).pending.payload();assert.ok(JSON.stringify(original).length>23900);await settled(s,1);
  const root=payload(s.requests[0]!),projected=Object.fromEntries(Object.keys(original).map(key=>[key,root[key]]));assert.ok(JSON.stringify(projected).length<=24000);
  for(const message of (projected.current_batch as any).messages)delete message.reactions;
  assert.deepEqual(projected,original);assert.equal(s.memory.rows.length,8);
 }finally{await s.close();}
});
