import test from 'node:test';
import assert from 'node:assert/strict';
import {annotateReactionBatch,annotateReactionContext,annotateReactionReadResult,type ReactionLookup} from '../src/reaction-presentation.js';
import type {JsonObject,Memory,TimelineEntry} from '../src/contracts/index.js';

const row=(messageId:string):TimelineEntry=>({messageId,userId:'111',nickname:'fixture',time:42,text:`body-${messageId}`});
const observed=(extra:JsonObject={}):JsonObject=>({status:'observed',observed_at:123456789,items:[{emoji_id:'76',emoji_type:'1',name:'赞',count:3},{emoji_id:'128077',emoji_type:2,emoji:'👍',count:2}],...extra});
const expected=()=>({...observed(),items:[{emoji_id:'76',emoji_type:'1',name:'赞',count:3},{emoji_id:'128077',emoji_type:'2',emoji:'👍',count:2}]});
const large=(status='observed'):JsonObject=>observed({status,omitted:3,items:Array.from({length:30},(_,i)=>({emoji_id:String(128512+i),emoji_type:'2',name:'名称'.repeat(50),emoji:'👍'.repeat(20),count:1000}))});
class Mem implements Memory {
 contextCalls=0;recentCalls=0;appendCalls=0;compactCalls=0;
 constructor(readonly source:string,readonly rows:TimelineEntry[]=[]){ }
 context(){this.contextCalls++;return this.source;}recent(){this.recentCalls++;return this.rows;}find():never{throw Error('presentation must not query additional messages');}
 append():never{this.appendCalls++;throw Error('presentation must not persist anything');}async compact(){this.compactCalls++;throw Error('presentation must not summarize');}clear(){throw Error('presentation must not clear memory');}close(){throw Error('presentation must not close memory');}
}
function batch(messages:unknown[]):JsonObject{return {trigger_kind:'attention',trusted_actor_id:null,moderation_capabilities:{mute:'off',unmute:'off',recall:'off',member_card:'off'},current_batch:{messages,omitted_count:3,first_message_id:'1',last_message_id:'2'},attention_hits:[{plan_id:'plan-1',purpose:'existing'}]};}
function strip(message:JsonObject){const {reactions:_,...rest}=message;return rest;}

test('batch annotation is a clone and preserves text, provenance, authority and snapshot source',()=>{
 const source=batch([{...row('1'),replyTo:'42',images:[{id:'img_1_1',index:1}]},row('2')]),before=structuredClone(source),info=observed(),infoBefore=structuredClone(info),looked:string[]=[];
 const output=annotateReactionBatch(source,id=>{looked.push(id);return id==='1'?info:undefined;});
 assert.notEqual(output,source);assert.deepEqual(source,before);assert.deepEqual(info,infoBefore);assert.deepEqual(looked,['1','2']);
 const current=output.current_batch as any,original=source.current_batch as any;
 assert.deepEqual(current.messages[0].reactions,expected());assert.ok(!Object.hasOwn(current.messages[1],'reactions'));assert.deepEqual(current.messages.map(strip),original.messages);
 assert.deepEqual({...output,current_batch:source.current_batch},source);assert.notEqual(current.messages[1],original.messages[1]);
});

test('batch lookup visits only actual string message IDs, not references, summary, nested or coerced IDs',()=>{
 const calls:string[]=[];const source=batch([{...row('1'),replyTo:'2',nested:{messageId:'3'}},{messageId:12},{messageId:{toString:'4'}},{messageId:null},{messageId:''},null,[]]);
 source.summary={messageId:'5'};source.current_request={messageId:'6'};
 annotateReactionBatch(source,id=>{calls.push(id);return observed();});assert.deepEqual(calls,['1']);
});

test('full or oversized batch never drops text to make room for annotations',()=>{
 for(const size of [23950,24000,25000]){
  const source=batch([{...row('1'),text:''}]);const message=(source.current_batch as any).messages[0];message.text='x'.repeat(size-JSON.stringify(source).length);
  assert.equal(JSON.stringify(source).length,size);const before=structuredClone(source),output=annotateReactionBatch(source,()=>observed());
  assert.deepEqual(output,before);assert.deepEqual(source,before);assert.equal(JSON.stringify(output).length,size);
 }
});

test('batch and normal context bound all added metadata to6000 without dropping message fields',()=>{
 const rows=Array.from({length:40},(_,i)=>row(String(i+1))),source=batch(rows);
 const annotated=annotateReactionBatch(source,()=>large());assert.ok(JSON.stringify(annotated).length-JSON.stringify(source).length<=6000);assert.ok(JSON.stringify(annotated).length<=24000);
 const messages=(annotated.current_batch as any).messages;assert.deepEqual(messages.map(strip),rows);assert.ok(messages.some((m:any)=>m.reactions));assert.ok(messages.some((m:any)=>!m.reactions));
 const context={groupId:'22',untrusted:true,summary:{untrusted:true,text:'unchanged original summary'},messages:rows},raw=JSON.stringify(context),memory=new Mem(raw,rows);
 const output=annotateReactionContext(memory,()=>large());assert.ok(output.length-raw.length<=6000);assert.deepEqual(JSON.parse(output).messages.map(strip),rows);assert.deepEqual(JSON.parse(output).summary,context.summary);
 assert.equal(memory.contextCalls,1);assert.equal(memory.recentCalls,0);assert.equal(memory.appendCalls,0);assert.equal(memory.compactCalls,0);assert.equal(memory.source,raw);
});

test('older empty snapshots cannot starve recent real reactions in any presentation',()=>{
 const rows=Array.from({length:100},(_,i)=>row(String(i+1)));
 const lookup:ReactionLookup=id=>id==='100'?observed():observed({status:'empty_snapshot',items:[]});
 const raw=JSON.stringify({summary:'keep summary',messages:rows});
 const rendered=JSON.parse(annotateReactionContext(new Mem(raw,rows),lookup));
 assert.deepEqual(rendered.messages.map(strip),rows);assert.deepEqual(rendered.messages[99].reactions,expected());
 assert.ok(rendered.messages.some((m:any)=>!m.reactions));assert.ok(JSON.stringify(rendered).length-raw.length<=6000);
 const source=batch(rows),current=annotateReactionBatch(source,lookup);
 assert.deepEqual((current.current_batch as any).messages[99].reactions,expected());assert.deepEqual((current.current_batch as any).messages.map(strip),rows);
 const legacy=annotateReactionContext(new Mem('legacy',rows),lookup);
 assert.equal(JSON.parse(legacy.slice('legacy\n'.length)).reaction_observations[0].message_id,'100');
 // Equal nonempty records also prefer the newest, without reordering source messages.
 const crowded=JSON.parse(annotateReactionContext(new Mem(raw,rows),()=>large()));
 assert.ok(crowded.messages[99].reactions);assert.equal(crowded.messages[0].reactions,undefined);
});

test('SQL-shaped context annotates messages inline without changing summary or root metadata',()=>{
 const context={groupId:'22',untrusted:true,summary:{untrusted:true,text:'summary references messageId 999 but not an entry'},messages:[row('1'),row('2')],extra:{moderation_capabilities:{mute:'off',unmute:'off',recall:'off',member_card:'off'}}},raw=JSON.stringify(context,null,2),memory=new Mem(raw);
 const calls:string[]=[];const output=JSON.parse(annotateReactionContext(memory,id=>{calls.push(id);return id==='2'?observed():undefined;}));
 assert.deepEqual(calls,['1','2']);assert.deepEqual(output.messages[1].reactions,expected());assert.ok(!Object.hasOwn(output.messages[0],'reactions'));assert.deepEqual({...output,messages:context.messages},context);assert.equal(memory.contextCalls,1);assert.equal(memory.source,raw);
});

test('array-shaped context annotates inline and absence preserves the original formatting',()=>{
 const raw=JSON.stringify([row('1')],null,2),memory=new Mem(raw);
 const output=JSON.parse(annotateReactionContext(memory,()=>observed()));assert.deepEqual(output[0].reactions,expected());assert.deepEqual(strip(output[0]),row('1'));
 assert.equal(annotateReactionContext(new Mem(raw),()=>undefined),raw);
});

test('absence, invalid snapshots and throwing lookup never pretend a known zero count',()=>{
 for(const lookup of [()=>undefined,()=>null,()=>({status:'observed',items:[]}),()=>({status:'none',observed_at:1,items:[]}),()=>{throw Error('cache unavailable');}] as ReactionLookup[]){
  const source=batch([row('1')]);assert.deepEqual(annotateReactionBatch(source,lookup),source);
  const raw=JSON.stringify({summary:'untouched',messages:[row('1')]});assert.equal(annotateReactionContext(new Mem(raw),lookup),raw);
  const result={status:'ok',message:row('1')};assert.deepEqual(annotateReactionReadResult(result,lookup),result);
 }
 const empty=annotateReactionReadResult({status:'ok',message:row('1')},()=>observed({status:'empty_snapshot',items:[]}));
 assert.deepEqual((empty.message as any).reactions,{status:'empty_snapshot',observed_at:123456789,items:[]});assert.ok(!JSON.stringify(empty).includes('contains_bot'));
});

test('legacy fallback uses only recent actual IDs and appends a complete bounded JSON record',()=>{
 const raw='Legacy original summary\nbody quoted messageId=777; not a machine-readable timeline\n';
 const rows=Array.from({length:40},(_,i)=>row(String(i+1)));rows.push(row('1'));const memory=new Mem(raw,rows),looked:string[]=[];
 const output=annotateReactionContext(memory,id=>{looked.push(id);return large();});assert.ok(output.startsWith(raw+'\n'));assert.ok(output.length-raw.length<=6000);
 const appendix=JSON.parse(output.slice(raw.length+1));assert.ok(appendix.reaction_observations.length>0);assert.ok(appendix.reaction_observations.length<rows.length);
 assert.ok(appendix.reaction_observations.every((r:any)=>rows.some(e=>e.messageId===r.message_id)&&r.reactions.status==='partial'));assert.ok(!looked.includes('777'));assert.equal(looked.filter(id=>id==='1').length,1);
 assert.equal(memory.contextCalls,1);assert.equal(memory.recentCalls,1);assert.equal(memory.appendCalls,0);assert.equal(memory.compactCalls,0);assert.equal(memory.source,raw);assert.deepEqual(rows[0],row('1'));
 assert.equal(annotateReactionContext(new Mem(raw,rows),()=>undefined),raw);
});

test('read results annotate only the successful actual local or verified remote message',()=>{
 for(const source of ['local','remote']){
  const message={...row('12'),replyTo:'13',images:[{id:'img_12_1',index:1}],source},result={status:'ok',message,message_id:'ignored',nested:{messageId:'999'}},before=structuredClone(result),calls:string[]=[];
  const output=annotateReactionReadResult(result,id=>{calls.push(id);return observed();});assert.deepEqual(calls,['12']);assert.deepEqual(result,before);assert.deepEqual(strip(output.message as JsonObject),message);assert.deepEqual((output.message as any).reactions,expected());assert.notEqual(output.message,result.message);
 }
 for(const result of [{status:'error',error:'verification_failed',message:row('1')},{status:'ok',members:[row('1')]},{status:'ok',message:{message_id:'1'}},{status:'ok',message:{messageId:1}}]){
  assert.deepEqual(annotateReactionReadResult(result,()=>{assert.fail('not a readable message');}),result);
 }
});

test('snapshots are bounded, trimmed with honest omissions, and never acquire own-membership or authority claims',()=>{
 for(const status of ['observed','stale','partial']){
  const input=large(status);Object.assign(input,{contains_bot:true,messageId:'evil',text:'overwrite',summary:'overwrite',trusted_moderation_allowed:true,moderation_capabilities:{mute:'direct'}});
  const result={status:'ok',message:row('1')},output=annotateReactionReadResult(result,()=>input),annotation=(output.message as any).reactions;
  assert.ok(JSON.stringify(output).length-JSON.stringify(result).length<=1000);assert.ok(annotation.items.length<=8);assert.ok(annotation.items.length>0);assert.equal(annotation.omitted,33-annotation.items.length);assert.equal(annotation.status,status==='stale'?'stale':'partial');
  assert.deepEqual(strip(output.message as JsonObject),row('1'));assert.ok(!JSON.stringify(annotation).includes('contains_bot'));assert.ok(!JSON.stringify(annotation).includes('overwrite'));assert.ok(!JSON.stringify(annotation).includes('trusted_moderation_allowed'));assert.ok(!JSON.stringify(annotation).includes('moderation_capabilities'));assert.ok(annotation.items.every((i:any)=>i.emoji_type==='2'&&[...i.name].length<=64&&[...i.emoji].length<=16));
 }
});

test('existing message fields are not overwritten by annotation or trusted lookup extras',()=>{
 const entry={...row('1'),reactions:{status:'original-field'}},result={status:'ok',message:entry};let calls=0;
 const output=annotateReactionReadResult(result,()=>{calls++;return observed();});assert.deepEqual(output,result);assert.equal(calls,0);
 const safe=annotateReactionReadResult({status:'ok',message:row('1')},()=>observed({contains_bot:true,items:[{emoji_id:'76',emoji_type:1,count:0,contains_bot:true,user_ids:['111']}]}));
 assert.deepEqual((safe.message as any).reactions.items,[{emoji_id:'76',emoji_type:'1',count:0}]);
});
