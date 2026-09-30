import test from 'node:test';
import assert from 'node:assert/strict';
import type { Api } from '../../../../src/contracts/onebot.ts';
import type { JsonObject } from '../../../../src/contracts/json.ts';
import type { TurnContext } from '../../../../src/contracts/tools.ts';
import type { TimelineEntry } from '../../../../src/contracts/messages.ts';
import { GroupActionTools, GROUP_ACTION_TOOL_NAMES } from '../../../../src/tools/actions/tools.ts';
const ctx: TurnContext={groupId:'123',selfId:'456',actorId:'789',messageId:'1'};
function fixture() {
  const calls: {action:string;params?:JsonObject}[]=[];
  const state={role:'admin',targetRole:'member',targetGroup:'123',targetId:'789',self:'456',messageGroup:'123',sender:'789',notice:true,noticeGroup:'123',hook:undefined as undefined|((action:string)=>void)};
  let entries:TimelineEntry[]=[{messageId:'1',userId:'789',nickname:'user',text:'hello',time:1}];
  const api:Api={async call(action,params){calls.push({action,params});state.hook?.(action);
    if(action==='get_login_info')return {user_id:state.self};
    if(action==='get_group_member_info')return params?.user_id===ctx.selfId?{group_id:ctx.groupId,user_id:ctx.selfId,role:state.role}:{group_id:state.targetGroup,user_id:state.targetId,role:state.targetRole};
    if(action==='get_msg')return {message_type:'group',group_id:state.messageGroup,message_id:'1',sender:{user_id:state.sender}};
    if(action==='_get_group_notice')return state.notice?[{notice_id:'N1',group_id:state.noticeGroup}]:[];
    return null;
  }};
  const tools=new GroupActionTools(api,ctx.groupId,GROUP_ACTION_TOOL_NAMES,{recent:()=>entries,find:id=>entries.find(x=>x.messageId===id)});
  return {api,tools,state,calls,setEntries(value:TimelineEntry[]){entries=value;}};
}
const kick={user_id:'789',reject_add_request:false};
const reads=new Set(['get_login_info','get_group_member_info','get_msg','_get_group_notice']);
test('proposal is read-only and does not consume dedup or unknown state for identical actual execution',async()=>{
  const f=fixture();
  await f.tools.verifyProposal('kick_member',kick,ctx);await f.tools.verifyProposal('kick_member',kick,ctx);
  assert.ok(f.calls.every(call=>reads.has(call.action)));
  const submission=await f.tools.execute('kick_member',kick,ctx);assert.equal(submission.status,'ok');assert.equal(submission.submitted,true);assert.equal(submission.effect_confirmed,false);
  assert.equal(f.calls.filter(call=>call.action==='set_group_kick').length,1);
  await f.tools.execute('kick_member',kick,ctx);assert.equal(f.calls.filter(call=>call.action==='set_group_kick').length,1);
});
test('kick and administrator proposals require actual current role and target authority',async()=>{
  const f=fixture();f.state.role='member';await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'permission_denied'});
  f.state.role='admin';f.state.targetRole='admin';await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'permission_denied'});
  await assert.rejects(f.tools.verifyProposal('set_group_admin',{user_id:'789',enable:true},ctx),{message:'permission_denied'});
  f.state.role='owner';await f.tools.verifyProposal('set_group_admin',{user_id:'789',enable:false},ctx);
  f.state.targetRole='owner';await assert.rejects(f.tools.verifyProposal('set_group_admin',{user_id:'789',enable:false},ctx),{message:'permission_denied'});
  await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'permission_denied'});
  assert.ok(f.calls.every(call=>reads.has(call.action)));
});
test('off, unknown names, malformed parameters, contexts and accessors fail before reads',async()=>{
  const f=fixture();
  await assert.rejects(new GroupActionTools(f.api,ctx.groupId).verifyProposal('kick_member',kick,ctx),{message:'tool_disabled'});
  await assert.rejects(f.tools.verifyProposal('invented',{},ctx),{message:'tool_disabled'});
  await assert.rejects(f.tools.verifyProposal('kick_member',{...kick,group_id:'999'},ctx),{message:'invalid_arguments'});
  await assert.rejects(f.tools.verifyProposal('kick_member',kick,{...ctx,groupId:'999'}),{message:'forbidden_group'});
  for(const context of [{...ctx,selfId:'0'},{...ctx,actorId:'0'},{...ctx,messageId:'1\n'}])await assert.rejects(f.tools.verifyProposal('kick_member',kick,context),{message:'invalid_context'});
  let reads=0;
  await assert.rejects(f.tools.verifyProposal('kick_member',{get user_id(){reads++;return '789';},reject_add_request:false},ctx),{message:'invalid_arguments'});
  await assert.rejects(f.tools.verifyProposal('kick_member',kick,{...ctx,get selfId(){reads++;return '456';}}),{message:'forbidden_group'});
  assert.equal(reads,0);assert.deepEqual(f.calls,[]);
});
test('identity and target membership proof is repeated and cannot cross current group',async()=>{
  const f=fixture();f.state.self='999';await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'identity_mismatch'});
  f.state.self='456';f.state.targetGroup='999';await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'verification_failed'});
  f.state.targetGroup='123';f.state.targetId='999';await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'verification_failed'});
  f.state.targetId='789';await f.tools.verifyProposal('kick_member',kick,ctx);
  f.state.role='member';await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'permission_denied'});
  assert.ok(f.calls.every(call=>reads.has(call.action)));
});
test('message and announcement proposals reuse live provenance checks instead of accepting guessed IDs',async()=>{
  const f=fixture();
  await assert.rejects(f.tools.verifyProposal('set_group_essence',{message_id:'2'},ctx),{message:'forbidden_reference'});
  await f.tools.verifyProposal('set_group_essence',{message_id:'1'},ctx);
  f.state.messageGroup='999';await assert.rejects(f.tools.verifyProposal('remove_group_essence',{message_id:'1'},ctx),{message:'verification_failed'});
  f.state.messageGroup='123';f.state.sender='999';await assert.rejects(f.tools.verifyProposal('set_group_essence',{message_id:'1'},ctx),{message:'verification_failed'});
  f.state.sender='789';f.state.hook=action=>{if(action==='get_msg')f.setEntries([]);};
  await assert.rejects(f.tools.verifyProposal('set_group_essence',{message_id:'1'},ctx),{message:'forbidden_reference'});
  f.state.hook=undefined;await f.tools.verifyProposal('delete_group_notice',{notice_id:'N1'},ctx);
  f.state.notice=false;await assert.rejects(f.tools.verifyProposal('delete_group_notice',{notice_id:'N1'},ctx),{message:'forbidden_reference'});
  f.state.notice=true;f.state.noticeGroup='999';await assert.rejects(f.tools.verifyProposal('delete_group_notice',{notice_id:'N1'},ctx),{message:'verification_failed'});
  assert.ok(f.calls.every(call=>reads.has(call.action)));
});
test('abort during reads and upstream failures never dispatch or leak raw errors',async()=>{
  for(const action of ['get_login_info','get_group_member_info']){
    const f=fixture(),controller=new AbortController();f.state.hook=current=>{if(current===action)controller.abort();};
    await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx,controller.signal),{message:'cancelled'});
    assert.ok(f.calls.every(call=>reads.has(call.action)));
  }
  const f=fixture();f.state.hook=()=>{throw new Error('PRIVATE https://secret');};
  await assert.rejects(f.tools.verifyProposal('kick_member',kick,ctx),{message:'verification_unavailable'});
  const badMemory=new GroupActionTools(f.api,ctx.groupId,['set_group_essence'],{recent(){throw new Error('PRIVATE database path');},find(){return undefined;}});
  await assert.rejects(badMemory.verifyProposal('set_group_essence',{message_id:'1'},ctx),{message:'verification_failed'});
});
