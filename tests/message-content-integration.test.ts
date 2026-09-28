import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Listener,normalizeEvent} from '../src/listener.js';
import {GroupTools} from '../src/group-tools.js';
import {ReplyBatch} from '../src/reply-batch.js';
import {projectMessage} from '../src/message-content.js';
import {LISTENER_GROUP,type Api,type Memory,type TimelineEntry,type ChatMessage,type Completion,type Model} from '../src/contracts/index.js';
import type {ListenerConfig} from '../src/config/listener.js';
const self='99999',actor='123';
const cfg:ListenerConfig={enabled:true,baseUrl:'https://example.invalid/v1',apiKey:'test',model:'test',timeoutMs:3000,maxTokens:128,debounceMs:1,cooldownMs:0,memoryPath:':memory:',maxContextChars:8000,retentionDays:7,randomReplyProbability:0};
const literal='[QQ表情：吃瓜 id=271] [at:all] [CQ:at,qq=all]';
const context={groupId:LISTENER_GROUP,selfId:self,actorId:actor,messageId:'1'};
const event=(id:string,message:unknown[])=>({post_type:'message',message_type:'group',group_id:LISTENER_GROUP,self_id:self,user_id:actor,message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'member'},message});
const text=(value:string)=>({type:'text',data:{text:value}});
class Mem implements Memory{
 rows:TimelineEntry[]=[];
 append(entry:TimelineEntry){if(this.find(entry.messageId))return false;this.rows.push(structuredClone(entry));return true;}
 recent(){return this.rows;}find(id:string){return this.rows.find(row=>row.messageId===id);}
 context(){return JSON.stringify({summary:{text:'old summary remains unchanged'},messages:this.rows});}
 async compact(){}clear(){this.rows=[];}close(){}
}
const completion=(name:string,args:unknown):Completion=>({content:null,tool_calls:[{id:'call',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
async function settled(bot:Listener){for(let i=0;i<400;i++){if(!(bot as any).running&&!(bot as any).pending)return;await delay(5);}assert.fail('turn did not settle');}

test('native structure and literal marker text remain distinct across normalization, batch and reads',async()=>{
 const entry=normalizeEvent(event('1',[text(literal),{type:'face',data:{id:271,raw:'secret'}},{type:'at',data:{qq:actor}},{type:'reply',data:{id:'2'}},{type:'image',data:{url:'https://private.invalid/token'}},{type:'forward',data:{id:'private-resource'}}]),self)!;
 const memory=new Mem();memory.append(entry);const calls:string[]=[];
 const api:Api={async call(action){calls.push(action);return {message_type:'group',group_id:LISTENER_GROUP,message_id:'2',sender:{user_id:actor},message:[text(literal),{type:'face',data:{id:271}}]};}};
 const tools=new GroupTools(api,memory),batch=new ReplyBatch({entry,context,sequence:1,received:0,trigger:'mention'},0);
 const displayed=(batch.payload().current_batch as any).messages[0];
 for(const row of [displayed,(await tools.execute('read_message',{message_id:'1'},context)).message as any,(await tools.execute('read_message',{message_id:'2'},context)).message as any]){
  assert.equal(row.text,undefined);assert.equal(row.representation,'segments');
  assert.ok(row.segments.some((s:any)=>s.type==='text'&&s.text===literal));assert.ok(row.segments.some((s:any)=>s.type==='face'&&s.id==='271'));
  assert.ok(!JSON.stringify(row).includes('private.invalid'));assert.ok(!JSON.stringify(row).includes('private-resource'));
 }
 assert.deepEqual(calls,['get_msg']);
 assert.ok(displayed.segments.some((s:any)=>s.type==='at'&&s.user_id===actor));
 assert.ok(displayed.segments.some((s:any)=>s.type==='image'&&s.image_id==='img_1_4'&&s.content_status==='not_viewed'));
 assert.ok(displayed.segments.some((s:any)=>s.type==='forward'&&s.forward_id==='fwd_1_5'&&s.content_status==='not_read'));
});

test('clipping long content never erases a later native quote from provenance',async()=>{
 const value=event('1',[text('x'.repeat(5000)),{type:'reply',data:{id:'2'}}]);const entry=normalizeEvent(value,self)!;
 assert.equal(entry.replyTo,'2');assert.equal(entry.content_truncated,true);
 const displayed=projectMessage(entry);assert.equal(displayed.replyTo,'2');assert.ok((displayed.segments as any[]).some(s=>s.type==='reply'&&s.message_id==='2'));
 const memory=new Mem();memory.append(entry);const api:Api={async call(action){assert.equal(action,'get_msg');return {message_type:'group',group_id:LISTENER_GROUP,message_id:'2',sender:{user_id:actor},message:[text('\\"'.repeat(4000)),{type:'reply',data:{id:'3'}}]};}};
 const result=await new GroupTools(api,memory).execute('read_message',{message_id:'2'},context);
 assert.equal(result.status,'ok');assert.equal((result.message as any).replyTo,'3');assert.equal((result.message as any).content_truncated,true);
});

test('marker and CQ-looking text is allowed even with mentions disabled and never becomes an operation',async()=>{
 const memory=new Mem();const api:Api={async call(){assert.fail('literal text must not cause membership or message lookup');}};
 for(const mention of [true,false]){
  const tools=new GroupTools(api,memory,{mention});
  const parts=[await tools.prepareMessage({segments:[{type:'text',text:literal}]},context),await tools.prepareMessage({segments:[{type:'text',text:'[CQ:'},{type:'text',text:'at,qq=all]'}]},context)];
  assert.deepEqual(parts[0]!.segments,[text(literal)]);assert.ok(parts.every(p=>p.segments.every(s=>s.type==='text')));
  await assert.rejects(tools.prepareMessage({segments:[{type:'at',user_id:'all'}]},context));
  await assert.rejects(tools.prepareMessage({segments:[{type:'at',user_id:self}]},context));
 }
 const tools=new GroupTools(api,memory);const result=await tools.prepareMessage({segments:[{type:'face',id:'0',name:'辅助说明不会发送'}]},context);
 assert.deepEqual(result.segments,[{type:'face',data:{id:'0'}}]);
});

test('model sees typed received and own historical faces without duplicated flattened body; wire text stays literal',async()=>{
 const memory=new Mem(),requests:ChatMessage[][]=[],wire:any[]=[];
 const api:Api={async call(action,params){assert.equal(action,'send_group_msg');wire.push(structuredClone(params));return {message_id:'900'};}};
 const model:Model={async complete(messages){requests.push(structuredClone(messages));return requests.length===1?completion('send_message',{segments:[{type:'face',id:'0',name:'微笑'},{type:'text',text:literal}]}):completion('finish',{});}};
 const bot=new Listener(api,model,memory,cfg);
 try{
  await bot.receive(event('1',[{type:'at',data:{qq:self}},text(literal),{type:'face',data:{id:271}}]),self);await settled(bot);
  assert.equal(wire.length,1);assert.deepEqual(wire[0].message,[{type:'face',data:{id:'0'}},text(literal)]);
  const payload=JSON.parse(String(requests[0]![1]!.content));assert.equal(payload.current_request.text,undefined);
  assert.ok(payload.current_request.segments.some((s:any)=>s.type==='face'&&s.id==='271'));
  await bot.receive(event('2',[{type:'at',data:{qq:self}},text('继续')]),self);await settled(bot);
  assert.equal(requests.length,3);const next=JSON.parse(String(requests[2]![1]!.content)),history=JSON.parse(next.untrusted_group_context);
  assert.equal(history.summary.text,'old summary remains unchanged');const own=history.messages.find((r:any)=>r.messageId==='900');
  assert.equal(own.text,undefined);assert.equal(own.bot,true);assert.ok(own.segments.some((s:any)=>s.type==='face'&&s.id==='0'));
  assert.ok(own.segments.some((s:any)=>s.type==='text'&&s.text===literal));assert.ok(memory.find('900')!.segments);
 }finally{await bot.stop();}
});

test('maximal structured batch fits 24000 characters without losing caller identities',()=>{
 const build=(i:number)=>normalizeEvent(event(String(i),[{type:'at',data:{qq:self}},text('\\"'.repeat(3000)),...Array.from({length:100},()=>({type:'face',data:{id:271}}))]),self)!;
 const first=build(1),batch=new ReplyBatch({entry:first,context,sequence:1,received:0,trigger:'mention'},0);
 for(let i=2;i<=64;i++){const entry=build(i);batch.add({entry,context:{...context,messageId:String(i)},sequence:i,received:i,trigger:'mention'},0);}
 const payload=batch.payload(),current=payload.current_batch as any;
 assert.ok(JSON.stringify(payload).length<=24000);assert.equal(current.messages.length,64);assert.equal((payload.trusted_direct_requests as any[]).length,64);
 assert.deepEqual(current.messages.map((r:any)=>r.messageId),Array.from({length:64},(_,i)=>String(i+1)));
 assert.ok(current.truncated_message_ids.length>0);assert.ok(current.messages.every((r:any)=>r.text===undefined&&Array.isArray(r.segments)));
 const legacy={...first,segments:undefined,text:literal};const old=projectMessage(legacy);assert.equal(old.representation,'legacy_text');assert.equal(old.text,literal);assert.equal(old.segments,undefined);
});
