import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../../src/dashboard/server/app.js';
import { AuthStore } from '../../../src/dashboard/server/auth.js';
import { ReviewRepository } from '../../../src/dashboard/server/review-repository.js';
import { RESOURCE_SYNC_TTL_MS, RESOURCE_SYNC_MAX_ENTRIES } from '../../../src/dashboard/server/resource-sync.js';
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'resource-sync-')),telemetryPath=join(dir,'t.sqlite'),sessionPath=join(dir,'s.sqlite');
 const db=new DatabaseSync(telemetryPath),session=new DatabaseSync(sessionPath);
 db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE model_requests(request_id TEXT PRIMARY KEY,group_id TEXT,turn_id TEXT,started_at INTEGER,ended_at INTEGER,duration_ms REAL,status TEXT,transport TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER,error_code TEXT);
 INSERT INTO model_requests VALUES('a','11','turn',100,200,100,'success','responses',100,10,40,NULL),('b','11','turn',300,400,100,'success','responses',20,10,0,NULL),('future','11',NULL,1050,1100,50,'success','responses',20,10,0,NULL);
 CREATE TABLE runtime_events(seq INTEGER PRIMARY KEY,observed_at INTEGER,event TEXT,group_id TEXT,turn_id TEXT,message_id TEXT,fields TEXT);
 INSERT INTO runtime_events VALUES(1,490,'app.heartbeat',NULL,NULL,NULL,'{"status":"connected"}'),(2,480,'onebot.ready',NULL,NULL,NULL,'{}');`);
 session.exec(`PRAGMA journal_mode=WAL; CREATE TABLE model_session_meta(singleton INTEGER,group_id TEXT);INSERT INTO model_session_meta VALUES(1,'11');
 CREATE TABLE model_session_journal(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,kind TEXT,payload TEXT,created_at INTEGER);
 INSERT INTO model_session_journal VALUES(1,'s','w','wake_begin','{}',90);
 CREATE TABLE model_session_messages(seq INTEGER,session_id TEXT,wake_id TEXT,request_id TEXT,message TEXT);
 CREATE TABLE model_tool_ledger(ordinal INTEGER,name TEXT,wake_id TEXT,state TEXT,arguments TEXT,result TEXT,proposed_at INTEGER,started_at INTEGER,finished_at INTEGER,assistant_seq INTEGER,call_id TEXT);`);
 const auth=new AuthStore({path:join(dir,'auth.sqlite'),password:'test-password-long'});
 const login=()=>{const r=auth.login('test-password-long','127.0.0.1');assert.equal(r.status,'ok');return `dashboard_session=${r.status==='ok'?r.token:''}`;};
 const cookie=login();let now=1000,groups=[{groupId:'11',sessionPath}];
 const options={auth,telemetryPath,getGroups:()=>groups,now:()=>now};let app=buildApp(options);
 const get=(resource:string,cursor?:string,c=cookie)=>app.inject({url:`/api/resource-sync?resource=${encodeURIComponent(resource)}${cursor===undefined?'':`&cursor=${encodeURIComponent(cursor)}`}`,headers:{cookie:c}});
 const sync=async(resource:string,cursor?:string,c=cookie)=>{const r=await get(resource,cursor,c);assert.equal(r.statusCode,200,r.body);return r.json();};
 return {db,session,auth,login,cookie,get,sync,app:()=>app,advance:(ms:number)=>{now+=ms;},revoke:()=>{groups=[];},restart:async()=>{await app.close();app=buildApp(options);},replace:()=>{const replacement=join(dir,'replacement');db.exec(`VACUUM INTO '${replacement}'`);renameSync(replacement,telemetryPath);},cleanup:async()=>{await app.close();db.close();session.close();auth.close();rmSync(dir,{recursive:true,force:true});}};
}
function apply(data:any,r:any):any {
 if(r.mode==='snapshot')return r.data;
 const result=structuredClone(data);
 if(r.mode==='patch')for(const p of r.patch){const keys=p.path.slice(1).split('/').map((x:string)=>x.replace(/~1/g,'/').replace(/~0/g,'~'));let target=result;for(const k of keys.slice(0,-1))target=target[k];const key=keys.at(-1)!;if(p.op==='remove'){if(Array.isArray(target))target.splice(Number(key),1);else delete target[key];}else Object.defineProperty(target,key,{value:p.value,writable:true,enumerable:true,configurable:true});}
 return result;
}
const requests='/api/requests?since=0&until=1000';
test('overview sync transitions from unknown legacy timings to measured summary and groups',async()=>{
 const f=fixture();try{
  const path='/api/overview?since=0&until=1000';let r=await f.sync(path),data=r.data;
  assert.equal(data.summary.ttftMs,null);assert.equal(data.summary.tps,null);
  f.db.exec(`ALTER TABLE model_requests ADD COLUMN ttft_ms REAL; ALTER TABLE model_requests ADD COLUMN decode_duration_ms REAL; UPDATE model_requests SET ttft_ms=20,decode_duration_ms=80 WHERE request_id='a';`);
  r=await f.sync(path,r.cursor);assert.notEqual(r.mode,'unchanged');data=apply(data,r);
  for(const summary of [data.summary,...data.groups,...data.series.filter((s:any)=>s.requests>0)]){assert.equal(summary.ttftMs,20);assert.equal(summary.tps,125);assert.equal(summary.performance.ttftMs,20);assert.equal(summary.performance.tps,125);}
  const unchanged=await f.sync(path,r.cursor);assert.equal(unchanged.mode,'unchanged');
  f.db.exec(`UPDATE model_requests SET ttft_ms=40,decode_duration_ms=60 WHERE request_id='a'`);
  const updated=await f.sync(path,unchanged.cursor);data=apply(data,updated);assert.equal(data.summary.ttftMs,40);assert.ok(Math.abs(data.groups[0].tps-10000/60)<1e-9);
 }finally{await f.cleanup();}
});
test('in-flight source changes never label stale projections as unchanged',async()=>{
 const f=fixture(),original=ReviewRepository.prototype.requests;let calls=0,write=true;
 ReviewRepository.prototype.requests=function(...args){calls++;const result=original.apply(this,args);if(write){write=false;f.db.exec("UPDATE model_requests SET status='running' WHERE request_id='a'");}return result;};
 try{const a=await f.sync(requests);const n=calls;const b=await f.sync(requests,a.cursor);assert.ok(calls>n);assert.equal(apply(a.data,b).items.find((r:any)=>r.requestId==='a').status,'running');}
 finally{ReviewRepository.prototype.requests=original;await f.cleanup();}
});
test('large existing detail projections pass through snapshots without caching or errors',async()=>{
 const f=fixture(),original=ReviewRepository.prototype.detail;let calls=0;
 ReviewRepository.prototype.detail=function(...args){calls++;const result=original.apply(this,args);return result ? {...result, testLargeBody:'x'.repeat(2*1024*1024)} as typeof result : result;};
 try{const list=await f.sync(requests);const path='/api/requests/a?groupId=11';const a=await f.sync(path);assert.equal(a.mode,'snapshot');assert.ok(a.data.testLargeBody.length>=2*1024*1024);const b=await f.sync(path,a.cursor);assert.equal(b.mode,'snapshot');assert.equal(calls,2);assert.equal(b.data.testLargeBody,a.data.testLargeBody);const unchanged=await f.sync(requests,list.cursor);assert.equal(unchanged.mode,'unchanged','large details preserve other resource cursors');assert.equal(unchanged.cursor,list.cursor);}
 finally{ReviewRepository.prototype.detail=original;await f.cleanup();}
});
test('resource sync skips unchanged handlers and applies updates/deletes/sliding boundary patches',async()=>{
 const f=fixture(),original=ReviewRepository.prototype.requests;let calls=0;
 ReviewRepository.prototype.requests=function(...args){calls++;return original.apply(this,args);};
 try{
  let r=await f.sync(requests),data=r.data;assert.equal(r.mode,'snapshot');const initialCalls=calls;
  const u=await f.sync('/api/requests?until=1000&since=0',r.cursor);assert.equal(u.mode,'unchanged');assert.equal(calls,initialCalls);
  f.db.exec("UPDATE model_requests SET status='running' WHERE request_id='a'");r=await f.sync(requests,u.cursor);assert.equal(r.mode,'patch');data=apply(data,r);assert.equal(data.items.find((x:any)=>x.requestId==='a').status,'running');
  f.db.exec("DELETE FROM model_requests WHERE request_id='b'");r=await f.sync(requests,r.cursor);data=apply(data,r);assert.deepEqual(data.items.map((x:any)=>x.requestId),['a']);
  r=await f.sync('/api/requests?since=101&until=1101',r.cursor);data=apply(data,r);assert.deepEqual(data.items.map((x:any)=>x.requestId),['future']);assert.ok(calls>initialCalls);
 }finally{ReviewRepository.prototype.requests=original;await f.cleanup();}
});
test('resource auth, scope, recursive paths, revocation, expiry, restart and eviction',async()=>{
 const f=fixture();try{
  assert.equal((await f.get(requests,undefined,'')).statusCode,401);
  for(const path of ['/api/resource-sync','/api/auth/session','/api/request-trends/sync','/api/unknown','/api/requests?limit=1&limit=2','//evil/api/requests'])assert.equal((await f.get(path)).statusCode,400,path);
  const a=await f.sync(requests);
  assert.equal((await f.sync(requests,a.cursor,f.login())).mode,'snapshot');
  assert.equal((await f.sync(requests+'&limit=1',a.cursor)).mode,'snapshot');
  assert.equal((await f.sync(requests,'bad')).mode,'snapshot');
  f.advance(RESOURCE_SYNC_TTL_MS);assert.equal((await f.sync(requests,a.cursor)).mode,'snapshot');
  const b=await f.sync(requests);await f.restart();assert.equal((await f.sync(requests,b.cursor)).mode,'snapshot');
  const c=await f.sync(requests);for(let i=0;i<RESOURCE_SYNC_MAX_ENTRIES;i++)await f.sync(requests);assert.equal((await f.sync(requests,c.cursor)).mode,'snapshot');
  const d=await f.sync(requests+'&groupId=11');f.revoke();assert.equal((await f.get(requests+'&groupId=11',d.cursor)).statusCode,400);
  const meta=await f.sync('/api/meta');assert.deepEqual(meta.data.groups,[]);
 }finally{await f.cleanup();}
});
test('all resource routes retain GET projection, pagination and error contracts',async()=>{
 const f=fixture();try{
  for(const path of ['/api/meta','/api/health','/api/overview?since=0&until=1000',requests,'/api/wakes?since=0&until=1000','/api/tools?since=0&until=1000','/api/events?since=0&until=1000','/api/requests/a?groupId=11','/api/wakes/w?groupId=11','/api/wakes/w/review?groupId=11']){
   const r=await f.sync(path);assert.equal(r.mode,'snapshot',path);
   const direct=await f.app().inject({url:path,headers:{cookie:f.cookie}});assert.deepEqual(r.data,direct.json(),path);
  }
  const first=await f.sync(requests+'&limit=1');assert.ok(first.data.nextCursor);
  const second=await f.sync(requests+'&limit=1&cursor='+encodeURIComponent(first.data.nextCursor),first.cursor);assert.equal(second.mode,'snapshot');assert.notEqual(first.data.items[0].requestId,second.data.items[0].requestId);
  assert.equal((await f.get('/api/requests/nope?groupId=11')).statusCode,404);
  assert.equal((await f.get('/api/requests?unexpected=1')).statusCode,400);
 }finally{await f.cleanup();}
});
test('health leases and meta time change without DB writes; replacement and session commits invalidate',async()=>{
 const f=fixture();try{
  let h=await f.sync('/api/health');assert.equal(h.data.connectivity,'connected');let data=h.data;
  f.advance(46000);h=await f.sync('/api/health',h.cursor);data=apply(data,h);assert.equal(data.connectivity,'stale');
  const m=await f.sync('/api/meta');f.advance(5000);const m2=await f.sync('/api/meta',m.cursor);assert.equal(apply(m.data,m2).now,m.data.now+5000);
  const w=await f.sync('/api/wakes?since=0&until=1000');f.session.exec("INSERT INTO model_session_journal VALUES(2,'s','w','wake_finish','{\"reason\":\"finished\"}',200)");const changed=await f.sync('/api/wakes?since=0&until=1000',w.cursor);assert.notEqual(changed.mode,'unchanged');
  const a=await f.sync(requests);f.replace();const original=ReviewRepository.prototype.requests;let calls=0;ReviewRepository.prototype.requests=function(...args){calls++;return original.apply(this,args);};try{const b=await f.sync(requests,a.cursor);assert.deepEqual(apply(a.data,b),a.data);assert.ok(calls>0,'replacement must requery even if data_version repeats');}finally{ReviewRepository.prototype.requests=original;}
 }finally{await f.cleanup();}
});
