import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../../src/dashboard/server/app.js';
import { AuthStore } from '../../../src/dashboard/server/auth.js';
import type { RequestTrendsResponse } from '../../../src/dashboard/contracts/request-trends.js';
function fixture(old = false) {
  const dir=mkdtempSync(join(tmpdir(),'trends-')),telemetryPath=join(dir,'t.sqlite');
  const db=new DatabaseSync(telemetryPath);
  db.exec(`CREATE TABLE model_requests(request_id TEXT PRIMARY KEY,group_id TEXT,started_at INTEGER,ended_at INTEGER,duration_ms REAL,status TEXT,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,error_code TEXT);
    INSERT INTO model_requests VALUES('success','11',100,200,100,'success',100,40,10,NULL),
    ('zero','11',200,200,0,'success',0,0,0,NULL),
    ('failed','11',300,400,100,'error',100,0,10,'http_error'),
    ('timeout','11',400,500,100,'error',NULL,NULL,NULL,'timeout'),
    ('cancelled','11',500,600,100,'error',NULL,NULL,NULL,'cancelled'),
    ('unknown','11',600,NULL,NULL,'unrecognized',NULL,NULL,NULL,NULL),
    ('foreign','22',100,200,100,'success',99999,0,99999,NULL);`);
  if(!old) db.exec(`CREATE TABLE model_request_inspections(request_id TEXT PRIMARY KEY,group_id TEXT,started_at INTEGER,ended_at INTEGER,status TEXT,wake_id TEXT,request_json TEXT,model TEXT);
    INSERT INTO model_request_inspections VALUES('running','11',700,NULL,'running','wake','PRIVATE_BODY','PRIVATE_MODEL'),('interrupted','11',800,999999,'interrupted','wake','PRIVATE_BODY','PRIVATE_MODEL'),('success','11',100,200,'success','wake','PRIVATE_BODY','PRIVATE_MODEL');`);
  db.close();
  const auth=new AuthStore({path:join(dir,'auth.sqlite'),password:'test-password-long'});
  const login=auth.login('test-password-long','127.0.0.1');assert.equal(login.status,'ok');
  const cookie=`dashboard_session=${login.status==='ok'?login.token:''}`;
  let groups=[{groupId:'11',sessionPath:join(dir,'missing-session.sqlite')}];
  const app=buildApp({auth,telemetryPath,getGroups:()=>groups,now:()=>1000});
  return {app,telemetryPath,get:(url:string)=>app.inject({url,headers:{cookie}}),revoke:()=>{groups=[];},cleanup:async()=>{await app.close();auth.close();rmSync(dir,{recursive:true,force:true});}};
}
test('trends preserves review metering, all seven outcomes and old schemas without detail leakage',async()=>{
  for(const old of [false,true]){
    const f=fixture(old);try{
      const response=await f.get('/api/request-trends?since=100&until=800&groupId=11');assert.equal(response.statusCode,200);
      const body=response.json<RequestTrendsResponse>();
      assert.equal(body.points.length,old?6:8);assert.equal(body.buckets[0]!.total,body.points.length);
      assert.deepEqual(body.buckets[0]!.counts,{running:old?0:1,interrupted:old?0:1,success:2,failed:1,timeout:1,cancelled:1,unknown:1});
      const success=body.points.find(p=>p.startedAt===100)!;
      assert.deepEqual(success,{startedAt:100,outcome:'success',durationMs:100,inputTokens:60,totalInputTokens:100,cachedInputTokens:40,outputTokens:10,tps:100});
      const zero=body.points.find(p=>p.startedAt===200)!;assert.equal(zero.durationMs,0);assert.equal(zero.outputTokens,0);assert.equal(zero.tps,null);
      assert.equal(body.points.find(p=>p.outcome==='failed')!.tps,null);
      for(const outcome of ['running','interrupted']) if(!old){const point=body.points.find(p=>p.outcome===outcome)!;assert.equal(point.durationMs,null);assert.equal(point.tps,null);}
      assert.doesNotMatch(response.body,/PRIVATE|requestId|requestBody|99999/);
      assert.equal((await f.get('/api/request-trends?since=100&until=100')).json().points.length,1);
      assert.equal((await f.get('/api/request-trends?since=101&until=199')).json().points.length,0);
      const overview=(await f.get('/api/overview?since=100&until=800')).json();assert.ok(!('points' in overview));assert.equal(overview.summary.requests,body.points.length);
    }finally{await f.cleanup();}
  }
});
test('trends uses authentication, strict query parser, 31-day limit and refreshed group authorization',async()=>{
  const f=fixture();try{
    assert.equal((await f.app.inject('/api/request-trends')).statusCode,401);
    for(const query of ['groupId=22','since=2&until=1','since=-1','since=NaN','since=0&until=2678400001','limit=1','since=1&since=2','groupId=11&groupId=11']) assert.equal((await f.get(`/api/request-trends?${query}`)).statusCode,400,query);
    assert.equal((await f.get('/api/request-trends?since=0&until=2678400000')).statusCode,200);
    f.revoke();assert.equal((await f.get('/api/request-trends?groupId=11')).statusCode,400);
    const revoked=(await f.get('/api/request-trends?since=0&until=1000')).json();assert.deepEqual(revoked.points,[]);assert.deepEqual(revoked.availability.sessions,[]);
  }finally{await f.cleanup();}
});
test('unavailable telemetry stays unavailable, and resource caps return 503 without truncated data',async()=>{
  const missing=fixture();try{
    rmSync(missing.telemetryPath);
    const response=await missing.get('/api/request-trends?since=0&until=1000');assert.equal(response.statusCode,200);
    assert.equal(response.json().availability.telemetry,false);assert.deepEqual(response.json().points,[]);assert.deepEqual(response.json().buckets,[]);
  }finally{await missing.cleanup();}
  const f=fixture(true);try{
    const db=new DatabaseSync(f.telemetryPath);db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO model_requests SELECT 'bulk-'||x,'11',900,901,1,'success',1,0,1,NULL FROM n`);db.close();
    const limited=await f.get('/api/request-trends?since=0&until=1000');assert.equal(limited.statusCode,503);assert.equal(limited.json().error,'unavailable');assert.ok(!('points' in limited.json()));
    assert.equal((await f.get('/api/request-trends?since=100&until=100')).statusCode,200);
  }finally{await f.cleanup();}
});
