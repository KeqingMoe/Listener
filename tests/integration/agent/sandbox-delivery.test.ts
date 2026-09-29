import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Listener} from '../../../src/agent/listener.js';
import {ModelSession} from '../../../src/agent/session/store.js';
import {WorldEventStore} from '../../../src/world/events.js';
import {GroupRouter} from '../../../src/app/group-router.js';
import type {ChatMessage,Completion} from '../../../src/contracts/model.js';
import type {Memory} from '../../../src/contracts/messages.js';
import type {ListenerConfig} from '../../../src/config/listener.js';
const group='123456',self='999';
const config:ListenerConfig={groupId:group,enabled:true,baseUrl:'https://example.invalid',apiKey:'x',model:'x',timeoutMs:1000,maxTokens:128,debounceMs:1,cooldownMs:0,memoryPath:':memory:',maxContextChars:8000,retentionDays:7,randomReplyProbability:0};
const done=():Completion=>({content:null,tool_calls:[{id:'finish-'+Math.random(),type:'function',function:{name:'finish',arguments:'{}'}}]});
const memory:Memory={append:()=>true,recent:()=>[],find:()=>undefined,context:()=>'',async compact(){},clear(){},close(){}};
const result=(jobId='job_test')=>({selfId:self,groupId:group,jobId,status:'completed',description:'compute result',value:'42',finishedAt:Date.now()});
function fixture(path=':memory:',respond?:(messages:ChatMessage[])=>Promise<Completion>){
 const session=new ModelSession({path,groupId:group}),world=new WorldEventStore({path:':memory:',groupId:group}),requests:ChatMessage[][]=[];
 const bot=new Listener({async call(){assert.fail('host result must not synthesize QQ activity');}},{async complete(messages){requests.push(structuredClone(messages));return respond?respond(messages):done();}},memory,config,Math.random,undefined,undefined,{session,world,sandboxSummary:()=>({})});
 bot.setConnected(true);return {bot,session,world,requests,async close(){await bot.stop();world.close();session.close();}};
}
async function settled(f:ReturnType<typeof fixture>,count:number){for(let i=0;i<300;i++){if(f.requests.length>=count&&!f.session.state().wakeId)return;await delay(5);}assert.fail('sandbox host wake failed');}
test('idle host delivery wakes without QQ message, acknowledges projection and rejects other scope',async()=>{
 const f=fixture();try{
 assert.equal(await f.bot.receiveSandboxResult(result()),false);await settled(f,1);
 assert.equal(await f.bot.receiveSandboxResult(result()),true);await delay(20);assert.equal(f.requests.length,1);
 const users=f.requests[0]!.filter(m=>m.role==='user').map(m=>JSON.parse(String(m.content)));
 assert.equal(users.filter(m=>m.host_event?.job_id==='job_test').length,1);assert.equal(f.requests[0]!.filter(m=>m.role==='tool').length,0);
 assert.ok(!users.some(m=>m.host_event?.type==='javascript_job_summary'));
 await assert.rejects(f.bot.receiveSandboxResult({...result('other'),selfId:'888'}));await assert.rejects(f.bot.receiveSandboxResult({...result('other'),groupId:'654321'}));
 }finally{await f.close();}
});
test('background failure carries bounded guest diagnostics into model context',async()=>{
 const f=fixture();const diagnostic={kind:'guest_exception',phase:'execute',name:'ReferenceError',message:"'Intl' is not defined",stack:'at anonymous (<input>:6)',truncated:false};try{
 await f.bot.receiveSandboxResult({...result('diagnostic'),status:'failed',error:'execution_error',diagnostic});await settled(f,1);
 const payload=f.requests[0]!.filter(m=>m.role==='user').map(m=>JSON.parse(String(m.content))).find(m=>m.host_event?.job_id==='diagnostic');
 assert.deepEqual(payload.host_event.diagnostic,diagnostic);assert.equal(payload.host_event.error,'execution_error');
 }finally{await f.close();}
});
test('escaped maximum string result projects intact rather than remaining undeliverable',async()=>{
 const f=fixture();const value='\u0000'.repeat(64*1024);try{
 assert.equal(await f.bot.receiveSandboxResult({...result('escaped'),value}),false);await settled(f,1);
 const payload=f.requests[0]!.filter(m=>m.role==='user').map(m=>JSON.parse(String(m.content))).find(m=>m.host_event?.job_id==='escaped');
 assert.equal(payload.host_event.value,value);assert.equal(await f.bot.receiveSandboxResult({...result('escaped'),value}),true);
 }finally{await f.close();}
});
test('busy listener queues completion until next wake boundary without duplicate results',async()=>{
 let release!:()=>void;const blocked=new Promise<void>(r=>release=r);let rounds=0;const f=fixture(':memory:',async()=>{if(++rounds===1)await blocked;return done();});
 try{await f.bot.receiveSandboxResult(result('first'));while(!f.requests.length)await delay(2);
 assert.equal(await f.bot.receiveSandboxResult(result('second')),false);assert.equal(f.requests.length,1);assert.equal(f.session.externalEventProjected(`${self}:second`,self),false);
 release();await settled(f,2);assert.equal(await f.bot.receiveSandboxResult(result('second')),true);
 assert.equal(f.requests[1]!.filter(m=>m.role==='user'&&String(m.content).includes('"job_id":"second"')).length,1);
 }finally{release();await f.close();}
});
test('persisted unprojected inbox reopens cold group and repeated dispatch does not wake again',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sandbox-delivery-')),path=join(dir,'session.sqlite');
 const initial=new ModelSession({path,groupId:group});initial.receiveExternalEvent(`${self}:job_test`,self,{job_id:'job_test',description:'restart',status:'completed',value:'42'});initial.close();
 let f:ReturnType<typeof fixture>|undefined;const router=new GroupRouter({enabled:()=>true,listGroups:async()=>[{group_id:group}],create:async()=>{f=fixture(path);return f.bot;}});
 try{await router.connect(self);assert.equal(router.residentSize,0);await assert.rejects(router.dispatchSandboxResult(result()));assert.ok(f);await settled(f,1);await router.dispatchSandboxResult(result());await delay(20);assert.equal(f.requests.length,1);
 await assert.rejects(router.dispatchSandboxResult({...result(),selfId:'888'}));await assert.rejects(router.dispatchSandboxResult({...result(),groupId:'654321'}));
 }finally{await router.stop();if(f){f.world.close();f.session.close();}rmSync(dir,{recursive:true,force:true});}
});
