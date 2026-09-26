import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay,setImmediate as flush} from 'node:timers/promises';
import {Listener} from '../src/listener.js';
import {OWNER_ID,type Api,type ChatMessage,type Completion,type Memory,type Model,type TimelineEntry,type ToolDefinition} from '../src/contracts.js';
import type {ListenerConfig} from '../src/listener-config.js';

const GROUP='22',SELF='99999',A='111',B='222';
const tools:NonNullable<ListenerConfig['tools']>={members:true,mention:true,reactions:true,moderation:{mute:'confirm',unmute:'confirm',recall:'confirm',memberCard:'confirm',confirmationTtlSeconds:60,maxMuteSeconds:600}};
const base:ListenerConfig={groupId:GROUP,enabled:true,baseUrl:'https://example.invalid/v1',apiKey:'fixture',model:'fixture',timeoutMs:2000,maxTokens:128,debounceMs:3,delayMaxMs:3,cooldownMs:0,memoryPath:':memory:',maxContextChars:8000,retentionDays:7,randomReplyProbability:0,randomCooldownMs:0,randomMaxPerMinute:10,attention:{enabled:true,maxPlans:16},tools};
function gate<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{const abort=()=>reject(new DOMException('cancelled','AbortError'));if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});promise.then(v=>{signal?.removeEventListener('abort',abort);resolve(v);},e=>{signal?.removeEventListener('abort',abort);reject(e);});});}
const call=(name:string,args:unknown={})=>({id:`call_${name}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
const complete=(...calls:ReturnType<typeof call>[]):Completion=>({content:null,tool_calls:calls.map((c,i)=>({...c,id:`${c.id}_${i}`}))});
const silent=()=>call('finish');
const send=(text='fixture reply')=>call('send_message',{segments:[{type:'text',text}]});
const react=(id='1',emoji='76',action:'add'|'remove'='add')=>call('react_message',{message_id:id,emoji_id:emoji,action});
const next=()=>call('manage_attention',{operation:'create',any_of:[{type:'next_message'}],expires_in_seconds:60});
const text=(value:string)=>({type:'text',data:{text:value}});
function event(id:string,user=A,direct=true,body=`body-${id}`,group=GROUP){return {post_type:'message',message_type:'group',group_id:group,self_id:SELF,user_id:user,message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'fixture'},message:[...(direct?[{type:'at',data:{qq:SELF}}]:[]),text(body)]};}
class Mem implements Memory {
 rows:TimelineEntry[]=[];closed=false;
 append(e:TimelineEntry){if(this.closed)throw Error('write after close');if(this.find(e.messageId))return false;this.rows.push(structuredClone(e));return true;}
 recent(){return this.rows;}find(id:string){return this.rows.find(e=>e.messageId===id);}context(){return JSON.stringify({messages:this.rows});}async compact(){}clear(){this.rows=[];}close(){this.closed=true;}
}
type Request={messages:ChatMessage[];tools:ToolDefinition[];signal?:AbortSignal;index:number};
type Wire=ReturnType<typeof event>;
function setup(options:{settings?:Partial<ListenerConfig>;respond?:(r:Request)=>Completion|Promise<Completion>;api?:(action:string,params:Record<string,unknown>)=>unknown|Promise<unknown>}={}){
 const memory=new Mem(),requests:Request[]=[],calls:{action:string;params:Record<string,unknown>}[]=[],wire=new Map<string,Wire>();
 const cfg={...base,...options.settings};
 const api:Api={async call(action,params={}){
  calls.push({action,params});if(options.api){const result=await options.api(action,params);if(result!==undefined)return result;}
  if(action==='get_msg'){const id=String(params.message_id),entry=memory.find(id),original=wire.get(id);return {message_type:'group',group_id:cfg.groupId,message_id:id,sender:{user_id:entry?.userId??A},time:Math.floor(Date.now()/1000),message:original?.message??[text(entry?.text??'verified fixture')]};}
  if(action==='set_msg_emoji_like')return {result:0};
  if(action==='send_group_msg')return {message_id:String(90000+calls.length)};
  if(action==='get_forward_msg')return {messages:[{message_id:'12345678901234567890',sender:{user_id:A,nickname:'quoted'},time:42,message:[text('forward fixture')]}]};
  throw Error(`unexpected API ${action}`);
 }};
 const model:Model={async complete(messages,definitions=[],signal){const r={messages:structuredClone(messages),tools:structuredClone(definitions),signal,index:requests.length};requests.push(r);return options.respond?options.respond(r):complete(silent());}};
 const bot=new Listener(api,model,memory,cfg,()=>0.5,async()=>({dataUrl:'data:image/png;base64,YQ==',width:1,height:1,firstFrameOnly:false}));
 return {bot,memory,requests,calls,wire,async receive(e:Wire){wire.set(e.message_id,e);await bot.receive(e,SELF);},async close(){await bot.stop();}};
}
const payload=(r:Request)=>JSON.parse(r.messages.find(m=>m.role==='user')!.content as string);
const state=(r:Request)=>payload(r).reaction_state;
const plans=(s:ReturnType<typeof setup>):any[]=>((s.bot as any).attention?.snapshot(Date.now())??[]);
const idle=(s:ReturnType<typeof setup>)=>!(s.bot as any).running&&!(s.bot as any).admission;
const mutations=(s:ReturnType<typeof setup>)=>s.calls.filter(c=>c.action==='set_msg_emoji_like');
const sends=(s:ReturnType<typeof setup>)=>s.calls.filter(c=>c.action==='send_group_msg');
async function until(check:()=>boolean){for(let n=0;n<400;n++){if(check())return;await delay(5);}assert.fail('reaction condition timed out');}
const settled=async(s:ReturnType<typeof setup>,count:number)=>until(()=>s.requests.length>=count&&idle(s));
const results=(r:Request)=>r.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(String(m.content)));

test('one batch may react to several people and several emoji without creating fake chat entries',async()=>{
 const s=setup({respond:r=>r.index===0?complete(react('1'),react('2','128077'),silent()):complete(silent())});try{
  await s.receive(event('1',A));await s.receive(event('2',B));await settled(s,1);
  assert.equal(s.requests.length,1);assert.deepEqual(payload(s.requests[0]!).current_batch.messages.map((e:TimelineEntry)=>e.messageId),['1','2']);
  assert.deepEqual(mutations(s).map(c=>c.params),[{message_id:'1',emoji_id:'76',set:true},{message_id:'2',emoji_id:'128077',set:true}]);
  assert.equal(s.memory.rows.length,2);assert.ok(s.memory.rows.every(e=>!e.bot));assert.ok(!s.memory.context().includes('emoji_id'));
  await s.receive(event('3'));await settled(s,2);assert.equal(state(s.requests[1]!).last_turn.outcome,'reacted');assert.equal(state(s.requests[1]!).last_turn.confirmed,2);assert.equal(state(s.requests[1]!).recent.length,2);
 }finally{await s.close();}
});

for(const order of ['before','after'] as const)test(`reaction ${order} send executes before finish and a send after finish is blocked`,async()=>{
 const response=order==='before'?complete(react(),send(),react('1','128077'),silent(),send('must not send')):complete(send(),react(),react('1','128077'),silent(),send('must not send'));
 const s=setup({respond:r=>r.index===0?response:complete(silent())});try{
  await s.receive(event('1'));await settled(s,1);assert.equal(mutations(s).length,2);assert.equal(sends(s).length,1);assert.equal(s.requests.length,1);
  const actions=s.calls.map(c=>c.action);assert.ok(order==='before'?actions.indexOf('set_msg_emoji_like')<actions.indexOf('send_group_msg'):actions.indexOf('send_group_msg')<actions.indexOf('set_msg_emoji_like'));
 }finally{await s.close();}
});

test('finish after reactions and attention commits the plan on normal completion',async()=>{
 const s=setup({respond:r=>r.index===0?complete(react(),next(),silent()):complete(silent())});try{
  await s.receive(event('1'));await settled(s,1);assert.equal(mutations(s).length,1);assert.equal(sends(s).length,0);assert.equal(plans(s).length,1);
  await s.receive(event('2',B,false));await settled(s,2);assert.equal(payload(s.requests[1]!).trigger_kind,'attention');assert.equal(state(s.requests[1]!).last_turn.outcome,'reacted');assert.deepEqual(plans(s),[]);
 }finally{await s.close();}
});

test('reaction-only intermediate round continues to a normal terminal tool',async()=>{
 const s=setup({respond:r=>r.index===0?complete(react(),next()):complete(silent())});try{
  await s.receive(event('1'));await settled(s,2);assert.equal(mutations(s).length,1);assert.equal(plans(s).length,1);assert.equal(results(s.requests[1]!)[0].status,'ok');
 }finally{await s.close();}
});

for(const unknown of [false,true])test(`identical reaction calls are deduplicated even when native result is ${unknown?'unknown':'confirmed'}`,async()=>{
 const s=setup({respond:r=>r.index===0?complete(react(),react(),...(unknown?[react('1','76','remove')]:[])):complete(silent()),api:action=>{if(unknown&&action==='set_msg_emoji_like')throw Error('transport uncertain');}});try{
  await s.receive(event('1'));await settled(s,2);assert.equal(mutations(s).length,1);assert.equal(s.calls.filter(c=>c.action==='get_msg').length,2); // Observation plus fresh mutation verification.
  const returned=results(s.requests[1]!);assert.equal(returned[0].status,unknown?'unknown':'ok');assert.equal(returned[1].duplicate,true);if(unknown){assert.equal(returned[2].duplicate,true);assert.equal(returned[2].requested_action,'remove');}
  await s.receive(event('2'));await settled(s,3);assert.equal(state(s.requests[2]!).last_turn.confirmed,unknown?0:1);assert.equal(state(s.requests[2]!).last_turn.unknown,unknown?1:0);
 }finally{await s.close();}
});

test('add remove add are three intentional operations on one pair',async()=>{
 const s=setup({respond:r=>r.index===0?complete(react(),react('1','76','remove'),react(),silent()):complete(silent())});try{
  await s.receive(event('1'));await settled(s,1);assert.deepEqual(mutations(s).map(c=>c.params.set),[true,false,true]);
  await s.receive(event('2'));await settled(s,2);assert.equal(state(s.requests[1]!).recent.length,1);assert.equal(state(s.requests[1]!).recent[0].action,'add');assert.equal(state(s.requests[1]!).last_turn.confirmed,3);
 }finally{await s.close();}
});

test('frozen reaction scope excludes messages arriving during the active model call',async()=>{
 const held=gate<Completion>();const s=setup({respond:r=>r.index===0?held.promise:complete(silent())});try{
  await s.receive(event('1'));await until(()=>s.requests.length===1);await s.receive(event('2',B,false));
  held.resolve(complete(react('2'),react('1'),silent()));await settled(s,1);assert.deepEqual(mutations(s).map(c=>c.params.message_id),['1']);assert.ok(!s.calls.some(c=>c.action==='get_msg'&&c.params.message_id==='2'));
  await s.receive(event('3'));await settled(s,2);assert.ok(state(s.requests[1]!).last_turn.errors.includes('message_not_in_context'));
 }finally{held.resolve(complete(silent()));await s.close();}
});

test('pure attention wake may react and retains explicitly configured confirmation capabilities',async()=>{
 const s=setup({respond:r=>r.index===0?complete(next(),silent()):r.index===1?complete(react('2'),silent()):complete(silent())});try{
  await s.receive(event('1',OWNER_ID));await settled(s,1);await s.receive(event('2',OWNER_ID,false));await settled(s,2);
  assert.equal(payload(s.requests[1]!).trigger_kind,'attention');assert.equal(payload(s.requests[1]!).trusted_moderation_allowed,undefined);
  assert.deepEqual(payload(s.requests[1]!).moderation_capabilities,{mute:'confirm',unmute:'confirm',recall:'confirm',member_card:'confirm'});
  assert.ok(s.requests[1]!.tools.some(t=>t.function.name==='react_message'));assert.ok(s.requests[1]!.tools.some(t=>t.function.name==='mute_member'));assert.equal(mutations(s).length,1);
  assert.ok(!s.calls.some(c=>['set_group_ban','set_group_card','delete_msg'].includes(c.action)));
 }finally{await s.close();}
});

for(const ending of ['model','prose','timeout'] as const)test(`reaction remains visible but attention is not committed after ${ending} termination`,async t=>{
 if(ending==='timeout')t.mock.timers.enable({apis:['setTimeout'],now:Date.now()});
 const held=gate<Completion>();const s=setup({settings:{wakeTimeoutMs:1000},respond:r=>{if(r.index===0)return complete(next(),react());if(ending==='model')throw Error('model failed');if(ending==='prose')return {content:'ordinary prose',tool_calls:[]};return abortable(held.promise,r.signal);}});try{
  await s.receive(event('1'));if(ending==='timeout'){t.mock.timers.tick(3);await flush();await flush();assert.equal(s.requests.length,2);t.mock.timers.tick(1001);await flush();}else await settled(s,2);
  assert.equal(mutations(s).length,1);assert.deepEqual(plans(s),[]);assert.equal((s.bot as any).recentReactions.size,1);assert.equal((s.bot as any).lastReactionTurn.confirmed,1);
 }finally{held.resolve(complete(silent()));await flush();await s.close();if(ending==='timeout')t.mock.timers.reset();}
});

test('reset during get_msg verification prevents any reaction dispatch',async()=>{
 const held=gate<unknown>();let gets=0;const s=setup({respond:r=>r.index===0?complete(react(),next(),silent()):complete(silent()),api:action=>action==='get_msg'&&++gets===2?held.promise:undefined});try{
  await s.receive(event('1'));await until(()=>gets===2);
  await s.receive(event('2',OWNER_ID,false,'/reset'));held.resolve({message_type:'group',group_id:GROUP,message_id:'1',sender:{user_id:A}});await settled(s,1);
  assert.equal(mutations(s).length,0);assert.deepEqual(plans(s),[]);assert.equal((s.bot as any).recentReactions.size,0);
 }finally{held.resolve({});await s.close();}
});

test('reset after reaction dispatch cannot undo it but clears ledger and prevents later steps',async()=>{
 const held=gate<unknown>();const s=setup({respond:r=>r.index===0?complete(next(),react(),react('1','128077'),send()):complete(silent()),api:action=>action==='set_msg_emoji_like'?held.promise:undefined});try{
  await s.receive(event('1'));await until(()=>mutations(s).length===1);await s.receive(event('2',OWNER_ID,false,'/reset'));held.resolve({result:0});await settled(s,1);
  assert.equal(mutations(s).length,1);assert.deepEqual(plans(s),[]);assert.equal((s.bot as any).recentReactions.size,0);assert.equal((s.bot as any).lastReactionTurn,undefined);assert.equal(sends(s).length,1);
 }finally{held.resolve({result:0});await s.close();}
});

test('disabled reactions remove the schema and reject fabricated tool calls',async()=>{
 const s=setup({settings:{tools:{...tools,reactions:false}},respond:r=>r.index===0?complete(react()):complete(silent())});try{
  await s.receive(event('1'));await settled(s,2);assert.ok(s.requests.every(r=>!r.tools.some(t=>t.function.name==='react_message')));assert.equal(results(s.requests[1]!)[0].error,'tool_disabled');assert.equal(s.calls.length,0);assert.equal(payload(s.requests[0]!).reaction_state,undefined);
 }finally{await s.close();}
});

test('remote foreign group and unsafe long message IDs never reach the mutation API',async()=>{
 const s=setup({respond:r=>r.index===0?complete(react('9007199254740993'),react('1')):complete(silent()),api:action=>action==='get_msg'?{message_type:'group',group_id:'33',message_id:'1',sender:{user_id:A}}:undefined});try{
  await s.receive(event('1'));await settled(s,2);assert.equal(mutations(s).length,0);assert.equal(s.calls.filter(c=>c.action==='get_msg').length,2);assert.deepEqual(results(s.requests[1]!).map(r=>r.error),['invalid_arguments','verification_failed']);
 }finally{await s.close();}
});

for(const feature of ['images','forward'] as const)test(`${feature} first gate blocks reaction until the next model response after content retrieval`,async()=>{
 const attachment=feature==='images'?{type:'image',data:{url:'https://example.invalid/image',file:'fixture.png'}}:{type:'forward',data:{id:'fixture-forward-resource'}};
 const reading=feature==='images'?call('view_images',{image_ids:['img_1_1']}):call('read_forward',{forward_id:'fwd_1_1',start:1,end:1});
 const s=setup({settings:feature==='images'?{images:{enabled:true,maxPerTurn:1,maxDownloadMb:1}}:{forward:{enabled:true,maxPerRead:5}},respond:r=>{if(r.index===0)return complete(react(),reading);assert.equal(mutations(s).length,0);return complete(react(),silent());}});try{
  const e=event('1');e.message=[e.message[0]!,attachment as any];await s.receive(e);await settled(s,2);assert.equal(mutations(s).length,1);
  const returned=results(s.requests[1]!);assert.equal(returned[0].status,'error');assert.equal(returned[1].status,'ok');if(feature==='images')assert.ok(s.requests[1]!.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')));
 }finally{await s.close();}
});

test('reaction notices, bot messages, private messages and foreign groups do not trigger models',async()=>{
 const s=setup();try{
  await s.bot.receive({post_type:'notice',notice_type:'group_msg_emoji_like',group_id:GROUP,self_id:SELF,user_id:A,message_id:'1'},SELF);
  await s.receive(event('2',SELF));await s.receive(event('3',A,true,'foreign','33'));await s.bot.receive({...event('4'),message_type:'private'},SELF);await delay(15);
  assert.equal(s.requests.length,0);assert.equal(s.calls.length,0);assert.equal(s.memory.rows.length,0);
 }finally{await s.close();}
});

test('finish blocks trailing reactions, sends, reads and moderation without recording attempted reactions',async()=>{
 const s=setup({respond:r=>r.index===0?complete(silent(),react('999'),send(),call('get_member_info',{user_id:A}),call('mute_member',{user_id:A,seconds:60})):complete(silent())});try{
  await s.receive(event('1',OWNER_ID));await settled(s,1);assert.deepEqual(s.calls.map(c=>[c.action,c.params.message_id]),[['get_msg','1']]);await s.receive(event('2',OWNER_ID));await settled(s,2);
  assert.equal(state(s.requests[1]!).last_turn,undefined);assert.deepEqual(state(s.requests[1]!).recent,[]);assert.equal(mutations(s).length,0);assert.equal(sends(s).length,0);
 }finally{await s.close();}
});

test('native business rejection is not counted as a successful reaction',async()=>{
 const s=setup({respond:r=>r.index===0?complete(react(),silent()):complete(silent()),api:action=>action==='set_msg_emoji_like'?{result:1,errMsg:'fixture rejected'}:undefined});try{
  await s.receive(event('1'));await settled(s,1);await s.receive(event('2'));await settled(s,2);const current=state(s.requests[1]!);
  assert.equal(current.last_turn.confirmed,0);assert.equal(current.last_turn.rejected,1);assert.equal(current.last_turn.outcome,'reaction_failed');assert.equal(current.recent[0].status,'error');assert.deepEqual(current.last_turn.errors,['reaction_rejected']);
 }finally{await s.close();}
});

for(const lifecycle of ['reset','disconnect','stop'] as const)test(`${lifecycle} clears reaction ledger and last turn report`,async()=>{
 const s=setup({respond:r=>r.index===0?complete(react(),silent()):complete(silent())});try{
  await s.receive(event('1'));await settled(s,1);assert.equal((s.bot as any).recentReactions.size,1);
  if(lifecycle==='reset')await s.receive(event('2',OWNER_ID,false,'/reset'));else if(lifecycle==='disconnect')s.bot.setConnected(false);else await s.close();
  assert.equal((s.bot as any).recentReactions.size,0);assert.equal((s.bot as any).lastReactionTurn,undefined);
 }finally{await s.close();}
});

test('ledger is independent per group and hides records whose messages are no longer visible',async()=>{
 const a=setup({respond:r=>r.index===0?complete(react(),silent()):complete(silent())}),b=setup({settings:{groupId:'33'}});try{
  await a.receive(event('1'));await settled(a,1);await b.receive(event('1',A,true,'other','33'));await settled(b,1);assert.deepEqual(state(b.requests[0]!).recent,[]);assert.equal(state(b.requests[0]!).last_turn,undefined);
  a.memory.rows=[];await a.receive(event('2'));await settled(a,2);assert.deepEqual(state(a.requests[1]!).recent,[]);
 }finally{await a.close();await b.close();}
});

test('ledger and last turn reports expire according to group retention',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const s=setup({respond:r=>r.index===0?complete(react(),silent()):complete(silent())});try{
  await s.receive(event('1'));await settled(s,1);t.mock.timers.tick(8*86400000);await s.receive(event('2'));await settled(s,2);
  assert.deepEqual(state(s.requests[1]!).recent,[]);assert.equal(state(s.requests[1]!).last_turn,undefined);assert.ok(s.memory.find('1'));
 }finally{await s.close();t.mock.timers.reset();}
});

test('reaction ledger is bounded to128 entries across many normally completed batches',async()=>{
 const s=setup({respond:r=>r.index<5?complete(...Array.from({length:30},(_,i)=>react(String(1000+r.index*30+i))),silent()):complete(silent())});try{
  for(let i=0;i<150;i++)s.memory.append({messageId:String(1000+i),userId:A,nickname:'fixture',time:Math.floor(Date.now()/1000),text:'seed'});
  for(let i=0;i<5;i++){await s.receive(event(String(i+1)));await settled(s,i+1);}
  assert.equal(mutations(s).length,150);assert.equal((s.bot as any).recentReactions.size,128);await s.receive(event('6'));await settled(s,6);
  const recent=state(s.requests[5]!).recent;assert.equal(recent.length,128);assert.equal(recent[0].message_id,'1022');assert.equal(recent[127].message_id,'1149');assert.equal(s.memory.rows.filter(e=>e.bot).length,0);
 }finally{await s.close();}
});
