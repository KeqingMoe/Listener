import type {JsonObject,Memory} from './contracts.js';

export type ReactionLookup = (messageId:string)=>JsonObject|undefined;
const ADDED_LIMIT=6000, SNAPSHOT_LIMIT=1000, BATCH_LIMIT=24000, ITEM_LIMIT=8;
const statuses=new Set(['observed','stale','partial','empty_snapshot']);
function object(value:unknown):value is JsonObject{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function encoded(value:unknown):string|undefined{try{return JSON.stringify(value);}catch{return undefined;}}
function id(message:unknown):string|undefined{return object(message)&&typeof message.messageId==='string'&&message.messageId.length>0?message.messageId:undefined;}
function boundedText(value:unknown,max:number):string|undefined{
 if(typeof value!=='string'||!value)return undefined;
 return Array.from(value.slice(0,max*2)).slice(0,max).join('');
}
/** Project only observation fields: these counts never assert our participation. */
function snapshot(value:unknown):JsonObject|undefined{
 if(!object(value)||typeof value.status!=='string'||!statuses.has(value.status)||typeof value.observed_at!=='number'||!Number.isFinite(value.observed_at)||value.observed_at<0||!Array.isArray(value.items))return undefined;
 const items:JsonObject[]=[];
 for(const entry of value.items.slice(0,ITEM_LIMIT)){
  if(!object(entry)||typeof entry.emoji_id!=='string'||!/^\d{1,32}$/.test(entry.emoji_id)||typeof entry.count!=='number'||!Number.isSafeInteger(entry.count)||entry.count<0)continue;
  const kind=typeof entry.emoji_type==='number'&&Number.isSafeInteger(entry.emoji_type)?String(entry.emoji_type):entry.emoji_type;
  if(typeof kind!=='string'||!/^\d{1,16}$/.test(kind))continue;
  const name=boundedText(entry.name,64),emoji=boundedText(entry.emoji,16);
  items.push({emoji_id:entry.emoji_id,emoji_type:kind,...(name?{name}:{}),...(emoji?{emoji}:{}),count:entry.count});
 }
 let omitted=(typeof value.omitted==='number'&&Number.isSafeInteger(value.omitted)&&value.omitted>0?value.omitted:0);
 omitted=Math.min(Number.MAX_SAFE_INTEGER,omitted+value.items.length-items.length);
 const result:JsonObject={status:value.status,observed_at:value.observed_at,items};
 const markOmitted=()=>{if(omitted){result.omitted=omitted;if(result.status!=='stale')result.status='partial';}};
 markOmitted();
 while((encoded({reactions:result})?.length??Infinity)+1>SNAPSHOT_LIMIT){
  if(!items.length)return undefined;
  items.pop();omitted=Math.min(Number.MAX_SAFE_INTEGER,omitted+1);markOmitted();
 }
 return result;
}
function observation(message:unknown,lookup:ReactionLookup):JsonObject|undefined{
 const messageId=id(message);if(!messageId||!object(message)||Object.hasOwn(message,'reactions'))return undefined;
 try{return snapshot(lookup(messageId));}catch{return undefined;}
}
function candidates(messages:unknown[],lookup:ReactionLookup):Array<{message:JsonObject;info:JsonObject;index:number}>{
 const result:Array<{message:JsonObject;info:JsonObject;index:number}>=[];
 messages.forEach((message,index)=>{if(!object(message))return;const info=observation(message,lookup);if(info)result.push({message,info,index});});
 // Allocate scarce annotation space to real reactions before empty snapshots,
 // then prefer recent messages. Never reorder the actual conversation.
 return result.sort((a,b)=>Number((b.info.items as unknown[]).length>0)-Number((a.info.items as unknown[]).length>0)||b.index-a.index);
}
/** Mutates only a newly cloned/parsed representation, never Memory entries. */
function decorate(root:unknown,messages:unknown[],lookup:ReactionLookup,maximum:number):boolean{
 const initial=encoded(root);if(initial===undefined||initial.length>=maximum)return false;
 const limit=Math.min(maximum,initial.length+ADDED_LIMIT);let changed=false;
 for(const {message,info} of candidates(messages,lookup)){
  message.reactions=info;const current=encoded(root);
  if(current===undefined||current.length>limit)delete message.reactions;else changed=true;
 }
 return changed;
}

/** Retain all original message text/provenance, even for an already oversized input. */
export function annotateReactionBatch(payload:JsonObject,lookup:ReactionLookup):JsonObject{
 const copy=structuredClone(payload);
 if(object(copy.current_batch)&&Array.isArray(copy.current_batch.messages))decorate(copy,copy.current_batch.messages,lookup,BATCH_LIMIT);
 return copy;
}

/** This is a display projection only; the original context remains the summary input. */
export function annotateReactionContext(memory:Memory,lookup:ReactionLookup):string{
 const source=memory.context();let parsed:unknown;
 try{parsed=JSON.parse(source);}catch{/* Legacy plain contexts cannot be edited by matching text. */}
 const messages=Array.isArray(parsed)?parsed:object(parsed)&&Array.isArray(parsed.messages)?parsed.messages:undefined;
 if(messages){return decorate(parsed,messages,lookup,source.length+ADDED_LIMIT)?JSON.stringify(parsed):source;}
 const observations:JsonObject[]=[],seen=new Set<string>();
 let trailer='';
 const entries=memory.recent().filter(entry=>{const messageId=id(entry);if(!messageId||seen.has(messageId))return false;seen.add(messageId);return true;});
 for(const {message,info} of candidates(entries,lookup)){
  const messageId=id(message)!;
  observations.push({message_id:messageId,reactions:info});const next=JSON.stringify({reaction_observations:observations});
  if(next.length+1>ADDED_LIMIT){observations.pop();continue;}trailer=next;
 }
 return trailer?`${source}\n${trailer}`:source;
}

/** Parent applies this only to successful, locally scoped read_message results. */
export function annotateReactionReadResult(result:JsonObject,lookup:ReactionLookup):JsonObject{
 const copy=structuredClone(result);
 if(copy.status!=='ok'||!object(copy.message))return copy;
 const info=observation(copy.message,lookup);if(info)copy.message.reactions=info;
 return copy;
}
