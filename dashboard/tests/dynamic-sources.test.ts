import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../server/app.js';
import { Repository, type GroupSource } from '../server/repository.js';
import { loadAppConfig } from '../../src/config-loader.js';
import { GroupRegistry } from '../../src/group-registry.js';
import { dashboardGroupSources } from '../server/sources.js';

const privateText = 'PRIVATE_CHAT_ARGUMENT_CHECKPOINT';
function session(path: string, groupId: string, wakeId = 'wake') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE model_session_meta(singleton INTEGER,group_id TEXT,checkpoint TEXT);
    CREATE TABLE model_session_journal(seq INTEGER,session_id TEXT,wake_id TEXT,kind TEXT,payload TEXT,created_at INTEGER);
    CREATE TABLE model_session_messages(seq INTEGER,session_id TEXT,wake_id TEXT,request_id TEXT,message TEXT);
    CREATE TABLE model_tool_ledger(ordinal INTEGER,name TEXT,wake_id TEXT,state TEXT,arguments TEXT,result TEXT,proposed_at INTEGER,started_at INTEGER,finished_at INTEGER);`);
  db.prepare('INSERT INTO model_session_meta VALUES(1,?,?)').run(groupId, privateText);
  db.prepare('INSERT INTO model_session_journal VALUES(1,?,?,?, ?,100)').run('session', wakeId, 'wake_begin', JSON.stringify({private:privateText}));
  db.close();
}
function fixture(t: {after(fn: () => void): void}, groups = ['11','22'], perGroup = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-membership-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const telemetryPath = join(dir, 'telemetry.sqlite');
  const db = new DatabaseSync(telemetryPath);
  db.exec('CREATE TABLE model_requests(request_id TEXT,group_id TEXT,started_at INTEGER,ended_at INTEGER,duration_ms INTEGER,status TEXT,transport TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER);BEGIN;');
  const insert = db.prepare('INSERT INTO model_requests VALUES(?,?,100,120,20,?,?,?,?,?)');
  for (const group of groups) for(let i=0;i<perGroup;i++) insert.run(`request-${group}-${i}`,group,'success','responses',1,1,0);
  db.exec('COMMIT');db.close();
  return {dir,telemetryPath,source:(id:string) => ({groupId:id,sessionPath:join(dir,`${id}.session.sqlite`)})};
}

test('source callback refreshes every API read and never falls back to a stale static snapshot', async t => {
  const f=fixture(t), first=f.source('11'),second=f.source('22');
  session(first.sessionPath,'11');session(second.sessionPath,'22');
  const registry=join(f.dir,'private-registry.json');
  const publish=(groups:GroupSource[])=>{writeFileSync(registry+'.tmp',JSON.stringify(groups));renameSync(registry+'.tmp',registry);};
  publish([first]);
  let calls=0;
  const app=buildApp({groups:[second],getGroups:()=>{calls++;return JSON.parse(readFileSync(registry,'utf8')) as GroupSource[];},telemetryPath:f.telemetryPath,now:()=>300});
  t.after(()=>app.close());
  let before=calls;
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[{groupId:'11'}]);
  assert.equal(calls,before+1);
  assert.equal((await app.inject('/api/overview?groupId=22')).statusCode,400);
  assert.equal((await app.inject('/api/wakes/wake?groupId=11')).statusCode,200);
  publish([first,second]);
  assert.equal((await app.inject('/api/overview?since=0&until=300')).json().summary.requests,2);
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[{groupId:'11'},{groupId:'22'}]);
  publish([second]);
  for(const url of ['/api/overview?groupId=11','/api/wakes?groupId=11','/api/tools?groupId=11','/api/wakes/wake?groupId=11']) {
    before=calls;assert.equal((await app.inject(url)).statusCode,400);assert.equal(calls,before+1);
  }
  const overview=await app.inject('/api/overview?since=0&until=300');
  assert.equal(overview.json().summary.requests,1);
  assert.deepEqual(overview.json().groups.map((g:{groupId:string})=>g.groupId),['22']);
  assert.doesNotMatch(overview.body,new RegExp(privateText));
  writeFileSync(registry,'broken JSON');
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[]);
  assert.equal((await app.inject('/api/overview?since=0&until=300')).json().summary.requests,0);
  assert.equal((await app.inject('/api/wakes/wake?groupId=22')).statusCode,400);
  rmSync(registry);
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[]);
});

test('explicit enabled history remains readable offline; dynamic groups require fresh registry and blacklist wins', async t => {
  let cleanup=()=>{};
  const f=fixture({after:fn=>{cleanup=fn;}},['11','22','33']), configPath=join(f.dir,'config.toml');
  writeFileSync(join(f.dir,'persona.md'),'Synthetic test persona.');
  writeFileSync(configPath,`[bot]\nowner_id="100000001"\n[model]\nmodel="fixture-model"\n[storage]\ndirectory="."\n[defaults]\nenabled=true\npersona="persona.md"\n[groups."11"]\nenabled=true\nstorage.database="11"\n[groups."33"]\nenabled=false\n`);
  const config=loadAppConfig({configPath,env:{ONEBOT_ACCESS_TOKEN:'synthetic-test-token',OPENAI_API_KEY:'synthetic-model-key'}});
  session(f.source('11').sessionPath,'11');
  const dynamicPath=config.resolveGroup('22').storage.databasePath;
  mkdirSync(dirname(dynamicPath),{recursive:true});session(dynamicPath+'.session.sqlite','22');
  const app=buildApp({getGroups:()=>dashboardGroupSources(config),telemetryPath:config.storage.telemetryPath,now:()=>300});
  let registry:GroupRegistry|undefined;
  t.after(async()=>{await app.close();registry?.close();cleanup();});
  // No registry at all: explicit policy authorizes offline history, not bot routing.
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[{groupId:'11'}]);
  assert.equal((await app.inject('/api/wakes/wake?groupId=11')).statusCode,200);
  assert.equal((await app.inject('/api/overview?groupId=22')).statusCode,400);
  assert.equal((await app.inject('/api/overview?groupId=33')).statusCode,400);
  registry=new GroupRegistry(config);
  registry.update(['11','22','33']);
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[{groupId:'11'},{groupId:'22'}]);
  assert.equal((await app.inject('/api/overview?since=0&until=300')).json().summary.requests,2);
  assert.equal((await app.inject('/api/wakes/wake?groupId=22')).statusCode,200);
  registry.update(['22']);
  assert.equal((await app.inject('/api/wakes/wake?groupId=11')).statusCode,200);
  // Expired lease removes only unconfigured dynamic access, even after DB caching.
  writeFileSync(config.storage.registryPath,JSON.stringify({updatedAt:Date.now()-300000,groups:[{groupId:'22',databasePath:dynamicPath}]}));
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[{groupId:'11'}]);
  assert.equal((await app.inject('/api/wakes/wake?groupId=22')).statusCode,400);
  assert.equal((await app.inject('/api/wakes/wake?groupId=11')).statusCode,200);
  // Registry paths cannot retarget a dynamic group, and disabled entries stay invisible.
  writeFileSync(config.storage.registryPath,JSON.stringify({updatedAt:Date.now(),groups:[{groupId:'22',databasePath:config.resolveGroup('11').storage.databasePath}]}));
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[{groupId:'11'}]);
  writeFileSync(config.storage.registryPath,JSON.stringify({updatedAt:Date.now(),groups:[{groupId:'33',databasePath:config.resolveGroup('33').storage.databasePath}]}));
  assert.equal((await app.inject('/api/overview?groupId=33')).statusCode,400);
  registry.close();
  assert.deepEqual((await app.inject('/api/meta')).json().groups,[{groupId:'11'}]);
  assert.equal((await app.inject('/api/overview?since=0&until=300')).json().summary.requests,1);
});

test('removed sources and changed paths close cached connections rather than preserving authority', t => {
  const f=fixture(t), first=f.source('11');session(first.sessionPath,'11');
  let groups=[first];
  const repo=new Repository({getGroups:()=>groups,telemetryPath:f.telemetryPath});
  t.after(()=>repo.close());
  const original=repo.session('11')!;assert.ok(original);
  groups=[];repo.refreshGroups();
  assert.throws(()=>original.prepare('SELECT 1'));
  assert.equal(repo.session('11'),null);
  groups=[first];repo.refreshGroups();const reopened=repo.session('11')!;
  const next={groupId:'11',sessionPath:join(f.dir,'new-session.sqlite')};session(next.sessionPath,'11','new-wake');
  groups=[next];repo.refreshGroups();
  assert.throws(()=>reopened.prepare('SELECT 1'));
  assert.equal(repo.detail('11','new-wake')?.wake.wakeId,'new-wake');
  assert.equal(repo.detail('11','wake'),null);
});

test('a cached path cannot authorize a different group and cached metadata is revalidated', t => {
  const f=fixture(t), first=f.source('11');session(first.sessionPath,'11');
  let groups=[first,{groupId:'22',sessionPath:first.sessionPath}];
  const repo=new Repository({getGroups:()=>groups,telemetryPath:f.telemetryPath});t.after(()=>repo.close());
  assert.ok(repo.session('11'));
  assert.equal(repo.session('22'),null);
  assert.equal(repo.detail('22','wake'),null);
  const db=new DatabaseSync(first.sessionPath);
  db.prepare('UPDATE model_session_meta SET group_id=?').run('22');db.close();
  assert.equal(repo.session('11'),null);
  groups=[{groupId:'22',sessionPath:first.sessionPath}];repo.refreshGroups();
  assert.ok(repo.session('22'));
});

test('atomic file replacement does not retain a stale cached inode or accept foreign identity', t => {
  const f=fixture(t), first=f.source('11');session(first.sessionPath,'11');
  const repo=new Repository({groups:[first],telemetryPath:f.telemetryPath});t.after(()=>repo.close());
  const old=repo.session('11')!;assert.ok(old);
  const temp=join(f.dir,'replacement.sqlite');session(temp,'22','foreign-wake');renameSync(temp,first.sessionPath);
  assert.equal(repo.session('11'),null);
  assert.throws(()=>old.prepare('SELECT 1'));
  session(temp,'11','replacement-wake');renameSync(temp,first.sessionPath);
  assert.equal(repo.detail('11','replacement-wake')?.wake.wakeId,'replacement-wake');
  assert.equal(repo.detail('11','wake'),null);
});

test('more than 32 members are exposed and telemetry queries batch without dropping groups', async t => {
  const ids=Array.from({length:205},(_,i)=>String(i+1));const f=fixture(t,ids);
  const app=buildApp({getGroups:()=>ids.map(f.source),telemetryPath:f.telemetryPath,now:()=>300});t.after(()=>app.close());
  assert.equal((await app.inject('/api/meta')).json().groups.length,205);
  const response=await app.inject('/api/overview?since=0&until=300');
  assert.equal(response.statusCode,200);assert.equal(response.json().groups.length,205);assert.equal(response.json().summary.requests,205);
  assert.equal((await app.inject('/api/overview?groupId=205&since=0&until=300')).json().summary.requests,1);
});

test('cross-batch aggregate resource overflow returns 503 rather than partial totals', async t => {
  const ids=Array.from({length:201},(_,i)=>String(i+1));const f=fixture(t,ids,50);
  const app=buildApp({getGroups:()=>ids.map(f.source),telemetryPath:f.telemetryPath,now:()=>300});t.after(()=>app.close());
  assert.equal((await app.inject('/api/overview?since=0&until=300')).statusCode,503);
});
