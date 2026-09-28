import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TelemetryStore,type TelemetryRecord} from '../src/telemetry.js';
import type {ModelRequestStart} from '../src/model-usage.js';

function fixture(run:(path:string,store:TelemetryStore,db:DatabaseSync)=>void):void {
  const dir=mkdtempSync(join(tmpdir(),'telemetry-inspection-'));
  const path=join(dir,'isolated.sqlite');
  const store=new TelemetryStore(path,{secrets:['fixture-secret']});
  const db=new DatabaseSync(path);
  try {run(path,store,db);} finally {db.close();store.close();rmSync(dir,{recursive:true,force:true});}
}
const start=(id:string):ModelRequestStart=>({requestId:id,startedAt:Date.now(),transport:'responses',model:'fixture-model',requestJson:'{"input":"hello"}',requestMode:'fresh'});
const finish=(value:ModelRequestStart):TelemetryRecord=>({...value,endedAt:value.startedAt+1,durationMs:1,status:'success',usage:{inputTokens:10}});

test('inspection schema is exact and begin/record preserve context and first completion',()=>fixture((_path,store,db)=>{
  assert.deepEqual(db.prepare('PRAGMA table_info(model_request_inspections)').all().map(row=>row.name),[
    'request_id','group_id','turn_id','wake_id','phase','started_at','ended_at','transport','model','status',
    'request_json','response_json','reasoning_text','error_text','response_id','previous_response_id','provider_request_id','request_mode','content_truncated',
  ]);
  for(const [name,column] of [['response','response_id'],['previous_response','previous_response_id'],['turn','turn_id'],['wake','wake_id']]) {
    assert.deepEqual(db.prepare(`PRAGMA index_info(model_request_inspections_group_${name})`).all().map(row=>row.name),['group_id',column]);
    const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT request_id FROM model_request_inspections WHERE group_id=? AND ${column}=?`).all('group','value');
    assert.ok(plan.some(row=>String(row.detail).includes(`model_request_inspections_group_${name}`)));
  }
  const value={...start('one'),previousResponseId:'prev',groupId:'group',turnId:'turn',wakeId:'wake',phase:'answer'};
  store.beginRequest(value);
  let row=db.prepare('SELECT * FROM model_request_inspections WHERE request_id=?').get('one')!;
  assert.equal(row.status,'running');assert.equal(row.ended_at,null);assert.equal(row.wake_id,'wake');
  store.record({...finish(value),inspection:{responseJson:'{"output":"world"}',responseId:'next',providerRequestId:'provider',reasoningText:'private thought'}});
  row=db.prepare('SELECT * FROM model_request_inspections WHERE request_id=?').get('one')!;
  assert.equal(row.status,'success');assert.equal(row.ended_at,value.startedAt+1);
  assert.equal(row.request_json,value.requestJson);assert.equal(row.response_json,'{"output":"world"}');
  assert.equal(row.previous_response_id,'prev');assert.equal(row.request_mode,'fresh');
  assert.equal(row.group_id,'group');assert.equal(row.turn_id,'turn');assert.equal(row.wake_id,'wake');assert.equal(row.phase,'answer');
  assert.equal(row.reasoning_text,'private thought');assert.equal(row.response_id,'next');assert.equal(row.provider_request_id,'provider');
  store.beginRequest(value);store.record({...finish(value),status:'error',inspection:{errorText:'late'}});
  assert.equal(db.prepare('SELECT status FROM model_request_inspections').get()!.status,'success');
  assert.equal(store.summarize({since:0,until:Date.now()+100}).requests,1);
}));

test('record-only errors retain usage and inspection is redacted and bounded',()=>fixture((_path,store,db)=>{
  const value=start('error');
  store.record({...finish(value),status:'error',errorCode:'http_error',httpStatus:400,inspection:{
    requestJson:JSON.stringify({authorization:'Bearer token',input:'fixture-secret',image:'data:image/png;base64,AAAA'}),
    errorText:'failure fixture-secret',responseJson:'{"error":"fixture-secret"}',reasoningText:'reason fixture-secret',
  }});
  const row=db.prepare('SELECT * FROM model_request_inspections').get()!;
  assert.equal(row.status,'error');assert.equal(JSON.stringify(row).includes('fixture-secret'),false);
  assert.equal(JSON.stringify(row).includes('Bearer token'),false);assert.equal(JSON.stringify(row).includes('base64,AAAA'),false);
  const large='漢'.repeat(400_000);
  store.record({...finish(start('large')),inspection:{requestJson:JSON.stringify({large}),responseJson:JSON.stringify({large}),reasoningText:large,errorText:large,responseId:large,previousResponseId:large,providerRequestId:large,requestMode:large}});
  const big=db.prepare('SELECT * FROM model_request_inspections WHERE request_id=?').get('large')!;
  const fields=['request_json','response_json','reasoning_text','error_text','response_id','previous_response_id','provider_request_id','request_mode'];
  let bytes=0;
  for(const key of fields){const size=Buffer.byteLength(big[key] as string);assert.ok(size<=(key==='request_json'||key==='response_json'?1024*1024:64*1024),key);bytes+=size;}
  assert.ok(bytes<=2*1024*1024+6*64*1024);assert.equal(big.content_truncated,1);
  assert.doesNotThrow(()=>JSON.parse(big.request_json as string));assert.doesNotThrow(()=>JSON.parse(big.response_json as string));
}));

test('nested JSON truncation stays within the request field byte budget',()=>fixture((_path,store,db)=>{
  let nested:unknown='x'.repeat(1_047_000);
  for(let i=0;i<60;i++)nested={child:nested,sibling:'y'.repeat(1000)};
  store.beginRequest({...start('nested'),requestJson:JSON.stringify(nested)});
  const row=db.prepare('SELECT request_json,content_truncated FROM model_request_inspections').get()!;
  assert.equal(row.content_truncated,1);
  assert.ok(Buffer.byteLength(row.request_json as string)<=1024*1024);
  assert.doesNotThrow(()=>JSON.parse(row.request_json as string));
}));

test('reader opening never recovers running rows; first writer recovers once across stores',()=>fixture((path,store,db)=>{
  const now=Date.now();
  db.prepare(`INSERT INTO model_request_inspections(request_id,started_at,status) VALUES(?,?,'running')`).run('crashed',now-1000);
  const reader=new TelemetryStore(path);
  try {
    assert.equal(db.prepare('SELECT status FROM model_request_inspections WHERE request_id=?').get('crashed')!.status,'running');
    store.beginRequest(start('live'));
    const crashed=db.prepare('SELECT * FROM model_request_inspections WHERE request_id=?').get('crashed')!;
    assert.equal(crashed.status,'interrupted');assert.ok(Number(crashed.ended_at)>=now);
    reader.beginRequest(start('second'));
    assert.equal(db.prepare('SELECT status FROM model_request_inspections WHERE request_id=?').get('live')!.status,'running');
  } finally {reader.close();}
}));

test('closing and reopening leaves recovery deferred until the next writer',()=>fixture((path,store,db)=>{
  store.beginRequest(start('previous-process'));
  store.close();
  const reopened=new TelemetryStore(path);
  try {
    assert.equal(db.prepare('SELECT status FROM model_request_inspections').get()!.status,'running');
    reopened.beginRequest(start('new-process'));
    assert.equal(db.prepare('SELECT status FROM model_request_inspections WHERE request_id=?').get('previous-process')!.status,'interrupted');
  } finally {reopened.close();}
}));

test('retention is throttled and never removes model usage history',()=>fixture((_path,store,db)=>{
  const old=Date.now()-8*24*60*60*1000;
  store.record({...finish({...start('old'),startedAt:old}),endedAt:old+1});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_request_inspections').get()!.n,0);
  assert.equal(store.summarize({since:0,until:Date.now()}).requests,1);
  db.prepare(`INSERT INTO model_request_inspections(request_id,started_at,status) VALUES(?,?,'success')`).run('seeded-after-cleanup',old);
  store.record(finish(start('fresh')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_request_inspections WHERE request_id=?').get('seeded-after-cleanup')!.n,1);
}));

test('retention backlog is bounded per write and continues in later transactions',()=>fixture((_path,store,db)=>{
  const old=Date.now()-8*24*60*60*1000;
  db.exec('BEGIN;');
  const insert=db.prepare(`INSERT INTO model_request_inspections(request_id,started_at,status) VALUES(?,?,'success')`);
  for(let i=0;i<130;i++)insert.run(`old-${i}`,old+i);
  db.exec('COMMIT;');
  const count=()=>Number(db.prepare('SELECT COUNT(*) AS n FROM model_request_inspections WHERE started_at<?').get(old+200)!.n);
  store.record(finish(start('new-0')));
  let previous=count();assert.ok(previous>=66&&previous<130);
  for(let i=1;i<=130&&previous>0;i++){
    store.record(finish(start(`new-${i}`)));const remaining=count();assert.ok(remaining<previous);assert.ok(previous-remaining<=64);previous=remaining;
  }
  assert.equal(previous,0);
}));

test('cleanup rollback restores partially deleted rows and resets byte accounting',t=>fixture((_path,store,db)=>{
  const now=Date.now(),old=now-8*24*60*60*1000;
  db.prepare(`INSERT INTO model_request_inspections(request_id,started_at,status) VALUES('old-a',?,'success'),('old-b',?,'success')`).run(old,old+1);
  db.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON model_request_inspections WHEN OLD.request_id='old-b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
  assert.doesNotThrow(()=>store.record(finish(start('new'))));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_request_inspections WHERE request_id LIKE 'old-%'").get()!.n,2);
  assert.equal((store as unknown as {inspectionState:{bytes:number|null}}).inspectionState.bytes,null);
  db.exec('BEGIN IMMEDIATE; ROLLBACK; DROP TRIGGER fail_cleanup;');
  t.mock.method(Date,'now',()=>now+61_000);
  store.record(finish(start('after-recovery')));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_request_inspections WHERE request_id LIKE 'old-%'").get()!.n,0);
  assert.equal(store.summarize({since:0,until:Date.now()+100}).requests,2);
}));

test('inspection storage or sanitizer failure cannot break usage persistence',()=>fixture((_path,store,db)=>{
  const hostile=Object.defineProperty({},'requestJson',{get(){throw new Error('private contents');}});
  assert.doesNotThrow(()=>store.record({...finish(start('hostile')),inspection:hostile}));
  db.exec('DROP TABLE model_request_inspections');
  assert.doesNotThrow(()=>store.beginRequest(start('missing')));
  assert.doesNotThrow(()=>store.record(finish(start('missing'))));
  assert.equal(store.summarize({since:0,until:Date.now()+100}).requests,2);
}));
