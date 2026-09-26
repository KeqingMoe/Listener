import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldEventStore } from '../src/world-events.js';
import { WorldTools, buildWorldTools } from '../src/world-tools.js';
import type { JsonObject, TimelineEntry } from '../src/contracts.js';

test('runtime metadata is queried only on wake state and strips private fields',async()=>{
 const store=new WorldEventStore({path:':memory:',groupId:'22'});let reads=0;
 const tools=new WorldTools({store,groupId:'22',selfId:'999',state:()=>{reads++;return {body:'PRIVATE',other:'PRIVATE',attention_state:{active_plans:[{plan_id:'att_123',purpose:'wait member',body:'PRIVATE',any_of:[{type:'member_message',user_ids:['111'],message:'PRIVATE'}]}],private:'PRIVATE'},reaction_state:{recent:[{message_id:'1',emoji_id:'4',action:'add',status:'ok',at:123,body:'PRIVATE',group_id:'FOREIGN'}],last_turn:{confirmed:1,raw:'PRIVATE'}}};}});
 try{
  await tools.execute('get_time',{});await tools.execute('read_events',{limit:1});await tools.execute('read_messages',{limit:1});await tools.execute('ack_events',{ack_cursor:'bad'});assert.equal(reads,0);
  const value=await tools.execute('get_wake_state',{});assert.equal(reads,1);assert.equal(value.untrusted,true);assert.doesNotMatch(JSON.stringify(value),/PRIVATE|FOREIGN/);
  assert.deepEqual((value.attention_state as any).active_plans[0].any_of,[{type:'member_message',user_ids:['111']}]);
  assert.deepEqual((value.reaction_state as any).recent,[{message_id:'1',emoji_id:'4',action:'add',status:'ok',at:123}]);
  await tools.execute('get_wake_state',{}, {groupId:'33',selfId:'999',actorId:'111',messageId:'1'});assert.equal(reads,1);
 }finally{store.close();}
});

test('oversized runtime metadata returns a bounded prefix with honest omissions',async()=>{
 const store=new WorldEventStore({path:':memory:',groupId:'22'});
 const plans=Array.from({length:1000},(_,i)=>({plan_id:`att_${i}`,purpose:'界'.repeat(160),any_of:[{type:'member_message',user_ids:['111']}]}));
 const tools=new WorldTools({store,groupId:'22',selfId:'999',state:()=>({attention_state:{active_plans:plans},reaction_state:{recent:Array.from({length:1000},(_,i)=>({message_id:String(i),emoji_id:'4',status:'ok',action:'add',error:'界'.repeat(160)}))}})});
 try{const value=await tools.execute('get_wake_state',{});assert.equal(value.status,'ok');assert.ok(Buffer.byteLength(JSON.stringify(value))<24000);
  for(const [name,key] of [['attention_state','active_plans'],['reaction_state','recent']]){const state=value[name!] as any;assert.equal(state.details_truncated,true);assert.equal(state.omitted_items+state[key!].length,1000);assert.ok(state[key!].length>0);}
  assert.equal(plans.length,1000);
 }finally{store.close();}
});

const groupId='22', selfId='999';
const context={groupId,selfId,actorId:'111',messageId:'1'};
function setup(){
  let now=Date.now()/1000;
  const store=new WorldEventStore({path:':memory:',groupId});
  const tools=new WorldTools({store,groupId,selfId,clock:()=>now,wake:()=>({wakeId:'wake_1',startedAt:now-1,trigger:{type:'direct',event_id:'we_1',body:'PRIVATE_TRIGGER'}}),currentBudget:()=>({remaining_tool_calls:80,remaining_ms:30000,secret:'PRIVATE_BUDGET'})});
  const add=(n:number,extra:Partial<TimelineEntry>={})=>store.appendMessage({messageId:String(n),userId:n%2?'111':'222',nickname:'member',text:`message ${n}`,time:now,segments:[{type:'text',text:`message ${n}`}],...extra},{source:'onebot',observedAt:now});
  const run=(name:string,args:unknown={},ctx=context,signal?:AbortSignal)=>tools.execute(name,args,ctx,signal);
  return{store,tools,add,run,tick:(seconds:number)=>{now+=seconds;},get now(){return now;}};
}
const list=(result:JsonObject,key:'events'|'messages')=>result[key] as JsonObject[];
const sequences=(result:JsonObject)=>list(result,'events').map(e=>e.sequence);

test('definitions expose explicit counts, query-bound cursors and separate acknowledgment',()=>{
  const tools=buildWorldTools();assert.deepEqual(tools.map(t=>t.function.name),['get_wake_state','get_time','read_events','read_messages','ack_events']);
  for(const name of ['read_events','read_messages']){
    const parameters=tools.find(t=>t.function.name===name)!.function.parameters;
    assert.deepEqual(parameters.required,['limit']);assert.equal(((parameters.properties as JsonObject).limit as JsonObject).maximum,undefined);
  }
  (tools[0]!.function.parameters.properties as JsonObject).evil=true;assert.deepEqual(buildWorldTools()[0]!.function.parameters.properties,{});
});

test('counts and time expose metadata without message or callback body and do not acknowledge',async()=>{
  const s=setup();try{
    s.add(1);s.add(2);const wake=await s.run('get_wake_state');
    assert.equal(wake.status,'ok');assert.equal(wake.unread_count,2);assert.equal(wake.latest_available,2);assert.equal(wake.observed_through,0);
    assert.equal(wake.wake_id,'wake_1');assert.ok(!JSON.stringify(wake).includes('PRIVATE'));assert.ok(!JSON.stringify(wake).includes('message 1'));
    const time=await s.run('get_time');assert.equal(time.unix_seconds,s.now);assert.equal(time.utc,new Date(s.now*1000).toISOString());assert.equal(time.timezone,'Asia/Shanghai');assert.match(String(time.local),/GMT\+08:00/);
    assert.equal(s.store.getState('ai').observationWatermark,0);
  }finally{s.store.close();}
});

test('required limit and scope validation reject invalid types, unknown fields and invented numeric cursors',async()=>{
  const s=setup();try{
    for(const name of ['read_events','read_messages'])for(const limit of [undefined,0,-1,1.2,NaN,Infinity,'3',true,null,Number.MAX_SAFE_INTEGER+1])assert.equal((await s.run(name,{limit})).error,'invalid_arguments');
    for(const args of [{},{limit:1,after:0},{limit:1,group_id:'33'},{limit:1,direction:'sideways'},{limit:1,actor_id:'01'},{limit:1,since:'1'},{limit:1,since:2,until:1},{limit:1,types:[]},{limit:1,types:['bogus']},{limit:1,types:['message.created','message.created']}])assert.equal((await s.run('read_events',args)).error,'invalid_arguments');
    assert.equal((await s.run('read_messages',{limit:1,types:['message.created']})).error,'invalid_arguments');
    assert.equal((await s.run('read_events',{limit:1,cursor:1})).error,'invalid_cursor');
    assert.equal((await s.run('read_events',{limit:1},{...context,groupId:'33'})).error,'forbidden_group');
    assert.equal((await s.run('read_events',{limit:1},{...context,selfId:'777'})).error,'forbidden_group');
    const controller=new AbortController();controller.abort();assert.equal((await s.run('get_time',{},context,controller.signal)).error,'cancelled');
    assert.equal((await s.run('unknown')).error,'unknown_tool');
    assert.equal((await s.run('get_time',{limit:1})).error,'invalid_arguments');
    assert.equal((await s.run('read_events',Object.defineProperty({limit:1},'cursor',{enumerable:true,get(){throw Error('PRIVATE');}}))).error,'invalid_arguments');
  }finally{s.store.close();}
});

test('new queries see live arrivals while page chains keep a high water snapshot',async()=>{
  const s=setup();try{
    s.add(1);s.add(2);const first=await s.run('read_events',{limit:1});assert.deepEqual(sequences(first),[1]);assert.equal(first.high_water,2);assert.match(String(first.next_cursor),/^wc_[0-9a-f]{48}$/);assert.equal(first.nextCursor,undefined);
    s.add(3);const second=await s.run('read_events',{limit:10,cursor:first.next_cursor});assert.deepEqual(sequences(second),[2]);assert.equal(second.high_water,2);assert.equal(second.latest_available,3);
    const fresh=await s.run('read_events',{limit:10});assert.deepEqual(sequences(fresh),[1,2,3]);assert.equal(fresh.high_water,3);
    const repeated=await s.run('read_events',{limit:10,cursor:first.next_cursor});assert.deepEqual(sequences(repeated),[2]);
    assert.equal(s.store.getState('ai').observationWatermark,0);
  }finally{s.store.close();}
});

test('opaque cursors bind kind and filters; cursor carries filters without caller repetition',async()=>{
  const s=setup();try{
    for(let i=1;i<=5;i++)s.add(i);
    const first=await s.run('read_events',{limit:1,actor_id:'111',types:['message.created']});assert.deepEqual(sequences(first),[1]);assert.equal(first.ack_cursor,undefined);
    const next=await s.run('read_events',{limit:2,cursor:first.next_cursor});assert.deepEqual(sequences(next),[3,5]);assert.equal(next.ack_cursor,undefined);
    assert.equal((await s.run('read_events',{limit:1,cursor:first.next_cursor,actor_id:'222'})).error,'invalid_arguments');
    assert.equal((await s.run('read_messages',{limit:1,cursor:first.next_cursor})).error,'invalid_cursor');
    const other=new WorldTools({store:s.store,groupId,selfId});assert.equal((await other.execute('read_events',{limit:1,cursor:first.next_cursor},context)).error,'invalid_cursor');
    assert.equal((await s.run('read_events',{limit:1,cursor:'wc_'+ 'a'.repeat(48)})).error,'invalid_cursor');
  }finally{s.store.close();}
});

test('backward history paginates without repeating and time filters use observed timestamps',async()=>{
  const s=setup();try{
    s.add(1);const start=s.now;s.tick(1);s.add(2);s.tick(1);s.add(3);
    const first=await s.run('read_events',{limit:1,direction:'backward'});assert.deepEqual(sequences(first),[3]);assert.equal(first.ack_cursor,undefined);
    const next=await s.run('read_events',{limit:2,cursor:first.next_cursor});assert.deepEqual(sequences(next),[2,1]);assert.equal(next.next_cursor,undefined);
    const filtered=await s.run('read_events',{limit:10,since:start+1,until:start+1});assert.deepEqual(sequences(filtered),[2]);assert.equal(filtered.ack_cursor,undefined);
    const messages=await s.run('read_messages',{limit:2,direction:'backward'});assert.deepEqual(list(messages,'messages').map(m=>m.messageId),['3','2']);
    const older=await s.run('read_messages',{limit:2,cursor:messages.next_cursor});assert.deepEqual(list(older,'messages').map(m=>m.messageId),['1']);
  }finally{s.store.close();}
});

test('only explicit issued acknowledgments advance continuous unfiltered event observation',async()=>{
  const s=setup();try{
    s.add(1);s.add(2);s.add(3);
    const filtered=await s.run('read_events',{limit:10,actor_id:'111'});assert.equal(filtered.ack_cursor,undefined);
    const messages=await s.run('read_messages',{limit:10});assert.equal(messages.ack_cursor,undefined);
    assert.equal((await s.run('ack_events',{through_sequence:3})).error,'invalid_arguments');
    assert.equal((await s.run('ack_events',{ack_cursor:'wa_'+'a'.repeat(48)})).error,'invalid_ack_cursor');
    const first=await s.run('read_events',{limit:1});assert.equal(s.store.getState('ai').unreadEvents,3);
    const second=await s.run('read_events',{limit:1,cursor:first.next_cursor});assert.deepEqual(sequences(second),[2]);
    const ack=await s.run('ack_events',{ack_cursor:second.ack_cursor});assert.equal(ack.observed_through,2);assert.equal(s.store.getState('ai').unreadEvents,1);
    assert.equal((await s.run('ack_events',{ack_cursor:first.ack_cursor})).observed_through,2);
    assert.deepEqual(sequences(await s.run('read_events',{limit:10})),[3]);
    assert.deepEqual(sequences(await s.run('read_events',{limit:10,direction:'backward'})),[3,2,1]);
  }finally{s.store.close();}
});

test('expired pagination and ack tokens fail explicitly without acknowledging',async()=>{
  const s=setup();try{
    s.add(1);s.add(2);const first=await s.run('read_events',{limit:1});s.tick(86400);
    assert.equal((await s.run('read_events',{limit:1,cursor:first.next_cursor})).error,'invalid_cursor');
    assert.equal((await s.run('ack_events',{ack_cursor:first.ack_cursor})).error,'invalid_ack_cursor');assert.equal(s.store.getState('ai').observationWatermark,0);
  }finally{s.store.close();}
});

test('huge explicit limits are accepted but output remains bounded and paginates',async()=>{
  const s=setup();try{
    for(let i=1;i<=60;i++)s.add(i,{text:'字'.repeat(3000),segments:[{type:'text',text:'字'.repeat(3000)}]});
    for(const name of ['read_events','read_messages']){
      const result=await s.run(name,{limit:Number.MAX_SAFE_INTEGER});assert.equal(result.status,'ok');assert.equal(result.requested,Number.MAX_SAFE_INTEGER);assert.equal(result.truncated,true);assert.ok((result.returned as number)>0);assert.ok(result.next_cursor);assert.ok(Buffer.byteLength(JSON.stringify(result))<=24000);assert.equal(typeof result.queried_at,'number');assert.ok(result.current_time);
    }
  }finally{s.store.close();}
});

test('projections remove private forward/image metadata and preserve typed literal text and recalls',async()=>{
  const s=setup();try{
    s.add(1,{text:'[CQ:at,qq=all]',segments:[{type:'text',text:'[CQ:at,qq=all]'}, {type:'forward',forward_id:'fwd_1_1',content_status:'not_read'}, {type:'image',image_id:'img_1_2',content_status:'not_viewed'}],forwards:[{id:'fwd_1_1',index:1,resourceId:'PRIVATE_RESOURCE',url:'https://private.invalid/SECRET'} as any],images:[{id:'img_1_2',index:2,url:'https://private.invalid/SECRET'} as any]});
    s.store.appendRecall('1',{observedAt:s.now,recalledBy:'222'});
    for(const name of ['read_events','read_messages']){
      const result=await s.run(name,{limit:10});assert.equal(result.status,'ok');assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('private.invalid'));assert.ok(JSON.stringify(result).includes('[CQ:at,qq=all]'));
    }
    const result=await s.run('read_messages',{limit:10});const m=list(result,'messages')[0]!;assert.equal(m.recalled,true);assert.equal(m.recalled_by,'222');assert.equal(m.representation,'segments');
  }finally{s.store.close();}
});

test('constructor rejects store scope mismatch and invalid timezone; errors do not leak storage details',async()=>{
  const s=setup();try{
    assert.throws(()=>new WorldTools({store:s.store,groupId:'33',selfId}));assert.throws(()=>new WorldTools({store:s.store,groupId,selfId:'all'}));assert.throws(()=>new WorldTools({store:s.store,groupId,selfId,timezone:'SECRET/INVALID'}));
    s.store.close();const result=await s.run('get_wake_state');assert.deepEqual(result,{status:'error',error:'tool_failed'});
  }finally{s.store.close();}
});
