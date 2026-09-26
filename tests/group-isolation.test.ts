import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GroupTools } from '../src/group-tools.js';
import { ImageTools } from '../src/image-tools.js';
import { ForwardTools } from '../src/forward-tools.js';
import { Moderation } from '../src/moderation.js';
import { SQLiteMemory } from '../src/memory.js';
import { LISTENER_GROUP, OWNER_ID, type Api, type Memory, type TimelineEntry, type TurnContext } from '../src/contracts.js';

const A='111111', B='222222', self='999', user='123';
const ctx=(groupId:string,actorId=user):TurnContext=>({groupId,actorId,selfId:self,messageId:'1'});
const entry=(text='local'):TimelineEntry=>({messageId:'1',userId:user,nickname:'member',text,time:Math.floor(Date.now()/1000),replyTo:'2',images:[{id:'img_1_0',index:0}],forwards:[{id:'fwd_1_0',index:0}]});
function memory(text='local'):Memory {
 let entries=[entry(text)];return {recent:()=>entries,find:id=>entries.find(e=>e.messageId===id),context:()=>JSON.stringify(entries),append:()=>false,compact:async()=>{},clear(){entries=[];},close(){}};
}
function api(handler:(action:string,params:Record<string,unknown>)=>unknown){
 const calls:{action:string;params:Record<string,unknown>}[]=[];
 const client:Api={async call(action,params={}){calls.push({action,params});return handler(action,params);}};
 return {client,calls};
}
const member=(groupId:string)=>({group_id:groupId,user_id:user,nickname:'member',role:'member'});
const msg=(groupId:string,id='1',message:unknown[]=[{type:'text',data:{text:groupId}}])=>({message_type:'group',group_id:groupId,message_id:id,sender:{user_id:user},message});
const imageOptions={enabled:true,maxPerTurn:3,maxDownloadMb:1};
const forwardOptions={enabled:true,maxPerRead:20};
const forwardArgs={forward_id:'fwd_1_0',start:1,end:1};

test('group tools bind configuration immutably and isolate colliding local/member/message IDs',async()=>{
 for(const [group,other] of [[A,B],[B,A]]){
  const a=api((action)=>action==='get_group_member_list'?[member(group!)]:action==='get_group_member_info'?member(group!):msg(group!,'2'));
  const options={groupId:group!};const tools=new GroupTools(a.client,memory(group),options);options.groupId=other!;
  const local=await tools.execute('read_message',{message_id:'1'},ctx(group!));assert.equal((local.message as any).text,group);
  const remote=await tools.execute('read_message',{message_id:'2'},ctx(group!));assert.deepEqual((remote.message as any).segments,[{type:'text',text:group}]);assert.equal((remote.message as any).text,undefined);
  assert.equal((await tools.execute('get_member_info',{user_id:user},ctx(group!))).status,'ok');
  assert.equal((await tools.execute('get_group_members',{},ctx(group!))).status,'ok');
  await tools.prepareMessage({parts:[{segments:[{type:'at',user_id:user}]}]},ctx(group!));
  for(const call of a.calls.filter(c=>c.action.startsWith('get_group_member')))assert.equal(call.params.group_id,group);
  const before=a.calls.length;
  assert.equal((await tools.execute('get_member_info',{user_id:user},ctx(other!))).error,'forbidden_group');
  await assert.rejects(tools.prepareMessage({parts:[{text:'no'}]},ctx(other!)),/forbidden_group/);
  assert.equal(a.calls.length,before);
 }
});

test('group tools reject foreign response provenance even with identical requested IDs',async()=>{
 for(const group of [A,B]){
  const other=group===A?B:A;
  const a=api(action=>action==='get_group_member_list'?[member(other)]:action==='get_group_member_info'?member(other):msg(other,'2'));
  const tools=new GroupTools(a.client,memory(),{groupId:group});
  for(const [name,args] of [['get_group_members',{}],['get_member_info',{user_id:user}],['read_message',{message_id:'2'}]] as const)assert.equal((await tools.execute(name,args,ctx(group))).status,'error');
  await assert.rejects(tools.prepareMessage({parts:[{segments:[{type:'at',user_id:user}]}]},ctx(group)),/verification_failed/);
  await assert.rejects(tools.prepareMessage({parts:[{text:'no',reply_to:'2'}]},ctx(group)),/verification_failed/);
 }
});

test('image sources stay bound to group and per-instance turn states with colliding image IDs',async()=>{
 const instances=[A,B].map(group=>{
  let downloads=0;let foreign=false;
  const a=api(()=>msg(foreign?(group===A?B:A):group,'1',[{type:'image',data:{url:`https://example.invalid/${group}`}}]));
  const tools=new ImageTools(a.client,memory(),imageOptions,async()=>{downloads++;return {dataUrl:'data:image/jpeg;base64,YQ==',width:1,height:1,firstFrameOnly:false};},group);
  return {group,...a,tools,get downloads(){return downloads;},foreign(){foreign=true;}};
 });
 for(const s of instances){
  const state=s.tools.createTurn();
  assert.equal((await s.tools.view({image_ids:['img_1_0']},ctx(s.group===A?B:A),state)).result.error,'forbidden_group');assert.equal(s.calls.length,0);
  assert.equal((await s.tools.view({image_ids:['img_1_0']},ctx(s.group),state)).result.status,'ok');assert.equal(s.downloads,1);
  const other=instances.find(i=>i!==s)!;
  const before=other.calls.length;
  assert.equal((await other.tools.view({image_ids:['img_1_0']},ctx(other.group),state)).result.error,'invalid_arguments');assert.equal(other.calls.length,before);
  s.foreign();assert.equal((await s.tools.view({image_ids:['img_1_0']},ctx(s.group),s.tools.createTurn())).result.status,'error');assert.equal(s.downloads,1);
 }
});

test('forward resources and cached pages cannot cross instances with colliding root/resource IDs',async()=>{
 const instances=[A,B].map(group=>{
  let foreign=false;
  const a=api(action=>action==='get_msg'?msg(foreign?(group===A?B:A):group,'1',[{type:'forward',data:{id:'same-resource'}}]):{messages:[{sender:{user_id:user,nickname:'same sender'},message:[{type:'text',data:{text:`private-${group}`}}]}]});
  const tools=new ForwardTools(a.client,memory(),forwardOptions,group);
  return {group,...a,tools,foreign(){foreign=true;}};
 });
 for(const s of instances){
  const state=s.tools.createTurn();assert.equal((await s.tools.read(forwardArgs,ctx(s.group===A?B:A),state)).error,'forbidden_group');assert.equal(s.calls.length,0);
  const result=await s.tools.read(forwardArgs,ctx(s.group),state);assert.equal(result.status,'ok');assert.deepEqual((result.messages as any[])[0].segments,[{type:'text',text:`private-${s.group}`}]);assert.equal((result.messages as any[])[0].text,undefined);
  const before=s.calls.length;assert.equal((await s.tools.read(forwardArgs,ctx(s.group),state)).status,'ok');assert.equal(s.calls.length,before);
  const other=instances.find(i=>i!==s)!;const otherBefore=other.calls.length;
  assert.equal((await other.tools.read(forwardArgs,ctx(other.group),state)).error,'invalid_arguments');assert.equal(other.calls.length,otherBefore);
  s.foreign();const count=s.calls.length;assert.equal((await s.tools.read(forwardArgs,ctx(s.group),s.tools.createTurn())).status,'error');assert.equal(s.calls.length,count+1);assert.equal(s.calls.at(-1)?.action,'get_msg');
 }
});

function moderationFixture(group:string){
 let foreign=false;
 const a=api((action,params)=>action==='get_login_info'?{user_id:self}:action==='get_group_member_info'?{...member(foreign?(group===A?B:A):group),user_id:params.user_id,role:params.user_id===self?'admin':'member'}:action==='get_msg'?msg(foreign?(group===A?B:A):group,String(params.message_id)):{});
 return {...a,tools:new Moderation(a.client,Date.now,{mute:'confirm',unmute:'confirm',recall:'confirm',memberCard:'confirm'},group),foreign(){foreign=true;}};
}
test('autonomous moderation proposals remain groupbound and only the owner can confirm',async()=>{
 const a=moderationFixture(A), b=moderationFixture(B);
 for(const s of [a,b]){
  const group=s===a?A:B,other=group===A?B:A;
  assert.equal((await s.tools.request('mute_member',{user_id:user,seconds:1},ctx(other,OWNER_ID))).status,'error');
  assert.equal(s.calls.length,0);
 }
 const proposal=await a.tools.request('unmute_member',{user_id:user},ctx(A,user));assert.equal(proposal.status,'confirmation_required');assert.match(String(proposal.description),new RegExp(A));
 const code=String(proposal.code);
 const beforeUnauthorized=a.calls.length;assert.equal((await a.tools.confirm(code,ctx(A,user))).status,'error');assert.equal(a.calls.length,beforeUnauthorized);
 assert.equal((await b.tools.confirm(code,ctx(B,OWNER_ID))).status,'error');assert.equal(b.calls.length,0);
 assert.equal((await a.tools.confirm(code,ctx(A,OWNER_ID))).status,'executed');
 assert.deepEqual(a.calls.find(c=>c.action==='set_group_ban')?.params,{group_id:A,user_id:user,duration:0});
 assert.equal((await a.tools.confirm(code,ctx(A,OWNER_ID))).status,'error');
 const bProposal=await b.tools.request('set_member_card',{user_id:user,card:'new card'},ctx(B,OWNER_ID));assert.equal(bProposal.status,'confirmation_required');
 const before=b.calls.length;assert.equal((await b.tools.confirm(String(bProposal.code),ctx(A,OWNER_ID))).status,'error');assert.equal(b.calls.length,before);
 for(const target of [OWNER_ID,self])assert.equal((await b.tools.request('mute_member',{user_id:target,seconds:1},ctx(B,OWNER_ID))).status,'error');
});

test('moderation rejects foreign member/message data in proposals and repeated confirmation checks',async()=>{
 for(const group of [A,B]){
  for(const [name,args] of [['mute_member',{user_id:user,seconds:1}],['set_member_card',{user_id:user,card:'x'}],['recall_message',{message_id:'42'}]] as const){
   const s=moderationFixture(group);s.foreign();assert.equal((await s.tools.request(name,args,ctx(group,OWNER_ID))).status,'error');assert.ok(!s.calls.some(c=>['set_group_ban','set_group_card','delete_msg'].includes(c.action)));
   const t=moderationFixture(group);const proposal=await t.tools.request(name,args,ctx(group,OWNER_ID));assert.equal(proposal.status,'confirmation_required');t.foreign();assert.equal((await t.tools.confirm(String(proposal.code),ctx(group,OWNER_ID))).status,'error');assert.ok(!t.calls.some(c=>['set_group_ban','set_group_card','delete_msg'].includes(c.action)));
   assert.ok(t.calls.filter(c=>c.action==='get_group_member_info').every(c=>c.params.group_id===group));
  }
 }
});

test('SQLite ownership mismatch is read-only, legacy ownership stays compatible, separate groups keep colliding IDs',t=>{
 const dir=mkdtempSync(join(tmpdir(),'listener-groups-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'legacy.sqlite');const legacy=new SQLiteMemory({path,maxContextChars:4000,retentionDays:7});legacy.append(entry('legacy-content'));legacy.close();
 chmodSync(path,0o640);const bytes=readFileSync(path);const before=statSync(path);
 assert.throws(()=>new SQLiteMemory({path,maxContextChars:4000,retentionDays:7,groupId:B}),/Memory group mismatch/);
 assert.deepEqual(readFileSync(path),bytes);assert.equal(statSync(path).mode,before.mode);assert.equal(statSync(path).mtimeMs,before.mtimeMs);
 const inspect=new DatabaseSync(path,{readOnly:true});assert.equal(inspect.prepare('SELECT group_id FROM listener_identity').get()?.group_id,LISTENER_GROUP);assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM listener_messages').get()?.count,1);inspect.close();
 const barePath=join(dir,'identity-only.sqlite');const bare=new DatabaseSync(barePath);bare.exec('CREATE TABLE listener_identity(singleton INTEGER PRIMARY KEY,group_id TEXT NOT NULL)');bare.prepare('INSERT INTO listener_identity VALUES(1,?)').run(A);bare.close();const bareBytes=readFileSync(barePath);
 assert.throws(()=>new SQLiteMemory({path:barePath,groupId:B,maxContextChars:4000,retentionDays:7}),/Memory group mismatch/);assert.deepEqual(readFileSync(barePath),bareBytes);
 const bareCheck=new DatabaseSync(barePath,{readOnly:true});assert.deepEqual(bareCheck.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['listener_identity']);bareCheck.close();
 const reopened=new SQLiteMemory({path,maxContextChars:4000,retentionDays:7});assert.equal(reopened.find('1')?.text,'legacy-content');assert.equal(JSON.parse(reopened.context()).groupId,LISTENER_GROUP);reopened.close();
 const a=new SQLiteMemory({path:join(dir,'a.sqlite'),groupId:A,maxContextChars:4000,retentionDays:7});const b=new SQLiteMemory({path:join(dir,'b.sqlite'),groupId:B,maxContextChars:4000,retentionDays:7});
 try{assert.equal(a.append(entry('A-only')),true);assert.equal(b.append(entry('B-only')),true);assert.equal(a.append(entry('duplicate')),false);assert.equal(b.append(entry('duplicate')),false);assert.equal(a.find('1')?.text,'A-only');assert.equal(b.find('1')?.text,'B-only');assert.equal(JSON.parse(a.context()).groupId,A);assert.equal(JSON.parse(b.context()).groupId,B);a.clear();assert.equal(a.find('1'),undefined);assert.equal(b.find('1')?.text,'B-only');}finally{a.close();b.close();}
});

test('all constructors reject invalid group IDs before opening files or calling APIs',t=>{
 const dir=mkdtempSync(join(tmpdir(),'listener-invalid-groups-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const a=api(()=>{throw Error('no API allowed');});
 for(const group of [null,0,123,'','0','01',' 123','123 ','-1','1\n','1'.repeat(33),{},[]]){
  assert.throws(()=>new GroupTools(a.client,memory(),{groupId:group as any}));
  assert.throws(()=>new ImageTools(a.client,memory(),imageOptions,undefined,group as any));
  assert.throws(()=>new ForwardTools(a.client,memory(),forwardOptions,group as any));
  assert.throws(()=>new Moderation(a.client,Date.now,{},group as any));
  const path=join(dir,'must-not-exist.sqlite');assert.throws(()=>new SQLiteMemory({path,groupId:group as any,maxContextChars:4000,retentionDays:7}));assert.equal(existsSync(path),false);
 }
 assert.equal(a.calls.length,0);
});
