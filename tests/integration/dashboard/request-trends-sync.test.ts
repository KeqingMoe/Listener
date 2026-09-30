import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../../src/dashboard/server/app.ts';
import { installRequestChangeLog } from '../../../src/observability/request-change-log.ts';
import { AuthStore } from '../../../src/dashboard/server/auth.ts';
import { ReviewRepository } from '../../../src/dashboard/server/review-repository.ts';
import { TREND_SYNC_TTL_MS } from '../../../src/dashboard/server/request-trends-sync.ts';
import type { RequestTrendsSyncResponse } from '../../../src/dashboard/contracts/request-trends.ts';

function fixture(journal = true) {
  const dir = mkdtempSync(join(tmpdir(), 'trends-sync-')), telemetryPath = join(dir, 't.sqlite');
  const db = new DatabaseSync(telemetryPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE model_requests(request_id TEXT PRIMARY KEY,group_id TEXT,started_at INTEGER,ended_at INTEGER,duration_ms REAL,status TEXT,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER);
    CREATE TABLE model_request_inspections(request_id TEXT PRIMARY KEY,group_id TEXT,started_at INTEGER,ended_at INTEGER,status TEXT,model TEXT,request_json TEXT);
    INSERT INTO model_requests VALUES('a','11',100,NULL,NULL,'running',NULL,NULL,NULL),('future','11',1050,1100,50,'success',2,0,1),('foreign','22',100,200,100,'success',99,0,99);
    INSERT INTO model_request_inspections VALUES('a','11',100,NULL,'running','PRIVATE_MODEL','PRIVATE_BODY');`);
  if(journal) assert.equal(installRequestChangeLog(db), true);
  const auth = new AuthStore({path:join(dir,'auth.sqlite'),password:'test-password-long'});
  const login = () => { const result=auth.login('test-password-long','127.0.0.1'); assert.equal(result.status,'ok'); return `dashboard_session=${result.status==='ok'?result.token:''}`; };
  const cookie=login(); let now=1000, groups=[{groupId:'11',sessionPath:join(dir,'missing.sqlite')}];
  const app=buildApp({auth,telemetryPath,getGroups:()=>groups,now:()=>now});
  const get=(cursor?:string,since=0,until=1000,session=cookie,extra='')=>app.inject({url:`/api/request-trends/sync?since=${since}&until=${until}${cursor===undefined?'':`&cursor=${encodeURIComponent(cursor)}`}${extra}`,headers:{cookie:session}});
  const sync=async(cursor?:string,since=0,until=1000,session=cookie,extra='')=>{const r=await get(cursor,since,until,session,extra);assert.equal(r.statusCode,200,r.body);return r.json<RequestTrendsSyncResponse>();};
  return {db,app,get,sync,login,replace:()=>{ const replacement=join(dir,'replacement.sqlite'); db.exec(`VACUUM INTO '${replacement}'`); renameSync(replacement,telemetryPath); },advance:()=>{now+=TREND_SYNC_TTL_MS;},revoke:()=>{groups=[];},changePath:()=>{groups=[{groupId:'11',sessionPath:join(dir,'other.sqlite')}];},cleanup:async()=>{await app.close();auth.close();db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('sync completion, both-table deletion and sliding re-read only keys and entering intervals',async()=>{
  const f=fixture(); const original=ReviewRepository.prototype.requests;
  const calls:Parameters<typeof original>[]=[];
  ReviewRepository.prototype.requests=function(...args){calls.push(args);return original.apply(this,args);};
  try {
    const initial=await f.sync(); assert.equal(initial.mode,'snapshot');assert.equal(initial.upserts.length,1);assert.equal(initial.buckets[0]!.total,1);
    assert.doesNotMatch(JSON.stringify(initial),/PRIVATE|diagnostics|model|request_json/);
    calls.length=0;
    f.db.exec("UPDATE model_requests SET status='success',ended_at=200,duration_ms=100,input_tokens=10,cached_input_tokens=2,output_tokens=5 WHERE request_id='a'");
    const completed=await f.sync(initial.cursor);assert.equal(completed.mode,'delta');assert.equal(completed.upserts[0]!.outcome,'success');assert.equal(completed.buckets[0]!.counts.success,1);
    assert.ok(calls.length>0);assert.ok(calls.every(c=>c[3]?.requestIds?.length && c[4]?.skipAssociations));
    f.db.exec("DELETE FROM model_requests WHERE request_id='a'");
    const fallback=await f.sync(completed.cursor);assert.equal(fallback.mode,'delta');assert.equal(fallback.upserts[0]!.outcome,'running');assert.deepEqual(fallback.removals,[]);
    f.db.exec("DELETE FROM model_request_inspections WHERE request_id='a'");
    const deleted=await f.sync(fallback.cursor);assert.deepEqual(deleted.removals,[initial.upserts[0]!.key]);assert.equal(deleted.buckets[0]!.total,0);
    calls.length=0;
    const slide=await f.sync(deleted.cursor,100,1100);assert.equal(slide.mode,'delta');assert.equal(slide.upserts[0]!.startedAt,1050);
    assert.ok(calls.every(c=>c[3]?.requestIds?.length || (c[0]!.since===1001 && c[0]!.until===1100)));
    const unchanged=await f.sync(slide.cursor,100,1100);assert.deepEqual(unchanged.upserts,[]);assert.deepEqual(unchanged.removals,[]);
    const expiredPoint=await f.sync(unchanged.cursor,1100,2100);assert.deepEqual(expiredPoint.removals,[slide.upserts[0]!.key]);assert.equal(expiredPoint.buckets[0]!.total,0);
  }finally{ReviewRepository.prototype.requests=original;await f.cleanup();}
});

test('sync auth/session, scope/path, invalid token, expiry, range and journal reset boundaries',async()=>{
  const f=fixture();try {
    assert.equal((await f.app.inject('/api/request-trends/sync')).statusCode,401);
    assert.equal((await f.get(undefined,2,1)).statusCode,400);
    assert.equal((await f.get(undefined,0,1000,undefined,'&groupId=22')).statusCode,400);
    const a=await f.sync();
    for(const token of ['bad','a'.repeat(64)]) assert.equal((await f.sync(token)).mode,'snapshot');
    assert.equal((await f.sync(a.cursor,0,1000,f.login())).mode,'snapshot');
    assert.equal((await f.sync(a.cursor,0,1000,undefined,'&groupId=11')).mode,'snapshot');
    assert.equal((await f.sync(a.cursor,0,999)).mode,'snapshot');
    const forward=await f.sync(a.cursor,100,1100);assert.equal(forward.mode,'delta');assert.equal((await f.sync(forward.cursor)).mode,'snapshot');
    f.changePath();assert.equal((await f.sync(a.cursor)).mode,'snapshot');
    const b=await f.sync();f.advance();assert.equal((await f.sync(b.cursor)).mode,'snapshot');
    const c=await f.sync();f.db.exec("UPDATE request_change_meta SET epoch='new'");assert.equal((await f.sync(c.cursor)).mode,'snapshot');
    const d=await f.sync();f.db.exec('UPDATE request_change_meta SET revision=1,floor_revision=1');assert.equal((await f.sync(d.cursor)).mode,'snapshot');
    const e=await f.sync();assert.equal((await f.sync(e.cursor)).mode,'delta');
    f.db.exec('UPDATE request_change_meta SET revision=0,floor_revision=0');assert.equal((await f.sync(e.cursor)).mode,'snapshot');
    f.revoke();const revoked=await f.sync(e.cursor);assert.equal(revoked.mode,'snapshot');assert.deepEqual(revoked.upserts,[]);
  }finally{await f.cleanup();}
});

test('sync old schema honestly snapshots and token cache evicts bounded entries',async()=>{
  const old=fixture(false);try{const a=await old.sync();assert.equal((await old.sync(a.cursor)).mode,'snapshot');}finally{await old.cleanup();}
  const f=fixture();try{const a=await f.sync();for(let i=0;i<32;i++)await f.sync();assert.equal((await f.sync(a.cursor)).mode,'snapshot');}finally{await f.cleanup();}
});

test('sync damaged triggers, journal gaps and replacement handles reset snapshots',async()=>{
  for (const damage of ['trigger','gap','schema','replacement']) {
    const f=fixture();try {
      const a=await f.sync();
      if(damage==='trigger') f.db.exec('DROP TRIGGER request_changes_model_requests_update');
      if(damage==='gap') f.db.exec("UPDATE model_requests SET status='success' WHERE request_id='a'; DELETE FROM request_changes");
      if(damage==='schema') f.db.exec('ALTER TABLE request_change_meta RENAME COLUMN epoch TO broken_epoch');
      if(damage==='replacement') f.replace();
      const reset=await f.sync(a.cursor);assert.equal(reset.mode,'snapshot',damage);assert.equal(reset.upserts.length,1);
    }finally{await f.cleanup();}
  }
});

test('sync 10000 hard cap fails rather than truncating snapshot or delta',async()=>{
  const f=fixture();try{
    const a=await f.sync();
    f.db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999) INSERT INTO model_requests SELECT 'bulk-'||x,'11',900,901,1,'success',1,0,1 FROM n`);
    const exact=await f.sync(a.cursor);assert.equal(exact.buckets[0]!.total,10000);
    f.db.exec("INSERT INTO model_requests VALUES('too-many','11',900,901,1,'success',1,0,1)");
    for(const cursor of [undefined,exact.cursor]){const result=await f.get(cursor);assert.equal(result.statusCode,503);assert.equal(result.json().error,'unavailable');assert.ok(!('upserts' in result.json()));}
  }finally{await f.cleanup();}
});
