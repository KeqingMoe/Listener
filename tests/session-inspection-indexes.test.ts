import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ModelSession } from '../src/agent/session/store.js';
import { SESSION_INSPECTION_INDEXES, SESSION_PHYSICAL_TURN } from '../src/agent/session/indexes.js';

test('diagnostic metadata indexes target requests, wakes and physical turns without scanning history bodies',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE model_session_messages(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,request_id TEXT,message TEXT);
    CREATE TABLE model_session_journal(seq INTEGER PRIMARY KEY,kind TEXT,created_at INTEGER,wake_id TEXT);
    CREATE TABLE model_tool_ledger(ordinal INTEGER PRIMARY KEY,assistant_seq INTEGER,wake_id TEXT);`);
  db.prepare('INSERT INTO model_session_messages VALUES(1,?,?,?,?)').run('session','wake','req',JSON.stringify({role:'user',content:JSON.stringify({wake:{wake_id:'t_1234567890abcdef'}})}));
  db.prepare('INSERT INTO model_session_messages VALUES(2,?,?,?,?)').run('session','wake',null,'malformed historical record');
  db.exec(SESSION_INSPECTION_INDEXES);db.exec(SESSION_INSPECTION_INDEXES);
  for(const [where,value,index] of [['request_id=?','req','messages_request'],['wake_id=?','wake','messages_wake'],[`${SESSION_PHYSICAL_TURN}=?`,'t_1234567890abcdef','messages_turn']]){
   const plan=JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT seq FROM model_session_messages WHERE ${where}`).all(value!));
   assert.ok(plan.includes(index!),plan);assert.ok(db.prepare(`SELECT seq FROM model_session_messages WHERE ${where}`).all(value!).length>0);
  }
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  assert.equal(db.prepare(`SELECT seq FROM model_session_messages WHERE ${SESSION_PHYSICAL_TURN}=?`).get('t_1234567890abcdef')!.seq,1);
 }finally{db.close();}
});

test('ModelSession still preserves primary wake and ledger behavior with inspection indexes',()=>{
 const session=new ModelSession({path:':memory:',groupId:'123456789'});
 try{session.beginWake('system',[],{wake_id:'t_1234567890abcdef'});assert.ok(session.state().wakeId);session.finishWake('finished');assert.equal(session.state().wakeId,undefined);}finally{session.close();}
});
