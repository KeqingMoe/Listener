import test from 'node:test';
import assert from 'node:assert/strict';
import {AttentionEngine,MANAGE_ATTENTION_TOOL,type AttentionTransaction} from '../src/agent/attention.js';

const make=(maxPlans=16,random=()=>0.5)=>new AttentionEngine({enabled:true,maxPlans},random);
const next={type:'next_message'};
const member=(id:string)=>({type:'member_message',user_ids:[id]});
const after=(min=5,max=min)=>({type:'after',delay_seconds:[min,max]});
const activity=(count:number,senders=1,window=10)=>({type:'activity',window_seconds:window,min_messages:count,min_senders:senders});
function create(e:AttentionEngine,tx:AttentionTransaction,conditions:unknown[]= [next],ttl=60,purpose?:string){
 const result=e.stage(tx,{operation:'create',any_of:conditions,expires_in_seconds:ttl,...(purpose!==undefined?{purpose}:{})},0);
 assert.equal(result.status,'staged');assert.match(result.plan_id as string,/^att_[a-f0-9]{16}$/);return result.plan_id as string;
}
function install(e:AttentionEngine,conditions:unknown[]=[next],now=0,baseline=0,ttl=60){const tx=e.begin(now,'99');const id=create(e,tx,conditions,ttl);assert.equal(e.commit(tx,now,baseline).status,'committed');return id;}
const observe=(e:AttentionEngine,sequence:number,userId='1',received=1000)=>e.observe({sequence,userId,received});

test('independent member plans coexist; a hit consumes only its own OR plan',()=>{
 const e=make(),tx=e.begin(0,'99');const a=create(e,tx,[member('1'),after(10)],60,'等待A的版本');const b=create(e,tx,[member('2'),after(20)]);
 assert.deepEqual(e.snapshot(0),[]);assert.deepEqual(e.commit(tx,0,0),{status:'committed',applied:[a,b],skipped:[]});
 observe(e,1,'1');assert.deepEqual(e.evaluate(1000,true),[{plan_id:a,reason:'member_message',purpose:'等待A的版本'}]);
 assert.deepEqual(e.snapshot(1000).map(p=>p.plan_id),[b]);
 observe(e,2,'2',2000);assert.deepEqual(e.evaluate(2000,true),[{plan_id:b,reason:'member_message'}]);assert.deepEqual(e.evaluate(20000,true),[]);
});
test('one message can hit multiple independent plans but only once per plan',()=>{
 const e=make(),tx=e.begin(0,'99');const a=create(e,tx,[member('1'),next]),b=create(e,tx,[next]);e.commit(tx,0,0);
 observe(e,1);assert.deepEqual(e.evaluate(1000,true),[{plan_id:a,reason:'member_message'},{plan_id:b,reason:'next_message'}]);assert.deepEqual(e.evaluate(1000,true),[]);
});
test('jitter draws only at install, once per after condition; due no-unread latches without spinning',()=>{
 let draws=0;const e=make(16,()=>{draws++;return 0.5;});const tx=e.begin(0,'99');const id=create(e,tx,[after(5,9)],20);
 e.stage(tx,{operation:'update',plan_id:id,any_of:[after(5,9)],expires_in_seconds:20},10);assert.equal(draws,0);
 e.commit(tx,1000,0);assert.equal(draws,1);assert.equal(e.nextDeadline(1000),8000);
 assert.deepEqual(e.evaluate(8000,false),[]);assert.equal(e.nextDeadline(8000),21000);assert.equal(e.nextDeadline(9000),21000);
 e.snapshot(9000);e.evaluate(9000,false);assert.equal(draws,1);
 assert.deepEqual(e.evaluate(10000,true),[{plan_id:id,reason:'after'}]);assert.equal(e.nextDeadline(10000),undefined);
});
test('after maximum must be strictly earlier than TTL; rejection preserves live and staged plans',()=>{
 const e=make(),id=install(e,[after(2)],0,0,10),tx=e.begin(0,'99');const staged=create(e,tx,[member('2')]);
 const before=e.snapshot(0);
 for(const pair of [[1,10],[10,10],[1,11]]){
  assert.equal(e.stage(tx,{operation:'update',plan_id:id,any_of:[after(pair[0]!,pair[1]!)],expires_in_seconds:10},0).error,'invalid_arguments');
  assert.equal(e.stage(tx,{operation:'create',any_of:[after(pair[0]!,pair[1]!)],expires_in_seconds:10},0).error,'invalid_arguments');
 }
 assert.deepEqual(e.snapshot(0),before);assert.deepEqual(e.commit(tx,0,0),{status:'committed',applied:[staged],skipped:[]});
 assert.deepEqual(e.evaluate(2000,true),[{plan_id:id,reason:'after'}]);assert.equal(e.snapshot(2000)[0]!.plan_id,staged);
});
test('TTL expires even without unread and snapshot prunes without consuming eligible plans',()=>{
 const e=make();const id=install(e,[after(1)],0,0,3);
 assert.equal(e.snapshot(1000)[0]!.plan_id,id);assert.deepEqual(e.evaluate(2000,false),[]);
 assert.equal(e.snapshot(2000).length,1);assert.deepEqual(e.evaluate(3000,true),[]);assert.equal(e.nextDeadline(3000),undefined);
 const another=install(e,[next],3000,0,1);assert.equal(e.snapshot(3999)[0]!.plan_id,another);assert.deepEqual(e.snapshot(4000),[]);
});
test('next/member/activity evidence requires sequence beyond baseline and installed timestamp',()=>{
 const e=make();install(e,[next,member('1'),activity(1)],1000,5);
 observe(e,5,'1',1100);observe(e,6,'1',999);observe(e,7,'1',2000);
 assert.deepEqual(e.evaluate(1500,true),[]);
 observe(e,8,'1',1500);assert.equal(e.evaluate(1500,true)[0]!.reason,'next_message');
});
test('activity requires both message and sender thresholds within its window',()=>{
 const e=make();const id=install(e,[activity(3,2,2)]);
 observe(e,1,'1',1000);observe(e,2,'1',1100);observe(e,3,'1',1200);assert.deepEqual(e.evaluate(1200,true),[]);
 observe(e,4,'2',4000);assert.deepEqual(e.evaluate(4000,true),[]);
 observe(e,5,'1',4100);observe(e,6,'1',4200);assert.deepEqual(e.evaluate(4200,true),[{plan_id:id,reason:'activity'}]);
});
test('history retains at most 512 observations and duplicate sequences never count twice',()=>{
 const e=make();install(e,[activity(512,2,3600)]);
 for(let n=1;n<=513;n++)observe(e,n,'1',1000);
 observe(e,1,'2',1100);observe(e,513,'2',1100);assert.deepEqual(e.evaluate(1100,true),[]);
 assert.equal((e as any).history.length,512);
 observe(e,514,'2',1200);assert.equal(e.evaluate(1200,true).length,1);
});
test('out-of-order sequences still inside history horizon are retained',()=>{
 const e=make();install(e,[activity(2)]);observe(e,2);observe(e,1);assert.equal(e.evaluate(1000,true).length,1);
});
test('unrelated transaction retains existing deadline and evidence baseline',()=>{
 const e=make(),a=install(e,[after(10)]);const btx=e.begin(2000,'99');const b=create(e,btx,[member('2')]);
 const before=e.snapshot(2000).find(p=>p.plan_id===a);e.commit(btx,5000,100);
 assert.deepEqual(e.snapshot(5000).find(p=>p.plan_id===a)?.any_of,before!.any_of instanceof Array?[{...(before!.any_of as any[])[0],remaining_seconds:5}]:[]);
 assert.equal((e.snapshot(5000).find(p=>p.plan_id===b)!.any_of as any[])[0].type,'member_message');assert.equal(e.nextDeadline(5000),10000);
 assert.deepEqual(e.evaluate(10000,true),[{plan_id:a,reason:'after'}]);
 const c=install(e,[member('3')],10000,100);const tx=e.begin(10000,'99');create(e,tx);e.commit(tx,12000,200);
 observe(e,101,'3',11000);assert.ok(e.evaluate(12000,true).some(hit=>hit.plan_id===c));
});
test('multiple creates, explicit updates and cancel of staged creations form one transaction view',()=>{
 const e=make(2),tx=e.begin(0,'99'),a=create(e,tx),b=create(e,tx);
 assert.equal(e.stage(tx,{operation:'create',any_of:[next],expires_in_seconds:60},0).error,'plan_limit');
 assert.equal(e.stage(tx,{operation:'cancel',plan_id:a},0).status,'staged');const c=create(e,tx,[member('3')]);
 assert.equal(e.stage(tx,{operation:'update',plan_id:b,any_of:[member('2')],expires_in_seconds:30,purpose:'wait B'},0).status,'staged');
 assert.deepEqual(e.snapshot(0),[]);e.commit(tx,5000,10);
 assert.deepEqual(e.snapshot(5000).map(p=>p.plan_id),[b,c]);
 observe(e,11,'2',5100);assert.deepEqual(e.evaluate(5100,true),[{plan_id:b,reason:'member_message',purpose:'wait B'}]);
});
test('consumed and expired plans cannot be resurrected by stale update; independent creates survive',()=>{
 for(const expire of [false,true]){
  const e=make(),a=install(e,[next],0,0,1),tx=e.begin(0,'99');
  assert.equal(e.stage(tx,{operation:'update',plan_id:a,any_of:[after(1)],expires_in_seconds:10},0).status,'staged');const b=create(e,tx);
  if(expire)e.evaluate(1000,false);else{observe(e,1,'1',100);e.evaluate(100,true);}
  assert.deepEqual(e.commit(tx,1000,1),{status:'committed',applied:[b],skipped:[a]});assert.deepEqual(e.snapshot(1000).map(p=>p.plan_id),[b]);
 }
});
test('another committed update invalidates revision without overwriting it',()=>{
 const e=make(),id=install(e),old=e.begin(0,'99'),fresh=e.begin(0,'99');
 e.stage(old,{operation:'update',plan_id:id,any_of:[member('1')],expires_in_seconds:10},0);
 e.stage(fresh,{operation:'update',plan_id:id,any_of:[member('2')],expires_in_seconds:20},0);e.commit(fresh,1000,1);
 assert.deepEqual(e.commit(old,2000,2),{status:'committed',applied:[],skipped:[id]});
 observe(e,2,'2',2000);assert.equal(e.evaluate(2000,true)[0]!.plan_id,id);
});
test('capacity rechecked against live plans and stale cancel does not free another revision',()=>{
 const e=make(1),id=install(e),old=e.begin(0,'99'),fresh=e.begin(0,'99');
 e.stage(old,{operation:'cancel',plan_id:id},0);const replacement=create(e,old);
 e.stage(fresh,{operation:'update',plan_id:id,any_of:[member('2')],expires_in_seconds:60},0);e.commit(fresh,0,0);
 const result=e.commit(old,0,0);assert.deepEqual(result.applied,[]);assert.deepEqual(result.skipped,[id,replacement]);assert.equal(e.snapshot(0).length,1);
 const f=make(1),a=f.begin(0,'99'),b=f.begin(0,'99');const aid=create(f,a),bid=create(f,b);f.commit(a,0,0);
 assert.deepEqual(f.commit(b,0,0),{status:'committed',applied:[],skipped:[bid]});assert.equal(f.snapshot(0)[0]!.plan_id,aid);
});
test('discard, clear, foreign, forged and reused transactions cannot install plans',()=>{
 const a=make(),b=make(),tx=a.begin(0,'99');create(a,tx);assert.deepEqual(a.snapshot(100),[]);
 assert.equal(b.stage(tx,{operation:'create',any_of:[next],expires_in_seconds:1},0).error,'invalid_transaction');
 assert.equal(b.commit(tx,0,0).error,'invalid_transaction');
 assert.equal(a.commit({attention_transaction:true},0,0).error,'invalid_transaction');
 a.clear();assert.equal(a.commit(tx,0,0).error,'invalid_transaction');assert.deepEqual(a.snapshot(0),[]);
 const good=a.begin(0,'99');create(a,good);a.commit(good,0,0);assert.equal(a.commit(good,0,0).error,'invalid_transaction');
 observe(a,1);a.clear();install(a);observe(a,1);assert.equal(a.evaluate(1000,true).length,1);
});
test('invalid stage is atomic and strict, including self waiting and undefined/extra fields',()=>{
 const e=make(),tx=e.begin(0,'99'),id=create(e,tx,[member('1')]);
 const valid={operation:'create',any_of:[next],expires_in_seconds:10};
 const bad:unknown[]=[null,[],{}, {...valid,operation:'replace'}, {...valid,extra:true},{...valid,purpose:undefined},{...valid,purpose:'bad\ntext'},{...valid,purpose:'x'.repeat(161)},
  {...valid,expires_in_seconds:0},{...valid,expires_in_seconds:86401},{...valid,expires_in_seconds:1.1},{...valid,any_of:[]},{...valid,any_of:Array(9).fill(next)},
  {...valid,any_of:[{type:'next_message',extra:1}]},{...valid,any_of:[member('99')]},{...valid,any_of:[member('01')]},{...valid,any_of:[member('1\n')]},
  {...valid,any_of:[{type:'member_message',user_ids:['1','1']}]},{...valid,any_of:[{type:'member_message',user_ids:[1]}]},
  {...valid,any_of:[after(0)]},{...valid,any_of:[after(5,4)]},{...valid,any_of:[after(1,11)]},
  {...valid,any_of:[{...activity(1),min_senders:undefined}]},{...valid,any_of:[activity(513)]},{...valid,any_of:[activity(1,65)]},
  {...valid,any_of:[activity(1,1,3601)]},{operation:'cancel',plan_id:id,any_of:[]},{operation:'update',plan_id:id,any_of:[next],expires_in_seconds:10,purpose:undefined},
  {...valid,any_of:[{type:'member_message',user_ids:new Array(1)}]}, {...valid,any_of:new Array(1)}];
 for(const args of bad)assert.equal(e.stage(tx,args,0).status,'error');
 assert.equal(e.stage(tx,{operation:'update',plan_id:'att_0000000000000000',any_of:[next],expires_in_seconds:10},0).error,'plan_not_found');
 assert.deepEqual(e.commit(tx,0,0),{status:'committed',applied:[id],skipped:[]});observe(e,1);assert.equal(e.evaluate(1000,true)[0]!.plan_id,id);
});
test('many attention updates are accepted here and budgeted by the wake runner',()=>{
 const e=make(),tx=e.begin(0,'99'),id=create(e,tx);
 for(let n=1;n<=64;n++)assert.equal(e.stage(tx,{operation:'update',plan_id:id,any_of:[next],expires_in_seconds:10},0).status,'staged');
 assert.equal(e.stage(tx,{operation:'cancel',plan_id:id},0).status,'staged');assert.equal(e.commit(tx,0,0).status,'committed');assert.equal(e.snapshot(0).length,0);
});
test('snapshot and caller arguments cannot mutate installed private state',()=>{
 const e=make(),tx=e.begin(0,'99');const c=member('1');const id=create(e,tx,[c]);c.user_ids[0]='2';e.commit(tx,0,0);
 const snapshots=e.snapshot(0);(snapshots[0]!.any_of as any[])[0].user_ids[0]='3';snapshots[0]!.plan_id='corrupt';
 observe(e,1,'1');assert.equal(e.evaluate(1000,true)[0]!.plan_id,id);
});
test('bad random draws fail atomically and only valid committed after conditions draw',()=>{
 let calls=0;const e=make(2,()=>{if(++calls===2)return NaN;return 0;});const tx=e.begin(0,'99');create(e,tx,[after(1)]);create(e,tx,[after(2)]);
 assert.equal(e.commit(tx,0,0).error,'random_failed');assert.deepEqual(e.snapshot(0),[]);
 const f=make(2,()=>1);install(f,[after(1,3)]);assert.equal(f.nextDeadline(0),3000);
});
test('configuration, disabled behavior, time and tool schema are bounded',()=>{
 for(const maxPlans of [0,33,1.5,NaN])assert.throws(()=>new AttentionEngine({enabled:true,maxPlans}));
 const e=new AttentionEngine({enabled:false,maxPlans:16}),tx=e.begin(0,'99');
 assert.equal(e.stage(tx,{operation:'create',any_of:[next],expires_in_seconds:1},0).error,'tool_disabled');assert.equal(e.commit(tx,0,0).error,'tool_disabled');
 observe(e,1);assert.deepEqual(e.snapshot(0),[]);assert.deepEqual(e.evaluate(0,true),[]);assert.equal(e.nextDeadline(0),undefined);
 assert.throws(()=>e.begin(-1,'99'));assert.throws(()=>e.begin(0,'01'));assert.throws(()=>e.evaluate(NaN,true));
 assert.equal(MANAGE_ATTENTION_TOOL.function.name,'manage_attention');const variants=MANAGE_ATTENTION_TOOL.function.parameters.oneOf as any[];
 assert.equal(variants.length,3);assert.ok(variants.every(v=>v.additionalProperties===false));assert.deepEqual(variants[2].required,['operation','plan_id']);
});
