import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSession} from '../src/model-session.js';
import type {Completion,ToolDefinition} from '../src/contracts/index.js';
const tools:ToolDefinition[]=[{type:'function',function:{name:'send_message',description:'send',parameters:{type:'object'}}},{type:'function',function:{name:'finish',description:'finish',parameters:{type:'object'}}}];
const call=(id:string,name='send_message')=>({id,type:'function' as const,function:{name,arguments:'{}'}});
const completion=(...calls:any[]):Completion=>({content:null,tool_calls:calls});
function make(){const dir=mkdtempSync(join(tmpdir(),'qq-analytics-'));return{dir,path:join(dir,'session.sqlite')}}
function clean(x:{dir:string}){rmSync(x.dir,{recursive:true,force:true})}

test('weighted durations, unknown and cached results are classified without claiming native RPCs',t=>{
 let now=100;t.mock.method(Date,'now',()=>now);const s=new ModelSession({path:':memory:'});s.beginWake('i',tools);const wake=s.state().wakeId!;
 s.appendAssistant(completion(call('a'),call('b'),call('c'),call('d')),'request');
 s.startTool('a');now=110;s.finishTool('a',{status:'ok',duplicate:true});now=120;s.startTool('b');now=150;s.finishTool('b',{status:'unknown',error:'PRIVATE error body'});
 s.startTool('c');now=170;s.finishTool('c',{status:'unrecognised',private:'SECRET_RESULT'});s.skipPending('budget');s.finishTool('a',{status:'error'});
 const summary=s.summarizeTools({since:100,until:100,wakeId:wake});assert.equal(summary.invocations,4);assert.equal(summary.successes,1);assert.equal(summary.unknown,2);assert.equal(summary.skipped,1);assert.equal(summary.totalDurationMs,60);assert.equal(summary.meanDurationMs,20);assert.equal(summary.modelRequests,1);assert.equal(summary.externalRequests,null);
 assert.equal(s.summarizeTools({since:101,until:200}).invocations,0);assert.equal(s.summarizeTools({since:0,until:200,sessionId:'not-this-session'}).invocations,0);
 const trace=s.getToolTrace({wakeId:wake,limit:99});assert.equal(JSON.stringify(trace).includes('PRIVATE'),false);assert.equal(JSON.stringify(trace).includes('SECRET_RESULT'),false);assert.equal(trace.items[1]!.errorCode,undefined);s.close();
});

test('huge requested trace limit remains byte bounded and cursor pages have no missing calls',()=>{
 const s=new ModelSession({path:':memory:'});s.beginWake('i',tools);const wake=s.state().wakeId!;
 const calls=Array.from({length:200},(_,i)=>({...call('id'+i+'x'.repeat(170)),function:{name:'send_message',arguments:JSON.stringify({text:'PRIVATE_ARGUMENT'})}}));s.appendAssistant(completion(...calls),'model-request');s.finishWake('budget');
 const ids:string[]=[];let cursor: number|undefined;
 do{const page=s.getToolTrace({wakeId:wake,limit:Number.MAX_SAFE_INTEGER,...(cursor!==undefined?{cursor}:{})});assert.ok(Buffer.byteLength(JSON.stringify(page))<=24*1024);assert.equal(JSON.stringify(page).includes('PRIVATE_ARGUMENT'),false);ids.push(...page.items.map(i=>i.callId));cursor=page.nextCursor;}while(cursor!==undefined);
 assert.equal(ids.length,200);assert.equal(new Set(ids).size,200);s.close();
});

test('analytics aggregates outcomes, durations, exposure and keeps private args out',()=>{const x=make();try{const s=new ModelSession({path:x.path,groupId:'123456789'});s.beginWake('instructions',tools,{trigger:'a'});const wakeA=s.state().wakeId!;s.appendAssistant(completion(call('ok')), 'request-a');assert.equal(s.startTool('ok'),true);s.finishTool('ok',{status:'ok',message_id:'private-1',secret:'do-not-export'});s.finishWake('done');
 s.beginWake('instructions',tools,{trigger:'b'});const wakeB=s.state().wakeId!;s.appendAssistant(completion(call('bad'),call('skip','finish')));assert.equal(s.startTool('bad'),true);s.finishTool('bad',{status:'error',error:'api_failed',secret:'private'});s.skipPending('budget');
 const summary=s.summarizeTools({since:0,until:Date.now()});assert.equal(summary.invocations,3);assert.equal(summary.started,2);assert.equal(summary.completed,3);assert.equal(summary.successes,1);assert.equal(summary.errors,1);assert.equal(summary.skipped,1);assert.equal(summary.externalRequests,null);assert.ok(summary.modelRequests>=1);assert.ok(summary.toolExposureCounts.some(x=>x.name==='send_message'&&x.wakes>=2));
 const trace=s.getToolTrace({wakeId:wakeA,limit:10});assert.equal(trace.returned,1);assert.equal(trace.items[0]!.status,'ok');assert.equal((trace.items[0] as any).secret,undefined);assert.equal((trace.items[0] as any).arguments,undefined);
 const availability=s.getToolAvailability({since:0,until:Date.now(),limit:10});assert.equal(availability.returned,2);assert.deepEqual(availability.items[0]!.exposedToolNames,['send_message','finish']);assert.equal(JSON.stringify(availability).includes('instructions'),false);s.close();}finally{clean(x)}});

test('analytics filters validate scope, inclusive time and limits',()=>{const x=make();try{const s=new ModelSession({path:x.path});s.beginWake('i',tools);s.appendAssistant(completion(call('a')));assert.throws(()=>s.summarizeTools({since:-1,until:2}),/window/);assert.throws(()=>s.getToolTrace({wakeId:s.state().wakeId!,limit:0}),/page/);assert.throws(()=>s.getToolAvailability({since:0,until:1,limit:1,extra:1} as any),/filter/);assert.throws(()=>s.getToolTrace({wakeId:s.state().wakeId!,limit:1,extra:1} as any),/filter/);s.close();}finally{clean(x)}});

test('analytics survives reopen and keeps group boundary',()=>{const x=make();try{let s=new ModelSession({path:x.path,groupId:'123456789'});s.beginWake('i',tools);s.appendAssistant(completion(call('a')));s.finishWake();s.close();s=new ModelSession({path:x.path,groupId:'123456789'});assert.equal(s.summarizeTools({since:0,until:Date.now()}).invocations,1);assert.throws(()=>new ModelSession({path:x.path,groupId:'100000002'}),/group/);s.close();}finally{clean(x)}});
