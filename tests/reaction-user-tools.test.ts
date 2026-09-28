import test from 'node:test';
import assert from 'node:assert/strict';
import {ReactionUserTools,GET_REACTION_USERS_TOOL,type ReactionUserTurn} from '../src/tools/reactions/users.js';
import type { Api } from '../src/contracts/onebot.js';
import type { JsonObject } from '../src/contracts/json.js';
import type { Memory, TimelineEntry } from '../src/contracts/messages.js';
const ctx={groupId:'22',actorId:'111',messageId:'1',selfId:'999'};
const q={message_id:'1',emoji_id:'476',emoji_type:'1',limit:20};
const entry:TimelineEntry={messageId:'1',userId:'111',nickname:'one',text:'private body',time:1};
const page=(ids:Array<string|number>=['100000001'],extra:JsonObject={}):JsonObject=>({result:0,errMsg:'SECRET_ERROR',emojiLikesList:ids.map(tinyId=>({tinyId,nickName:'Nickname',headUrl:'https://SECRET.invalid/avatar',private:'SECRET'})),cookie:'',isLastPage:true,isFirstPage:true,...extra});
function setup(responses:unknown[]=[page()],override?:(action:string,params:JsonObject)=>unknown|Promise<unknown>){
 const calls:Array<{action:string;params:JsonObject}>=[];let i=0;
 const rows=[structuredClone(entry)];
 const memory:Memory={recent:()=>rows,find:id=>rows.find(r=>r.messageId===id),context:()=>'',append:()=>false,compact:async()=>{},clear:()=>{},close:()=>{}};
 const api:Api={async call(action,params={}){calls.push({action,params});if(override){const value=await override(action,params);if(value!==undefined)return value;}if(action==='get_msg')return{message_type:'group',group_id:'22',message_id:params.message_id,sender:{user_id:'111'},user_id:111};if(action==='fetch_emoji_like')return responses[i++];throw Error('unexpected');}};
 const tools=new ReactionUserTools(api,memory,'22'),state=tools.createTurn();
 return {tools,state,calls,rows,memory,api,read:(args:unknown=q,signal?:AbortSignal)=>tools.read(args,ctx,state,signal)};
}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}

test('strict tool schema documents query-only membership and opaque cursors',()=>{
 const f=GET_REACTION_USERS_TOOL.function;assert.equal(f.name,'get_reaction_users');assert.equal(f.parameters.additionalProperties,false);
 assert.deepEqual(f.parameters.required,['message_id','emoji_id','emoji_type','limit']);assert.match(f.description,/昵称/);assert.match(f.description,/不可信/);assert.match(f.description,/不是指令/);
});
test('explicit positive limit is required and upstream pages do not silently fulfill a larger request',async()=>{
 for(const limit of [undefined,null,false,'20',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){const s=setup();assert.equal((await s.read({...q,limit})).error,'invalid_arguments');assert.equal(s.calls.length,0);}
 const s=setup([page(['1'],{cookie:'A',isLastPage:false}),page(['2','3'],{isFirstPage:false})]);
 const a=await s.read({...q,limit:1});assert.equal(a.requested,1);assert.equal(a.returned,1);assert.equal(a.truncated,false);assert.equal(s.calls[1]!.params.count,1);
 const b=await s.read({...q,limit:Number.MAX_SAFE_INTEGER,cursor:a.next_cursor});assert.equal(b.complete,true);assert.equal(b.requested,Number.MAX_SAFE_INTEGER);assert.equal(b.returned,2);assert.equal(b.truncated,false);assert.equal(s.calls[3]!.params.count,20);
 const more=setup([page(['1'],{cookie:'B',isLastPage:false})]);const r=await more.read({...q,limit:1000});assert.equal(r.truncated,true);assert.equal(r.reason,'upstream_page');assert.ok(r.next_cursor);assert.ok(Buffer.byteLength(JSON.stringify(r))<=24000);
});
test('limit participates in result caching while pagination query binding allows a changed count',async()=>{
 const s=setup([page(['1']),page(['1','2'])]);const a=await s.read({...q,limit:1});const b=await s.read({...q,limit:2});assert.equal(a.returned,1);assert.equal(b.returned,2);assert.equal(s.calls.length,4);assert.equal((await s.read({...q,limit:1})).duplicate,true);
});
test('verified native read has exact params and sanitized positive membership',async()=>{
 const s=setup();const r=await s.read({...q,user_id:'100000001'});
 assert.equal(r.status,'ok');assert.equal(r.complete,true);assert.equal(r.has_more,false);assert.equal(r.target_found,true);assert.equal(r.returned,1);assert.equal(r.seen_users,1);assert.equal(r.untrusted,true);
 assert.deepEqual(r.users,[{user_id:'100000001',nickname:'Nickname'}]);assert.ok(!JSON.stringify(r).includes('SECRET'));
 assert.deepEqual(s.calls,[{action:'get_msg',params:{message_id:'1'}},{action:'fetch_emoji_like',params:{message_id:'1',emojiId:'476',emojiType:'1',count:20,cookie:''}}]);
});
test('no catalog gate for canonical IDs, including zero, negatives only allowed for messages',async()=>{
 for(const emoji_id of ['0','999999','9007199254740991']){const s=setup();assert.equal((await s.read({...q,emoji_id})).status,'ok');}
 const s=setup();s.rows[0]!.messageId='-12';assert.equal((await s.read({...q,message_id:'-12'})).status,'ok');
});
test('strict arguments reject aliases, extra params and native cookies before any RPC',async()=>{
 const invalid:unknown[]=[null,[],{...q,group_id:'33'},{...q,cookie:'SECRET'},{...q,count:100}, {...q,emoji_type:1},{...q,emoji_type:'3'},{...q,user_id:111},{...q,user_id:'0'},{...q,user_id:'01'},{...q,user_id:'1'.repeat(33)},{...q,cursor:'native-cookie'}, {...q,cursor:undefined}, {...q,user_id:undefined}];
 for(const key of ['message_id','emoji_id'])for(const value of ['01','-0',' 1','1\n','1.0','1e2','9007199254740992',1,undefined])invalid.push({...q,[key]:value});
 invalid.push({...q,emoji_id:'-1'});
 for(const args of invalid){const s=setup();assert.equal((await s.read(args)).status,'error');assert.equal(s.calls.length,0);}
});
test('scope and opaque turn ownership reject before API calls',async()=>{
 const s=setup(),other=new ReactionUserTools(s.api,s.memory,'22');
 for(const token of [{reaction_user_turn:true},other.createTurn(),null] as ReactionUserTurn[])assert.equal((await s.tools.read(q,ctx,token)).error,'invalid_turn');
 assert.equal((await s.tools.read(q,{...ctx,groupId:'33'},s.state)).error,'forbidden_group');
 assert.equal((await s.read({...q,message_id:'55'})).error,'message_not_in_context');assert.equal(s.calls.length,0);
});
test('verified quoted target allowed without local sender, unproven IDs forbidden',async()=>{
 const s=setup();s.rows[0]!.replyTo='42';const r=await s.read({...q,message_id:'42'});assert.equal(r.complete,true);assert.equal(s.calls[0]!.params.message_id,'42');
});
test('foreign/private/mismatched peer and sender metadata never reaches native page call',async()=>{
 for(const change of [{group_id:'33'},{message_type:'private'},{message_id:'2'},{sender:{user_id:'112'}},{user_id:'112'},{sender:{user_id:0}},{message_id:'01'}]){
  const s=setup([],action=>action==='get_msg'?{message_type:'group',group_id:'22',message_id:'1',sender:{user_id:'111'},...change}:undefined);
  assert.equal((await s.read()).error,'verification_failed');assert.equal(s.calls.length,1);
 }
});
test('sender proof is captured before awaiting and mutation cannot replace authority',async()=>{
 const wait=deferred<unknown>();const s=setup([],action=>action==='get_msg'?wait.promise:undefined);const pending=s.read();await Promise.resolve();await Promise.resolve();s.rows[0]!.userId='222';
 wait.resolve({message_type:'group',group_id:'22',message_id:'1',sender:{user_id:'222'}});assert.equal((await pending).error,'verification_failed');assert.equal(s.calls.length,1);
});
test('initial results are immutable cached snapshots and parallel duplicate calls perform only one page',async()=>{
 const s=setup();const [a,b]=await Promise.all([s.read(),s.read()]);assert.equal(s.calls.length,2);assert.equal(b.duplicate,true);
 (a.users as JsonObject[])[0]!.nickname='changed';a.complete=false;const c=await s.read();assert.equal(c.complete,true);assert.equal((c.users as JsonObject[])[0]!.nickname,'Nickname');assert.equal(s.calls.length,2);
});
test('pagination verifies each page, keeps native cookie private and finds target cumulatively',async()=>{
 const s=setup([page(['1'],{cookie:'SECRET_COOKIE',isLastPage:false}),page(['2'],{isFirstPage:false})]);const args={...q,user_id:'1'};
 const a=await s.read(args);assert.equal(a.target_found,true);assert.equal(a.complete,false);assert.equal(a.has_more,true);assert.match(String(a.next_cursor),/^ru_[0-9a-f]{32}$/);assert.ok(!JSON.stringify(a).includes('SECRET'));
 const b=await s.read({...args,cursor:a.next_cursor});assert.equal(b.complete,true);assert.equal(b.target_found,true);assert.equal(b.seen_users,2);assert.deepEqual(b.users,[{user_id:'2',nickname:'Nickname'}]);
 assert.deepEqual(s.calls.map(c=>c.action),['get_msg','fetch_emoji_like','get_msg','fetch_emoji_like']);assert.equal(s.calls[3]!.params.cookie,'SECRET_COOKIE');
 const c=await s.read({...args,cursor:a.next_cursor});assert.equal(c.duplicate,true);assert.equal(s.calls.length,4);
});
test('target negative is unknown before final page and false only after clean final page',async()=>{
 const s=setup([page(['1'],{cookie:'next',isLastPage:false}),page(['2'],{isFirstPage:false})]);const args={...q,user_id:'9'};
 const a=await s.read(args);assert.equal(a.target_found,null);const b=await s.read({...args,cursor:a.next_cursor});assert.equal(b.target_found,false);assert.equal(b.complete,true);
 const empty=setup([page([])]);assert.equal((await empty.read(args)).target_found,false);
});
test('live-style pagination may end with an extra empty EOF page without tainting prior evidence',async()=>{
 for(const target of ['1','9']){
  const s=setup([page(['1'],{cookie:'101',isLastPage:false}),page(['2'],{cookie:'102',isFirstPage:false,isLastPage:false}),page([],{isFirstPage:false})]);
  const args={...q,user_id:target};let r=await s.read(args);r=await s.read({...args,cursor:r.next_cursor});r=await s.read({...args,cursor:r.next_cursor});
  assert.equal(r.status,'ok');assert.equal(r.complete,true);assert.equal(r.has_more,false);assert.equal(r.seen_users,2);assert.equal(r.returned,0);assert.deepEqual(r.users,[]);
  assert.equal(r.target_found,target==='1');assert.equal(r.next_cursor,undefined);assert.equal(s.calls.length,6);
 }
});

test('all query fields and target identity bind opaque cursors and other turns cannot reuse them',async()=>{
 const s=setup([page(['1'],{cookie:'next',isLastPage:false})]);const args={...q,user_id:'9'},a=await s.read(args),baseline=s.calls.length;
 for(const change of [{message_id:'2'},{emoji_id:'99'},{emoji_type:'2'},{user_id:'8'},{user_id:undefined}])assert.equal((await s.read({...args,cursor:a.next_cursor,...change})).status,'error');
 assert.equal((await s.read({...q,cursor:a.next_cursor})).error,'invalid_cursor');
 assert.equal((await s.tools.read({...args,cursor:a.next_cursor},ctx,s.tools.createTurn())).error,'invalid_cursor');
 assert.equal((await s.read({...args,cursor:`ru_${'0'.repeat(32)}`})).error,'invalid_cursor');assert.equal(s.calls.length,baseline);
});
test('each page rechecks the peer and will not reuse first-page verification',async()=>{
 let gets=0;const s=setup([page(['1'],{cookie:'next',isLastPage:false})],action=>{if(action==='get_msg'&&++gets===2)return{message_type:'group',group_id:'33',message_id:'1',sender:{user_id:'111'}};});
 const a=await s.read();assert.equal((await s.read({...q,cursor:a.next_cursor})).error,'verification_failed');assert.equal(s.calls.filter(c=>c.action==='fetch_emoji_like').length,1);
});
test('malformed rows and duplicate users taint all later pages and never prove absence',async()=>{
 const first=page([],{isLastPage:false,cookie:'next',emojiLikesList:[{tinyId:'1',nickName:'one'},{tinyId:'01'},null,{tinyId:'1'}]});
 const s=setup([first,page(['2'],{isFirstPage:false})]);const args={...q,user_id:'9'};const a=await s.read(args);assert.equal(a.status,'partial');assert.equal(a.omitted,3);assert.equal(a.returned,1);
 const b=await s.read({...args,cursor:a.next_cursor});assert.equal(b.target_found,null);assert.equal(b.complete,false);assert.equal(b.has_more,false);assert.equal(b.status,'partial');
});
test('cross-page duplicates are removed and prevent negative certainty',async()=>{
 const s=setup([page(['1'],{cookie:'next',isLastPage:false}),page(['1','2'],{isFirstPage:false})]);const args={...q,user_id:'9'},a=await s.read(args),b=await s.read({...args,cursor:a.next_cursor});
 assert.equal(b.returned,1);assert.equal(b.seen_users,2);assert.equal(b.target_found,null);assert.equal(b.complete,false);
});
test('overlong native pages expose at most20 and never certify a missing target',async()=>{
 const s=setup([page(Array.from({length:101},(_,i)=>String(i+1)))]);const r=await s.read({...q,user_id:'101'});assert.equal(r.returned,20);assert.equal(r.omitted,81);assert.equal(r.target_found,null);assert.equal(r.complete,false);
});
test('nicknames are bounded untrusted data and unsafe userIDs are omitted',async()=>{
 const s=setup([page([],{emojiLikesList:[{tinyId:123,nickName:'\n\u202E'+('a'.repeat(120)),headUrl:'SECRET'},{tinyId:Number.MAX_SAFE_INTEGER+1},{tinyId:'0'},{tinyId:'7'.repeat(33)}]})]);
 const r=await s.read();assert.deepEqual(r.users,[{user_id:'123',nickname:'a'.repeat(80)}]);assert.equal(r.omitted,3);assert.equal(r.untrusted,true);assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('nickname matches never establish identity or overwrite the requested target',async()=>{
 const s=setup([page([],{emojiLikesList:[{tinyId:'2',nickName:'100000001',user_id:'100000001',role:'owner'}]})]);
 const r=await s.read({...q,user_id:'100000001'});assert.equal(r.target_found,false);assert.equal(r.target_user_id,'100000001');
 assert.deepEqual(r.users,[{user_id:'2',nickname:'100000001'}]);assert.ok(!JSON.stringify(r).includes('role'));
});

test('missing or inconsistent pagination flags never claim a complete empty page',async()=>{
 for(const fields of [{isLastPage:undefined},{isLastPage:'true'},{isFirstPage:undefined},{isFirstPage:false}]){const s=setup([page([] ,fields)]);const r=await s.read({...q,user_id:'9'});assert.equal(r.status,'partial');assert.equal(r.complete,false);assert.equal(r.target_found,null);assert.equal(r.next_cursor,undefined);}
});
test('unavailable, empty-more and malicious cookies stop without exposing transport state',async()=>{
 for(const fields of [{cookie:''},{cookie:undefined},{cookie:'a\nb'},{cookie:'a'.repeat(4097)},{cookie:'😀'.repeat(1025)},{cookie:'next',emojiLikesList:[]}]){
  const s=setup([page(['1'],{isLastPage:false,...fields})]);const r=await s.read({...q,user_id:'9'});assert.equal(r.status,'partial');assert.equal(r.target_found,null);assert.equal(r.has_more,true);assert.equal(r.next_cursor,undefined);assert.equal(r.reason,'pagination_unavailable');
 }
});
test('repeated and cyclic native cookies stop paging without retry or false absence',async()=>{
 for(const cookies of [['A','A'],['A','B','A']]){
  const s=setup(cookies.map((cookie,i)=>page([String(i+1)],{cookie,isLastPage:false,isFirstPage:i===0})));let cursor:unknown;
  for(let i=0;i<cookies.length;i++){const r=await s.read({...q,user_id:'9',...(cursor?{cursor}:{})});cursor=r.next_cursor;if(i===cookies.length-1){assert.equal(r.reason,'pagination_cycle');assert.equal(r.target_found,null);assert.equal(cursor,undefined);}}
 }
});
test('terminal native cookie is never exposed and does not fabricate another page',async()=>{
 const s=setup([page(['1'],{cookie:'SECRET_FINAL_COOKIE'})]);const r=await s.read();assert.equal(r.complete,true);assert.equal(r.has_more,false);assert.equal(r.next_cursor,undefined);assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('more than eight pages continue until native EOF without a local call quota',async()=>{
 const pages=Array.from({length:12},(_,i)=>page([String(i+1)],{cookie:`page${i}`,isLastPage:i===11,isFirstPage:i===0}));
 const s=setup(pages);let cursor:unknown,r:JsonObject={};
 for(let i=0;i<12;i++){r=await s.read({...q,user_id:'99',...(cursor?{cursor}:{})});cursor=r.next_cursor;assert.equal(r.status,'ok'===r.status?'ok':'partial');}
 assert.equal(s.calls.length,24);assert.equal(r.complete,true);assert.equal(r.has_more,false);assert.equal(r.target_found,false);assert.equal(cursor,undefined);
});
test('mixed queries serialize many native page calls without sharing a local call quota',async()=>{
 let active=0,peak=0;const s=setup(Array.from({length:12},()=>page()),async action=>{if(action==='fetch_emoji_like'){active++;peak=Math.max(peak,active);await Promise.resolve();active--;}});
 const results=await Promise.all(Array.from({length:12},(_,i)=>s.read({...q,emoji_id:String(i)})));assert.equal(peak,1);assert.equal(s.calls.length,24);assert.equal(results.filter(r=>r.error==='call_limit').length,0);
});
test('strict native success code and required list, errors never leak or retry',async()=>{
 for(const response of [null,{}, {result:0},page([],{result:true}),page([],{result:1}),page([],{result:'0'}),page([],{result:undefined})]){
  const s=setup([response]);const r=await s.read({...q,user_id:'9'});assert.equal(r.error,'reaction_users_unavailable');assert.notEqual(r.target_found,false);const again=await s.read({...q,user_id:'9'});assert.equal(again.duplicate,true);assert.equal(s.calls.length,2);assert.ok(!JSON.stringify(r).includes('SECRET'));
 }
 for(const failure of ['get_msg','fetch_emoji_like']){const s=setup([],action=>{if(action===failure)throw Error('SECRET provider body');});const r=await s.read();assert.equal(r.error,'reaction_users_unavailable');await s.read();assert.equal(s.calls.length,failure==='get_msg'?1:2);assert.ok(!JSON.stringify(r).includes('SECRET'));}
});
test('later page errors preserve a previously seen positive target without claiming complete absence',async()=>{
 const s=setup([page(['1'],{cookie:'next',isLastPage:false}),{result:123,errMsg:'SECRET'}]);
 const args={...q,user_id:'1'},a=await s.read(args),b=await s.read({...args,cursor:a.next_cursor});
 assert.equal(b.status,'error');assert.equal(b.target_found,true);assert.equal(b.seen_users,1);assert.equal(b.complete,false);assert.equal(b.has_more,null);
 assert.ok(!JSON.stringify(b).includes('SECRET'));
});

test('abort before read does not consume budget or call APIs',async()=>{
 const s=setup(),controller=new AbortController();controller.abort();assert.equal((await s.read(q,controller.signal)).error,'cancelled');assert.equal(s.calls.length,0);assert.equal((await s.read()).status,'ok');
});
test('abort during peer verification prevents page fetch',async()=>{
 const wait=deferred<unknown>(),controller=new AbortController();const s=setup([],action=>action==='get_msg'?wait.promise:undefined);const task=s.read(q,controller.signal);await Promise.resolve();await Promise.resolve();controller.abort();wait.resolve({message_type:'group',group_id:'22',message_id:'1',sender:{user_id:'111'}});
 assert.equal((await task).error,'cancelled');assert.equal(s.calls.length,1);
});
test('abort during page fetch commits neither cached membership nor late cursor',async()=>{
 const reached=deferred<void>(),wait=deferred<unknown>(),controller=new AbortController();let hold=true;
 const s=setup([page(['2'])],action=>{if(action==='fetch_emoji_like'&&hold){reached.resolve();return wait.promise;}});
 const task=s.read({...q,user_id:'1'},controller.signal);await reached.promise;controller.abort();wait.resolve(page(['1'],{isLastPage:false,cookie:'SECRET'}));const cancelled=await task;assert.equal(cancelled.error,'cancelled');assert.equal(cancelled.next_cursor,undefined);
 hold=false;const fresh=await s.read({...q,user_id:'1'});assert.equal(fresh.duplicate,undefined);assert.equal(fresh.target_found,false);assert.equal(fresh.seen_users,1);
});
test('dispatched mutation invalidates a cached negative and allows a fresh positive query',async()=>{
 const s=setup([page([]),page(['1'])]),args={...q,user_id:'1'};
 assert.equal((await s.read(args)).target_found,false);s.tools.invalidate(s.state,'1','476');
 const fresh=await s.read(args);assert.equal(fresh.target_found,true);assert.equal(fresh.duplicate,undefined);assert.equal(s.calls.length,4);
});

test('invalidation revokes all type and target views but preserves unrelated cursors',async()=>{
 const s=setup([page(['1'],{isLastPage:false,cookie:'A'}),page(['2'],{isLastPage:false,cookie:'B'}),page(['3'],{isLastPage:false,cookie:'C'}),page(['4'],{isFirstPage:false})]);
 const a={...q,user_id:'1'},b={...q,emoji_type:'2',user_id:'2'},c={...q,emoji_id:'99'};
 const ra=await s.read(a),rb=await s.read(b),rc=await s.read(c);s.tools.invalidate(s.state,'1','476');
 assert.equal((await s.read({...a,cursor:ra.next_cursor})).error,'invalid_cursor');assert.equal((await s.read({...b,cursor:rb.next_cursor})).error,'invalid_cursor');assert.equal(s.calls.length,6);
 const unrelated=await s.read({...c,cursor:rc.next_cursor});assert.equal(unrelated.complete,true);assert.equal(unrelated.seen_users,2);assert.equal(s.calls.length,8);
});

test('only owned canonical invalidations can affect cache and never reset page budget',async()=>{
 const s=setup(Array.from({length:9},()=>page()));const other=new ReactionUserTools(s.api,s.memory,'22');await s.read();
 s.tools.invalidate(other.createTurn(),'1','476');s.tools.invalidate({reaction_user_turn:true},'1','476');
 for(const [message,emoji] of [['01','476'],['1','-1'],['1','01'],['1','9007199254740992']])s.tools.invalidate(s.state,message!,emoji!);
 assert.equal((await s.read()).duplicate,true);assert.equal(s.calls.length,2);
 for(let i=0;i<7;i++)await s.read({...q,emoji_id:String(i)});
 s.tools.invalidate(s.state,'1','476');assert.equal((await s.read()).status,'ok');assert.equal(s.calls.length,18);
});

test('invalidation during peer verification prevents page fetch and late result caching',async()=>{
 const wait=deferred<unknown>(),reached=deferred<void>();let hold=true;
 const s=setup([page(['1'])],action=>{if(action==='get_msg'&&hold){reached.resolve();return wait.promise;}});
 const task=s.read();await reached.promise;s.tools.invalidate(s.state,'1','476');wait.resolve({message_type:'group',group_id:'22',message_id:'1',sender:{user_id:'111'}});
 assert.equal((await task).error,'query_invalidated');assert.equal(s.calls.length,1);hold=false;
 const fresh=await s.read();assert.equal(fresh.duplicate,undefined);assert.equal(fresh.status,'ok');assert.equal(s.calls.length,3);
});

test('invalidation during native page fetch discards late users and cursor creation',async()=>{
 const wait=deferred<unknown>(),reached=deferred<void>();let hold=true;
 const s=setup([page([])],action=>{if(action==='fetch_emoji_like'&&hold){reached.resolve();return wait.promise;}});
 const task=s.read({...q,user_id:'1'});await reached.promise;s.tools.invalidate(s.state,'1','476');wait.resolve(page(['1'],{cookie:'SECRET_LATE',isLastPage:false}));
 const invalid=await task;assert.equal(invalid.error,'query_invalidated');assert.equal(invalid.next_cursor,undefined);assert.equal(invalid.target_found,undefined);assert.ok(!JSON.stringify(invalid).includes('SECRET'));
 hold=false;const fresh=await s.read({...q,user_id:'1'});assert.equal(fresh.target_found,false);assert.equal(fresh.seen_users,0);assert.equal(fresh.duplicate,undefined);
});

test('revision overflow conservatively invalidates every cache and cursor without resetting budget',async()=>{
 const s=setup([page(['1'],{cookie:'A',isLastPage:false}),page(['2'])]);const a=await s.read();
 for(let i=0;i<4097;i++)s.tools.invalidate(s.state,'1',String(1000+i));
 assert.equal((await s.read({...q,cursor:a.next_cursor})).error,'invalid_cursor');const fresh=await s.read();assert.equal(fresh.duplicate,undefined);assert.deepEqual(fresh.users,[{user_id:'2',nickname:'Nickname'}]);
});

test('overflow epoch prevents an unrelated old pending request from committing',async()=>{
 const wait=deferred<unknown>(),reached=deferred<void>();const s=setup([],action=>{if(action==='fetch_emoji_like'){reached.resolve();return wait.promise;}});
 const task=s.read();await reached.promise;for(let i=0;i<4097;i++)s.tools.invalidate(s.state,'1',String(1000+i));
 wait.resolve(page(['1'],{cookie:'SECRET',isLastPage:false}));assert.equal((await task).error,'query_invalidated');
});

test('queued aborted call cannot perform RPC after an earlier operation settles',async()=>{
 const wait=deferred<unknown>(),reached=deferred<void>();let first=true;
 const s=setup([],action=>{if(action==='get_msg'&&first){first=false;reached.resolve();return wait.promise;}if(action==='fetch_emoji_like')return page();});const a=s.read();await reached.promise;const controller=new AbortController();const b=s.read({...q,emoji_id:'99'},controller.signal);controller.abort();wait.resolve({message_type:'group',group_id:'22',message_id:'1',sender:{user_id:'111'}});await a;assert.equal((await b).error,'cancelled');assert.equal(s.calls.length,2);
});
