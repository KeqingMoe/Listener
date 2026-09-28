import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeEventStore } from '../src/observability/runtime-events.js';
import { configureLogging, log, observeLogs } from '../src/observability/logger.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'runtime-events-'));chmodSync(dir,0o700);return{dir,path:join(dir,'events.sqlite'),close(){rmSync(dir,{recursive:true,force:true});}};}

test('diagnostic observer sees console-filtered debug metadata, never message content, and cannot change other sinks',async()=>{
 const f=fixture(),store=new RuntimeEventStore(f.path);
 const logger=configureLogging({level:'info',console:false,file:false,directory:f.dir,retentionDays:7,maxFileMb:1,maxTotalMb:2},['private-credential']);
 const stopBroken=observeLogs(()=>{throw Error('broken sink');});
 const stopMutating=observeLogs(record=>{record.fields.reason='mutated';});
 const stop=observeLogs(record=>store.record(record));
 try{
  log('debug','trigger.skipped',{group_id:'123456789',message_id:'123',turn_id:'t_0123456789abcdef',reason:'random_not_selected',text:'PRIVATE_CHAT',authorization:'private-credential'});
  log('debug','app.heartbeat',{status:'connected'});
  const db=new DatabaseSync(f.path,{readOnly:true});try{
   const rows=db.prepare('SELECT * FROM runtime_events ORDER BY seq').all();assert.equal(rows.length,2);
   assert.equal(rows[0]!.group_id,'123456789');assert.equal(rows[0]!.turn_id,'t_0123456789abcdef');
   assert.equal(JSON.parse(String(rows[0]!.fields)).reason,'random_not_selected');
   assert.equal(JSON.parse(String(rows[1]!.fields)).status,'connected');
   assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_CHAT|private-credential|mutated/);
  }finally{db.close();}
 }finally{stop();stopBroken();stopMutating();store.close();await logger.close();f.close();}
});

test('runtime event index is bounded, expires old metadata and rejects symlink destinations',()=>{
 const f=fixture();let store=new RuntimeEventStore(f.path);
 try{
  store.record({event:'onebot.message_received',level:'debug',observedAt:1,fields:{group_id:'123456789',message_id:'1',raw:'PRIVATE'}});
  store.record({event:'app.heartbeat',level:'debug',observedAt:9*86400000,fields:{status:'connected'}});
  store.close();const db=new DatabaseSync(f.path);try{
   assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_events').get()!.n,1);
   db.exec('BEGIN');const insert=db.prepare("INSERT INTO runtime_events(observed_at,event,fields) VALUES(?, 'app.heartbeat', '{}')");for(let i=0;i<30010;i++)insert.run(9*86400000);db.exec('COMMIT');
  }finally{db.close();}
  store=new RuntimeEventStore(f.path);store.record({event:'app.heartbeat',level:'debug',observedAt:9*86400000+60001,fields:{status:'connected'}});
  const check=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(check.prepare('SELECT COUNT(*) n FROM runtime_events').get()!.n,30000);}finally{check.close();}
  const link=join(f.dir,'link.sqlite');symlinkSync(f.path,link);assert.throws(()=>new RuntimeEventStore(link));
 }finally{store.close();f.close();}
});
