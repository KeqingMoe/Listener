import test from 'node:test';
import assert from 'node:assert/strict';
import type { Api, JsonObject, TurnContext } from '../src/contracts/index.js';
import { GroupFileTools, GROUP_FILE_TOOL_NAMES } from '../src/group-file-tools.js';
import { GroupRequestTools, GROUP_REQUEST_TOOL_NAMES } from '../src/group-request-tools.js';
const ctx: TurnContext = {groupId:'123',selfId:'456',actorId:'789',messageId:'1'};
const FILE_ID='PROVIDER_FILE_SECRET', FOLDER_ID='PROVIDER_FOLDER_SECRET';
function files() {
  const calls:string[]=[];
  const state={role:'admin',fileName:'report.txt',folderName:'资料',uploader:'789',size:12,exists:true,hook:undefined as undefined|((action:string)=>void)};
  const api:Api={async call(action){calls.push(action);state.hook?.(action);
    if(action==='get_login_info')return {user_id:ctx.selfId};
    if(action==='get_group_member_info')return {group_id:ctx.groupId,user_id:ctx.selfId,role:state.role};
    if(action==='get_group_root_files')return {files:state.exists?[{group_id:ctx.groupId,file_id:FILE_ID,file_name:state.fileName,file_size:state.size,uploader:state.uploader,url:'https://PRIVATE'}]:[],folders:state.exists?[{group_id:ctx.groupId,folder_id:FOLDER_ID,folder_name:state.folderName,total_file_count:1,creator:'789'}]:[]};
    if(action==='delete_group_folder')return {retCode:0};
    if(action==='upload_group_file')return {file_id:'created'};
    return null;
  }};
  const tools=new GroupFileTools(api,ctx.groupId,GROUP_FILE_TOOL_NAMES);
  return {tools,api,state,calls,async handles(){const result=await tools.execute('list_group_files',{limit:5},ctx);assert.equal(result.status,'ok');const rows=result.items as JsonObject[];return {file_handle:rows.find(row=>row.kind==='file')!.file_handle,folder_handle:rows.find(row=>row.kind==='folder')!.folder_handle};}};
}
function requests() {
  const calls:string[]=[];
  const state={role:'admin',applicant:789,pending:true,group:123,hook:undefined as undefined|((action:string)=>void)};
  const api:Api={async call(action){calls.push(action);state.hook?.(action);
    if(action==='get_login_info')return {user_id:ctx.selfId};
    if(action==='get_group_member_info')return {group_id:ctx.groupId,user_id:ctx.selfId,role:state.role};
    if(action==='get_group_system_msg')return {join_requests:[{request_id:1700000000000001,group_id:state.group,invitor_uin:state.applicant,checked:!state.pending,requester_nick:'UNTRUSTED',message:'https://PRIVATE'}],invited_requests:[]};
    return null;
  }};
  const tools=new GroupRequestTools(api,ctx.groupId,GROUP_REQUEST_TOOL_NAMES);
  return {tools,api,state,calls,async args(){const result=await tools.execute('list_group_requests',{limit:5},ctx);assert.equal(result.status,'ok');return {request_handle:(result.items as JsonObject[])[0]!.request_handle,approve:true,reason:''};}};
}
const noFileWrites=(calls:string[])=>assert.ok(calls.every(name=>!['delete_group_file','delete_group_folder','upload_group_file','create_group_file_folder'].includes(name)));
test('file previews are stable fresh human descriptions without resource IDs, writes or reservations',async()=>{
  const f=files(),h=await f.handles();f.calls.length=0;
  const args={file_handle:h.file_handle};
  const a=await f.tools.confirmationDetails('delete_group_file',args,ctx),b=await f.tools.confirmationDetails('delete_group_file',args,ctx);
  assert.equal(a,b);assert.match(a,/report.txt/);assert.match(a,/789/);assert.match(a,/123/);assert.match(a,/12/);
  assert.doesNotMatch(a,/PROVIDER_|https:|PRIVATE|gf_|expires|queried/);noFileWrites(f.calls);
  // A preview must not reserve a target or consume a write-cache entry.
  const result=await f.tools.execute('delete_group_file',args,ctx);assert.equal(result.status,'unknown');assert.equal(f.calls.filter(x=>x==='delete_group_file').length,1);
});
test('file details change with live name, even beyond displayed name prefix, size or uploader',async()=>{
  const f=files(),h=await f.handles(),args={file_handle:h.file_handle};
  const first=await f.tools.confirmationDetails('delete_group_file',args,ctx);
  f.state.fileName='renamed.txt';const second=await f.tools.confirmationDetails('delete_group_file',args,ctx);assert.notEqual(first,second);
  f.state.fileName='a'.repeat(200)+'one';const longA=await f.tools.confirmationDetails('delete_group_file',args,ctx);
  f.state.fileName='a'.repeat(200)+'two';assert.notEqual(await f.tools.confirmationDetails('delete_group_file',args,ctx),longA);
  const beforeSize=await f.tools.confirmationDetails('delete_group_file',args,ctx);f.state.size++;assert.notEqual(await f.tools.confirmationDetails('delete_group_file',args,ctx),beforeSize);
  const beforeOwner=await f.tools.confirmationDetails('delete_group_file',args,ctx);f.state.uploader='999';assert.notEqual(await f.tools.confirmationDetails('delete_group_file',args,ctx),beforeOwner);noFileWrites(f.calls);
});
test('file preflight checks fresh ownership and role, root or actual upload destination',async()=>{
  const f=files(),h=await f.handles();
  f.state.role='member';
  await assert.rejects(f.tools.confirmationDetails('delete_group_file',{file_handle:h.file_handle},ctx),{message:'insufficient_permission'});
  f.state.uploader=ctx.selfId;await f.tools.confirmationDetails('delete_group_file',{file_handle:h.file_handle},ctx);
  await assert.rejects(f.tools.confirmationDetails('delete_group_folder',{folder_handle:h.folder_handle},ctx),{message:'insufficient_permission'});
  const upload={name:'new.txt',content:'literal content',folder_handle:h.folder_handle};
  const description=await f.tools.confirmationDetails('upload_group_text_file',upload,ctx);assert.match(description,/资料/);assert.match(description,/new.txt/);assert.doesNotMatch(description,/PROVIDER_|literal content/);
  f.state.folderName='已改名';assert.notEqual(await f.tools.confirmationDetails('upload_group_text_file',upload,ctx),description);
  assert.match(await f.tools.confirmationDetails('create_group_folder',{name:'new folder'},ctx),/本群文件根目录/);
  f.state.exists=false;await assert.rejects(f.tools.confirmationDetails('upload_group_text_file',upload,ctx),{message:'resource_not_verified'});noFileWrites(f.calls);
});
test('file previews reject off, wrong group, invented or wrong-kind handles and getters without native calls',async()=>{
  const f=files(),h=await f.handles();f.calls.length=0;
  await assert.rejects(new GroupFileTools(f.api,ctx.groupId).confirmationDetails('delete_group_file',{file_handle:h.file_handle},ctx),{message:'tool_disabled'});
  await assert.rejects(f.tools.confirmationDetails('delete_group_file',{file_handle:h.file_handle},{...ctx,groupId:'999'}),{message:'forbidden_group'});
  await assert.rejects(f.tools.confirmationDetails('delete_group_file',{file_handle:'gf_'+'0'.repeat(48)},ctx),{message:'invalid_handle'});
  await assert.rejects(f.tools.confirmationDetails('delete_group_file',{file_handle:h.folder_handle},ctx),{message:'invalid_handle'});
  let invoked=0;const args={name:'f.txt',get content(){invoked++;return 'secret';}};
  await assert.rejects(f.tools.confirmationDetails('upload_group_text_file',args,ctx),{message:'invalid_arguments'});
  const badContext={...ctx,get selfId(){invoked++;return ctx.selfId;}};
  await assert.rejects(f.tools.confirmationDetails('create_group_folder',{name:'a'},badContext),{message:'invalid_arguments'});
  assert.equal(invoked,0);assert.deepEqual(f.calls,[]);
});
test('file previews suppress expired, cancelled and reset-in-flight handles and static API errors',async t=>{
  const now=Date.now();let clock=now;t.mock.method(Date,'now',()=>clock);
  const f=files(),h=await f.handles(),args={file_handle:h.file_handle};
  f.state.hook=action=>{if(action==='get_group_root_files')clock=now+16*60*1000;};
  await assert.rejects(f.tools.confirmationDetails('delete_group_file',args,ctx),{message:'invalid_handle'});noFileWrites(f.calls);
  clock=now;f.state.hook=undefined;const h2=await f.handles();
  f.state.hook=action=>{if(action==='get_group_root_files')f.tools.reset();};
  await assert.rejects(f.tools.confirmationDetails('delete_group_file',{file_handle:h2.file_handle},ctx),{message:'cancelled'});
  f.state.hook=undefined;const h3=await f.handles();const controller=new AbortController();
  f.state.hook=action=>{if(action==='get_group_root_files')controller.abort();};
  await assert.rejects(f.tools.confirmationDetails('delete_group_file',{file_handle:h3.file_handle},ctx,controller.signal),{message:'cancelled'});
  f.state.hook=()=>{throw new Error('PRIVATE https://signed.example/token');};
  await assert.rejects(f.tools.confirmationDetails('create_group_folder',{name:'a'},ctx),{message:'api_unavailable'});noFileWrites(f.calls);
});
test('request descriptions identify applicant and decision without flags and do not reserve the request',async()=>{
  const f=requests(),args=await f.args();f.calls.length=0;
  const a=await f.tools.confirmationDetails('respond_group_request',args,ctx);
  assert.equal(a,await f.tools.confirmationDetails('respond_group_request',args,ctx));
  assert.match(a,/同意入群申请/);assert.match(a,/789/);assert.match(a,/123/);assert.doesNotMatch(a,/1700000000000001|grq_|PRIVATE|https:|UNTRUSTED/);
  const reject=await f.tools.confirmationDetails('respond_group_request',{...args,approve:false,reason:'拒绝\n理由'},ctx);
  assert.match(reject,/拒绝入群申请/);assert.match(reject,/\\n/);assert.notEqual(a,reject);
  assert.ok(f.calls.every(x=>x!=='set_group_add_request'));
  assert.equal((await f.tools.execute('respond_group_request',args,ctx)).submitted,true);
  assert.equal(f.calls.filter(x=>x==='set_group_add_request').length,1);
  await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,ctx),{message:'request_already_submitted'});
});
test('request previews reject invalid provenance, role changes, processed and changed applicants',async()=>{
  const f=requests(),args=await f.args();f.calls.length=0;
  await assert.rejects(new GroupRequestTools(f.api,ctx.groupId).confirmationDetails('respond_group_request',args,ctx),{message:'tool_disabled'});
  await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,{...ctx,groupId:'999'}),{message:'forbidden_group'});
  await assert.rejects(f.tools.confirmationDetails('respond_group_request',{...args,request_handle:'grq_'+'0'.repeat(48)},ctx),{message:'invalid_request_handle'});
  let invoked=0;await assert.rejects(f.tools.confirmationDetails('respond_group_request',{...args,get approve(){invoked++;return true;}},ctx),{message:'invalid_arguments'});
  assert.equal(invoked,0);assert.deepEqual(f.calls,[]);
  f.state.role='member';await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,ctx),{message:'permission_denied'});
  f.state.role='admin';f.state.pending=false;await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,ctx),{message:'request_not_pending_or_changed'});
  f.state.pending=true;f.state.applicant=888;await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,ctx),{message:'request_not_pending_or_changed'});
  f.state.applicant=789;f.state.group=999;await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,ctx),{message:'request_not_pending_or_changed'});
  f.state.group=123;f.state.hook=action=>{if(action==='get_group_system_msg')f.state.role='member';};
  await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,ctx),{message:'permission_denied'});
  assert.ok(f.calls.every(x=>x!=='set_group_add_request'));
});
test('request previews recheck TTL and reset after native reads and redact upstream failures',async t=>{
  const now=Date.now();let clock=now;t.mock.method(Date,'now',()=>clock);
  const f=requests(),args=await f.args();
  f.state.hook=action=>{if(action==='get_group_system_msg')clock=now+16*60*1000;};
  await assert.rejects(f.tools.confirmationDetails('respond_group_request',args,ctx),{message:'invalid_request_handle'});
  clock=now;f.state.hook=undefined;const args2=await f.args();
  f.state.hook=action=>{if(action==='get_group_system_msg')f.tools.reset();};
  await assert.rejects(f.tools.confirmationDetails('respond_group_request',args2,ctx),{message:'capabilities_revoked'});
  f.state.hook=undefined;const args3=await f.args();
  f.state.hook=()=>{throw new Error('PRIVATE native flag token');};
  await assert.rejects(f.tools.confirmationDetails('respond_group_request',args3,ctx),{message:'verification_unavailable'});
  const aborted=new AbortController();aborted.abort();await assert.rejects(f.tools.confirmationDetails('respond_group_request',args3,ctx,aborted.signal),{message:'cancelled'});
  assert.ok(f.calls.every(x=>x!=='set_group_add_request'));
});
