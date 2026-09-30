import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,symlinkSync,statSync,writeFileSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReminderStore,REMINDER_GRACE_MS} from '../../../src/reminders/store.ts';
const input={selfId:'1',groupId:'2',creatorId:'3',sourceMessageId:'-4',text:'remind me',dueAt:2000,timeZone:'Asia/Shanghai'};
const scope=(r:ReturnType<ReminderStore['create']>)=>({selfId:r.selfId,groupId:r.groupId,id:r.id,expectedRevision:r.revision});
test('scope, revision CAS, pending edits and cancellation',()=>{
 const s=new ReminderStore({path:':memory:'});try{
 const r=s.create(input,1000);assert.equal(r.expiresAt,2000+REMINDER_GRACE_MS);
 assert.equal(s.get('9','2',r.id),undefined);assert.equal(s.get('1','9',r.id),undefined);
 assert.equal(s.cancel({...scope(r),groupId:'9'},1001),undefined);
 const changed=s.update(scope(r),{text:'new',dueAt:3000},1001)!;assert.equal(changed.revision,2);
 assert.equal(s.update(scope(r),{text:'stale'},1002),undefined);
 assert.equal(s.claim(r.id,1,'1','2',3000),false);
 assert.equal(s.cancel(scope(changed),1002)?.state,'cancelled');
 assert.equal(s.claim(r.id,3,'1','2',3000),false);
 }finally{s.close();}
});
test('due and expiry exact boundaries, scoped list and claimed settlement',()=>{
 const s=new ReminderStore({path:':memory:'});try{
 const r=s.create(input,1000);s.create({...input,selfId:'9'},1000);
 assert.equal(s.due('1',1999).length,0);assert.equal(s.due('1',2000).length,1);
 assert.equal(s.claim(r.id,1,'9','2',2000),false);assert.equal(s.claim(r.id,1,'1','2',2000),true);
 assert.equal(s.claim(r.id,1,'1','2',2000),false);
 assert.equal(s.settle({...scope(r),expectedRevision:2},{state:'sent',messageId:'5'},2001)?.state,'sent');
 assert.equal(s.settle({...scope(r),expectedRevision:3},{state:'failed'},2002),undefined);
 const other=s.create({...input,dueAt:3000},1000);assert.equal(s.due('1',other.expiresAt).length,0);
 assert.equal(s.expire(other.expiresAt,'1'),1);assert.equal(s.get('1','2',other.id)?.state,'expired');
 assert.equal(s.list('1','2',{limit:1,state:'sent'}).length,1);
 assert.equal(s.list('9','2',{limit:10})[0]?.state,'pending');
 }finally{s.close();}
});
test('restart recovers sending to unknown without replay and preserves sent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reminder-store-')),path=join(dir,'r.sqlite');let s=new ReminderStore({path});
 try{const r=s.create(input,1000);s.claim(r.id,1,'1','2',2000);s.close();s=new ReminderStore({path});
 assert.equal(s.get('1','2',r.id)?.state,'unknown');assert.equal(s.get('1','2',r.id)?.reason,'restart_during_send');assert.deepEqual(s.due('1',2001),[]);assert.equal(statSync(path).mode&0o777,0o600);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('invalid timestamps, identity, timezone and unsafe files fail closed',()=>{
 const s=new ReminderStore({path:':memory:'});try{
 for(const dueAt of [0,-1,1000,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER,8640000000000000])assert.throws(()=>s.create({...input,dueAt},1000));
 assert.throws(()=>s.create({...input,timeZone:'Not/AZone'},1000));assert.throws(()=>s.create({...input,selfId:'01'},1000));
 }finally{s.close();}assert.throws(()=>s.due('1',2000));
 const dir=mkdtempSync(join(tmpdir(),'reminder-files-'));try{
 const original=join(dir,'original');writeFileSync(original,'');symlinkSync(original,join(dir,'symlink'));assert.throws(()=>new ReminderStore({path:join(dir,'symlink')}));
 linkSync(original,join(dir,'hardlink'));assert.throws(()=>new ReminderStore({path:original}));
 const path=join(dir,'r.sqlite');symlinkSync(original,path+'-journal');assert.throws(()=>new ReminderStore({path}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
