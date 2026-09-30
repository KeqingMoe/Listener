import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSession} from '../../../../src/agent/session/store.ts';
import type { Completion } from '../../../../src/contracts/model.ts';
import type { ToolDefinition } from '../../../../src/contracts/tools.ts';
const tool:ToolDefinition={type:'function',function:{name:'finish',description:'end',parameters:{type:'object',properties:{},required:[]}}};
const second:ToolDefinition={type:'function',function:{name:'send_message',description:'send',parameters:{type:'object'}}};
const completion=(...calls:any[]):Completion=>({content:null,tool_calls:calls});
const call=(id:string,name='finish',args='{}')=>({id,type:'function' as const,function:{name,arguments:args}});
function file(){const dir=mkdtempSync(join(tmpdir(),'qq-session-'));return{dir,path:join(dir,'session.sqlite')};}
function cleanup(x:{dir:string}){rmSync(x.dir,{recursive:true,force:true});}

test('images remain transient, recovered session rotates explicitly and clears transport chain',()=>{
 const x=file();try{let s=new ModelSession({path:x.path});s.beginWake('instructions',[tool]);const old=s.state();
 const image='data:image/jpeg;base64,PRIVATE_IMAGE_BYTES_DO_NOT_PERSIST';
 s.appendInput([{type:'text',text:'image follows'},{type:'image_url',image_url:{url:image}}]);
 assert.ok(JSON.stringify(s.messages()).includes(image));s.setTransportCheckpoint({response_id:'prior_image_response'});s.finishWake();s.close();
 assert.equal(readFileSync(x.path).includes(Buffer.from(image)),false);
 s=new ModelSession({path:x.path});assert.notEqual(s.state().sessionId,old.sessionId);assert.equal(s.state().resetReason,'transient_images_lost');assert.equal(s.getTransportCheckpoint(),undefined);
 assert.deepEqual(s.messages(),[]);assert.match(JSON.stringify(s.beginWake('instructions',[tool])),/read_tools_again/);s.close();
 }finally{cleanup(x);}
});

test('transcript limits fail closed and rotate explicitly while preserving old ledger audit',()=>{
 const x=file();try{let s=new ModelSession({path:x.path,maxTranscriptBytes:4096});s.beginWake('instructions',[tool]);
 assert.throws(()=>s.appendAssistant(completion(call('large','send_message','x'.repeat(5000)))),/resource/);
 const before=s.messages();s.appendAssistant(completion(call('write','send_message'),call('skip','send_message')));s.startTool('write');
 assert.throws(()=>s.finishTool('write',{status:'ok',body:'x'.repeat(6000)}),/resource/);s.close();
 s=new ModelSession({path:x.path,maxTranscriptBytes:4096});const recovered=s.messages().filter(m=>m.role==='tool');assert.equal(recovered.length,2);assert.match(String(recovered[0]!.content),/unknown/);assert.match(String(recovered[1]!.content),/skipped/);
 s.beginWake('instructions',[tool]);s.appendInput('x'.repeat(3000));s.finishWake();const prior=s.state().sessionId;
 assert.match(JSON.stringify(s.beginWake('instructions',[tool])),/transcript_resource_boundary/);assert.notEqual(s.state().sessionId,prior);assert.equal(before[0]!.content,'instructions');s.close();
 const db=new DatabaseSync(x.path,{readOnly:true});assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM model_tool_ledger').get()!.n),2);db.close();
 }finally{cleanup(x);}
});

test('returned snapshots are immutable and request/call IDs are scoped to assistant checkpoints',()=>{
 const s=new ModelSession({path:':memory:'});s.beginWake('stable',[second]);const output=completion(call('reuse','send_message','{invalid json'));const a=s.appendAssistant(output,'request');
 assert.deepEqual(s.appendAssistant(output,'request'),a);assert.throws(()=>s.appendAssistant(completion(call('different')),'request'),/conflict/);s.startTool('reuse',a.assistantSeq);s.finishTool('reuse',{status:'ok'},a.assistantSeq);
 const snapshot=s.messages();snapshot[0]!.content='changed';assert.equal(s.messages()[0]!.content,'stable');s.finishWake();s.beginWake('stable',[second]);const b=s.appendAssistant(output,'request2');assert.notEqual(a.assistantSeq,b.assistantSeq);
 assert.equal(s.startTool('reuse',a.assistantSeq),false);assert.equal(s.startTool('reuse',b.assistantSeq),true);s.finishTool('reuse',{status:'ok'},b.assistantSeq);s.finishWake();s.close();
});

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
