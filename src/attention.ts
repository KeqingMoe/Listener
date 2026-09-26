import { randomBytes } from 'node:crypto';
import type { JsonObject, ToolDefinition } from './contracts.js';

export interface AttentionConfig { enabled: boolean; maxPlans: number }
export interface AttentionHit { plan_id: string; reason: 'next_message'|'member_message'|'after'|'activity'; purpose?: string }
/** Opaque token; transactions are owned and stored privately by their engine. */
export interface AttentionTransaction { readonly attention_transaction: true }
type Condition = {type:'next_message'} | {type:'member_message';user_ids:string[]} |
  {type:'after';delay_seconds:[number,number]} | {type:'activity';window_seconds:number;min_messages:number;min_senders:number};
interface Spec { any_of:Condition[]; expires_in_seconds:number; purpose?:string }
interface Plan { id:string; revision:number; spec:Spec; installed:number; baseline:number; expires:number; due:(number|undefined)[] }
interface Observation { sequence:number; received:number; userId:string }
interface TransactionState {
  generation:number; selfId:string; closed:boolean;
  revisions:Map<string,number>; view:Map<string,Spec>; changes:Map<string,Spec|null>;
}
const error=(code:string):JsonObject=>({status:'error',error:code});
const canonicalId=(v:unknown):v is string=>typeof v==='string'&&v.length<=32&&v.trim()===v&&/^[1-9]\d*$/.test(v);
const planId=(v:unknown):v is string=>typeof v==='string'&&v.length===20&&/^att_[a-f0-9]{16}$/.test(v);
function record(v:unknown):v is Record<string,unknown>{
  return !!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&
    Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));
}
function fields(v:Record<string,unknown>,required:string[],optional:string[]=[]):boolean{
  return required.every(k=>Object.hasOwn(v,k))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&[...required,...optional].includes(k)&&v[k]!==undefined);
}
function array(v:unknown):v is unknown[]{
  return Array.isArray(v)&&v.length<=512&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>i).every(i=>Object.hasOwn(v,i)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,String(i))!,'value'));
}
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
function time(now:number):void { if(!integer(now,0,Number.MAX_SAFE_INTEGER-86400_000))throw new Error('Invalid attention time'); }
function parseSpec(args:Record<string,unknown>,selfId:string):Spec|undefined{
  const ttl=args.expires_in_seconds;
  if(!integer(ttl,1,86400)||!array(args.any_of)||args.any_of.length<1||args.any_of.length>8)return;
  if(Object.hasOwn(args,'purpose')&&(typeof args.purpose!=='string'||args.purpose.length>160||/[\u0000-\u001f\u007f-\u009f]/.test(args.purpose)))return;
  const conditions:Condition[]=[];
  for(const c of args.any_of){
    if(!record(c))return;
    if(c.type==='next_message'&&fields(c,['type']))conditions.push({type:'next_message'});
    else if(c.type==='member_message'&&fields(c,['type','user_ids'])){
      if(!array(c.user_ids)||c.user_ids.length<1||c.user_ids.length>16||
        !c.user_ids.every(id=>canonicalId(id)&&id!==selfId)||new Set(c.user_ids).size!==c.user_ids.length)return;
      conditions.push({type:'member_message',user_ids:[...c.user_ids] as string[]});
    }else if(c.type==='after'&&fields(c,['type','delay_seconds'])){
      const pair=c.delay_seconds;
      if(!array(pair)||pair.length!==2||!integer(pair[0],1,86400)||!integer(pair[1],pair[0],ttl-1)||Object.keys(pair).length!==2)return;
      conditions.push({type:'after',delay_seconds:[pair[0],pair[1]]});
    }else if(c.type==='activity'&&fields(c,['type','window_seconds','min_messages'],['min_senders'])){
      const senders=Object.hasOwn(c,'min_senders')?c.min_senders:1;
      if(!integer(c.window_seconds,1,3600)||!integer(c.min_messages,1,512)||!integer(senders,1,64))return;
      conditions.push({type:'activity',window_seconds:c.window_seconds,min_messages:c.min_messages,min_senders:senders});
    }else return;
  }
  return {any_of:conditions,expires_in_seconds:ttl,...(typeof args.purpose==='string'?{purpose:args.purpose}:{})};
}

/** One instance per group. All times are epoch milliseconds; tool delays are seconds.
 * No callbacks, timers, network or persistence: the caller schedules nextDeadline. */
export class AttentionEngine {
  private readonly config:AttentionConfig;
  private readonly transactions=new WeakMap<AttentionTransaction,TransactionState>();
  private plans=new Map<string,Plan>();
  private history:Observation[]=[];
  private readonly sequences=new Set<number>();
  private evictedThrough=-1;
  private generation=0;
  private revision=0;
  constructor(config:AttentionConfig,private readonly random:()=>number=Math.random){
    if(!record(config)||!fields(config,['enabled'],['maxPlans'])||typeof config.enabled!=='boolean'||
       (Object.hasOwn(config,'maxPlans')&&!integer(config.maxPlans,1,32))||typeof random!=='function')throw new Error('Invalid attention configuration');
    this.config=Object.freeze({enabled:config.enabled,maxPlans:config.maxPlans??16});
  }
  observe(message:Observation):void{
    if(!this.config.enabled||!record(message)||!fields(message,['sequence','received','userId'])||
      !integer(message.sequence,0,Number.MAX_SAFE_INTEGER)||!integer(message.received,0,Number.MAX_SAFE_INTEGER-86400_000)||!canonicalId(message.userId)||
      message.sequence<=this.evictedThrough||this.sequences.has(message.sequence))return;
    this.history.push({sequence:message.sequence,received:message.received,userId:message.userId});
    this.sequences.add(message.sequence);
    // Accept out-of-order observations still inside the bounded sequence horizon.
    this.history.sort((a,b)=>a.sequence-b.sequence);
    while(this.history.length>512){const old=this.history.shift()!;this.sequences.delete(old.sequence);this.evictedThrough=old.sequence;}
  }
  private prune(now:number):void{for(const [id,plan] of this.plans)if(plan.expires<=now)this.plans.delete(id);}
  evaluate(now:number,unread:boolean):AttentionHit[]{
    time(now);this.prune(now);
    if(!this.config.enabled||unread!==true)return [];
    const hits:AttentionHit[]=[];
    for(const [id,plan] of this.plans){
      const evidence=this.history.filter(m=>m.sequence>plan.baseline&&m.received>=plan.installed&&m.received<=now);
      for(const [index,c] of plan.spec.any_of.entries()){
        let matched=false;
        if(c.type==='next_message')matched=evidence.length>0;
        else if(c.type==='member_message')matched=evidence.some(m=>c.user_ids.includes(m.userId));
        else if(c.type==='after')matched=plan.due[index]!==undefined&&plan.due[index]!<=now;
        else {const window=evidence.filter(m=>m.received>=now-c.window_seconds*1000);matched=window.length>=c.min_messages&&new Set(window.map(m=>m.userId)).size>=c.min_senders;}
        if(matched){hits.push({plan_id:id,reason:c.type,...(plan.spec.purpose!==undefined?{purpose:plan.spec.purpose}:{})});this.plans.delete(id);break;}
      }
    }
    return hits;
  }
  nextDeadline(now:number):number|undefined{
    time(now);this.prune(now);if(!this.config.enabled)return;
    let next:number|undefined;
    for(const plan of this.plans.values())for(const candidate of [plan.expires,...plan.due]){
      // Due timers remain latched via their stored due time, but cannot spin
      // while there are no unread messages. Expiry still gets a future wakeup.
      if(candidate!==undefined&&candidate>now&&(next===undefined||candidate<next))next=candidate;
    }
    return next;
  }
  begin(now:number,selfId:string):AttentionTransaction{
    time(now);if(!canonicalId(selfId))throw new Error('Invalid attention self identity');this.prune(now);
    const tx:AttentionTransaction=Object.freeze({attention_transaction:true});
    this.transactions.set(tx,{generation:this.generation,selfId,closed:false,
      revisions:new Map([...this.plans].map(([id,p])=>[id,p.revision])),view:new Map([...this.plans].map(([id,p])=>[id,p.spec])),changes:new Map()});
    return tx;
  }
  private state(tx:AttentionTransaction):TransactionState|undefined{
    if(!tx||typeof tx!=='object')return;
    const state=this.transactions.get(tx);
    return state&&!state.closed&&state.generation===this.generation?state:undefined;
  }
  stage(tx:AttentionTransaction,args:unknown,now:number):JsonObject{
    time(now);if(!this.config.enabled)return error('tool_disabled');
    const state=this.state(tx);if(!state)return error('invalid_transaction');
    if(!record(args)||typeof args.operation!=='string'||!['create','update','cancel'].includes(args.operation))return error('invalid_arguments');
    const operation=args.operation;
    const needed=operation==='create'?['operation','any_of','expires_in_seconds']:operation==='update'?['operation','plan_id','any_of','expires_in_seconds']:['operation','plan_id'];
    if(!fields(args,needed,operation==='cancel'?[]:['purpose']))return error('invalid_arguments');
    let id:string;
    if(operation==='create'){
      if(state.view.size>=this.config.maxPlans)return error('plan_limit');
      do{id=`att_${randomBytes(8).toString('hex')}`;}while(state.view.has(id)||state.revisions.has(id)||state.changes.has(id)||this.plans.has(id));
    }else{
      if(!planId(args.plan_id))return error('invalid_arguments');id=args.plan_id;
      if(!state.view.has(id))return error('plan_not_found');
    }
    const spec=operation==='cancel'?null:parseSpec(args,state.selfId);
    if(spec===undefined)return error('invalid_arguments');
    // Validation is complete before any transaction state changes.
    if(spec===null)state.view.delete(id);else state.view.set(id,spec);
    state.changes.set(id,spec);
    return {status:'staged',operation,plan_id:id};
  }
  commit(tx:AttentionTransaction,now:number,sequence:number):JsonObject{
    time(now);if(!integer(sequence,0,Number.MAX_SAFE_INTEGER))return error('invalid_arguments');
    if(!this.config.enabled)return error('tool_disabled');
    const state=this.state(tx);if(!state)return error('invalid_transaction');
    state.closed=true;this.prune(now);
    const next=new Map(this.plans),applied:string[]=[],skipped:string[]=[];
    const valid=new Map<string,Spec|null>();
    for(const [id,spec] of state.changes){
      const expected=state.revisions.get(id),live=this.plans.get(id);
      if(expected!==undefined?live?.revision!==expected:live!==undefined){skipped.push(id);continue;}
      valid.set(id,spec);
    }
    // Apply final valid removals first. A stale cancel never frees capacity;
    // cancel+recreate in one transaction can reuse only its own freed slots.
    for(const [id,spec] of valid)if(spec===null){next.delete(id);applied.push(id);}
    let revision=this.revision;
    try{
      for(const [id,spec] of valid){
        if(spec===null)continue;
        if(!next.has(id)&&next.size>=this.config.maxPlans){skipped.push(id);continue;}
        const due=spec.any_of.map(c=>{
          if(c.type!=='after')return undefined;
          const value=this.random();if(!Number.isFinite(value)||value<0||value>1)throw new Error('Invalid jitter');
          const [min,max]=c.delay_seconds;
          return now+(min+Math.min(max-min,Math.floor(value*(max-min+1))))*1000;
        });
        next.set(id,{id,revision:++revision,spec,installed:now,baseline:sequence,expires:now+spec.expires_in_seconds*1000,due});applied.push(id);
      }
    }catch{return error('random_failed');}
    this.plans=next;this.revision=revision;
    return {status:'committed',applied,skipped};
  }
  clear():void{this.plans.clear();this.history=[];this.sequences.clear();this.evictedThrough=-1;this.generation++;}
  snapshot(now:number):JsonObject[]{
    time(now);this.prune(now);if(!this.config.enabled)return [];
    return [...this.plans.values()].map(plan=>({plan_id:plan.id,...(plan.spec.purpose!==undefined?{purpose:plan.spec.purpose}:{}),
      any_of:plan.spec.any_of.map((condition,index)=>({...structuredClone(condition),...(condition.type==='after'?{due_at:plan.due[index],remaining_seconds:Math.max(0,Math.ceil((plan.due[index]!-now)/1000))}:{})})),
      expires_in_seconds:plan.spec.expires_in_seconds,expires_at:plan.expires,remaining_seconds:Math.max(0,Math.ceil((plan.expires-now)/1000))}));
  }
}

const schema=(properties:JsonObject,required:string[]):JsonObject=>({type:'object',properties,required,additionalProperties:false});
const seconds=(min:number,max:number):JsonObject=>({type:'integer',minimum:min,maximum:max});
const conditions:JsonObject={type:'array',minItems:1,maxItems:8,items:{oneOf:[
  schema({type:{const:'next_message'}},['type']),
  schema({type:{const:'member_message'},user_ids:{type:'array',description:'其中任意一人发言即满足；若要分别等待每个人的回答，必须为不同的人创建独立计划。',minItems:1,maxItems:16,uniqueItems:true,items:{type:'string',pattern:'^[1-9][0-9]{0,31}$'}}},['type','user_ids']),
  schema({type:{const:'after'},delay_seconds:{type:'array',minItems:2,maxItems:2,items:seconds(1,86400),description:'[最短秒数,最长秒数]，有序且计划有效期必须严格长于最大等待秒数；提交时只随机抽一次。'}},['type','delay_seconds']),
  schema({type:{const:'activity'},window_seconds:seconds(1,3600),min_messages:seconds(1,512),min_senders:{...seconds(1,64),default:1}},['type','window_seconds','min_messages']),
]}};
const planFields={any_of:conditions,expires_in_seconds:seconds(1,86400),purpose:{type:'string',maxLength:160,description:'可选的等待意图，不是新的用户指令。'}};
export const MANAGE_ATTENTION_TOOL:ToolDefinition={type:'function',function:{name:'manage_attention',
 description:'暂存本群关注计划操作，本轮正常结束时才提交；失败或取消不提交。create新增独立计划，update必须指定ID且仅替换该计划，cancel仅取消指定ID；不同计划独立共存，计划内any_of任选其一触发并消费该计划。设置计划不算回复或群管理授权，不会发消息。新/更新计划提交后才开始计时、等待新消息；不要复制snapshot中的due_at等只读字段。调用计入本次唤醒统一工具预算，同时存在的计划数量受本群配置限制。',
 parameters:{type:'object',properties:{operation:{type:'string',enum:['create','update','cancel']},plan_id:{type:'string',pattern:'^att_[a-f0-9]{16}$',maxLength:20},...planFields},required:['operation'],additionalProperties:false,oneOf:[
   schema({operation:{const:'create'},...planFields},['operation','any_of','expires_in_seconds']),
   schema({operation:{const:'update'},plan_id:{type:'string',pattern:'^att_[a-f0-9]{16}$'},...planFields},['operation','plan_id','any_of','expires_in_seconds']),
   schema({operation:{const:'cancel'},plan_id:{type:'string',pattern:'^att_[a-f0-9]{16}$'}},['operation','plan_id']),
 ]}}};
