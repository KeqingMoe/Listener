import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSession} from '../src/model-session.js';
import type {Completion,ToolDefinition} from '../src/contracts.js';
const tool:ToolDefinition={type:'function',function:{name:'finish',description:'end',parameters:{type:'object',properties:{},required:[]}}};
const second:ToolDefinition={type:'function',function:{name:'send_message',description:'send',parameters:{type:'object'}}};
const completion=(...calls:any[]):Completion=>({content:null,tool_calls:calls});
const call=(id:string,name='finish',args='{}')=>({id,type:'function' as const,function:{name,arguments:args}});
function file(){const dir=mkdtempSync(join(tmpdir(),'qq-session-'));return{dir,path:join(dir,'session.sqlite')};}
function cleanup(x:{dir:string}){rmSync(x.dir,{recursive:true,force:true});}

test('reopen preserves stable system/transcript prefix and group isolation',()=>{const x=file();try{
 let s=new ModelSession({path:x.path,groupId:'123456789'});const first=s.beginWake('stable instructions',[tool],{reason:'test'});s.appendInput('observe');s.appendAssistant(completion(call('c1','finish')),'req-1');s.startTool('c1');s.finishTool('c1',{status:'ok'});s.finishWake();s.close();
 s=new ModelSession({path:x.path,groupId:'123456789'});assert.equal(s.messages()[0]!.content,'stable instructions');assert.ok(s.messages().some(m=>m.role==='tool'&&m.tool_call_id==='c1'));assert.throws(()=>new ModelSession({path:x.path,groupId:'100000002'}),/group/);s.close();assert.notEqual(first.length,0);
 }finally{cleanup(x);}});

test('configuration fingerprint rotates current projection but keeps audit journal',()=>{const x=file();try{const s=new ModelSession({path:x.path});s.beginWake('a',[tool]);s.finishWake();const old=s.state().sessionId;s.beginWake('b',[second]);assert.notEqual(s.state().sessionId,old);assert.equal(s.messages()[0]!.content,'b');s.close();}finally{cleanup(x);}});

test('ledger intent is durable, crash recovery marks started unknown and never replays',()=>{const x=file();try{let s=new ModelSession({path:x.path});s.beginWake('instructions',[tool]);s.appendAssistant(completion(call('write','send_message','{}')));assert.equal(s.startTool('write'),true);s.close();s=new ModelSession({path:x.path});const rows=s.messages();const result=rows.find(m=>m.role==='tool'&&m.tool_call_id==='write');assert.ok(result);assert.match(String(result?.content),/unknown/);assert.equal(s.startTool('write'),false);s.close();}finally{cleanup(x);}});

test('unstarted calls are skipped and duplicate result never overwrites',()=>{const x=file();try{const s=new ModelSession({path:x.path});s.beginWake('instructions',[tool,second]);s.appendAssistant(completion(call('a','send_message','{}'),call('b','finish','{}')));assert.equal(s.startTool('a'),true);s.finishTool('a',{status:'ok'});assert.doesNotThrow(()=>s.finishTool('a',{status:'error'}));s.skipPending('budget');const results=s.messages().filter(m=>m.role==='tool');assert.equal(results.length,2);assert.match(String(results[1]!.content),/skipped/);s.close();}finally{cleanup(x);}});

test('finish result closes pending trailing calls with explicit skipped results',()=>{const x=file();try{const s=new ModelSession({path:x.path});s.beginWake('instructions',[tool]);s.appendAssistant(completion(call('f','finish','{}'),call('later','send_message','{}')));assert.equal(s.startTool('f'),true);s.finishTool('f',{status:'ok'});const results=s.messages().filter(m=>m.role==='tool');assert.equal(results.length,2);assert.match(String(results[1]!.content),/turn_finished/);s.close();}finally{cleanup(x);}});

test('transport checkpoint is bounded and reset clears it',()=>{const x=file();try{const s=new ModelSession({path:x.path});s.setTransportCheckpoint({response_id:'private'});assert.deepEqual(s.getTransportCheckpoint(),{response_id:'private'});assert.throws(()=>s.setTransportCheckpoint({blob:'x'.repeat(300000)}),/resource/);s.reset('manual');assert.equal(s.getTransportCheckpoint(),undefined);s.close();}finally{cleanup(x);}});

test('symlink database is refused before opening',()=>{const x=file(),link=x.path+'-link';try{writeFileSync(x.path,'not sqlite');symlinkSync(x.path,link);assert.throws(()=>new ModelSession({path:link}),/symlink|file/);}finally{cleanup(x);try{rmSync(link)}catch{}}});
