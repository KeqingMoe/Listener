import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {createServer} from 'node:http';
import type {AddressInfo,Socket} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {WebSocketServer,type WebSocket} from 'ws';
import {LISTENER_GROUP,OWNER_ID} from '../src/contracts.js';
import {SQLiteMemory} from '../src/memory.js';
import {FACE_CATALOG} from '../src/face-catalog.js';

const GROUP=LISTENER_GROUP,SELF='99999';
const LITERAL='[QQ表情：吃瓜 id=271] [at:all] [CQ:at,qq=all]';
const REPLY_LITERAL=`原样文本：${LITERAL}`;
const IGNORED_NAME='ignored-model-face-name';
const face=(id:string)=>({type:'face',id,...(FACE_CATALOG.find(f=>f.id===id)?.name?{name:FACE_CATALOG.find(f=>f.id===id)!.name}:{})});
const firstSegments=[face('271'),{type:'text',text:LITERAL},{type:'at',user_id:SELF}];
const ownSegments=[face('0'),{type:'text',text:LITERAL}];
function event(messageId:string,first=false){return {post_type:'message',message_type:'group',group_id:GROUP,self_id:SELF,user_id:OWNER_ID,message_id:messageId,time:Math.floor(Date.now()/1000),sender:{user_id:OWNER_ID,nickname:'fixture owner'},message:first?[{type:'face',data:{id:'271'}},{type:'text',data:{text:LITERAL}},{type:'at',data:{qq:SELF}}]:[{type:'at',data:{qq:SELF}},{type:'text',data:{text:'再看一下第一条消息，原样引用文字标记'}}]};}
async function bounded<T>(promise:Promise<T>,ms=5000):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture timeout')),ms);})]);}finally{clearTimeout(timer);}}
function payload(body:any):any{const m=body.messages.find((m:any)=>m.role==='user');assert.ok(m);assert.equal(typeof m.content,'string');return JSON.parse(m.content);}
function timeline(body:any):any[]{const context=JSON.parse(payload(body).untrusted_group_context);return Array.isArray(context)?context:context.messages;}
function typed(entry:any,expected:unknown[]){assert.ok(entry);assert.equal(entry.representation,'segments');assert.equal(Object.hasOwn(entry,'text'),false);assert.deepEqual(entry.segments,expected);}

test('real entrypoint preserves native segments, literal marker text and structured SQL self-history',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'structured-entrypoint-')),changed=new EventEmitter();let failure:unknown,output='',child:ChildProcess|undefined,exit:Promise<{code:number|null;signal:NodeJS.Signals|null}>|undefined;
 const notify=()=>changed.emit('change'),fail=(error:unknown)=>{failure=error;notify();};
 const peers=new Set<WebSocket>(),sockets=new Set<Socket>();let peer:WebSocket|undefined,sent=0;
 const calls:Array<{action:string;params:Record<string,any>}>=[],requests:any[]=[];
 const op=(name:string,args:unknown)=>({id:`op_${requests.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const send=(segments:unknown[])=>op('send_message',{parts:[{segments}]});
 const http=createServer((req,res)=>{void(async()=>{
  let source='';for await(const chunk of req)source+=chunk.toString();const body=JSON.parse(source);requests.push(body);
  assert.equal(req.headers.authorization,'Bearer fixture-key');assert.equal(req.url,'/v1/chat/completions');assert.equal(body.model,'fixture-structured');
  const names=body.tools.map((t:any)=>t.function.name);assert.ok(names.includes('read_message'));assert.ok(!names.includes('get_group_members'));assert.ok(!names.includes('get_member_info'));assert.ok(!names.includes('react_message'));
  const history=timeline(body),legacy=history.find(m=>m.messageId==='98');assert.ok(legacy);assert.equal(legacy.representation,'legacy_text');assert.equal(legacy.text,LITERAL);assert.equal(legacy.segments,undefined,'legacy markers must never be guessed into native segments');
  let next:ReturnType<typeof op>;
  if(requests.length===1){
   assert.equal(sent,0);const input=payload(body);typed(input.current_batch.messages.find((m:any)=>m.messageId==='101'),firstSegments);typed(input.current_request,firstSegments);typed(history.find(m=>m.messageId==='101'),firstSegments);
   next=send([{type:'face',id:'0',name:IGNORED_NAME},{type:'text',text:LITERAL}]);
  }else{
   assert.equal(sent,1);typed(history.find(m=>m.messageId==='101'),firstSegments);typed(history.find(m=>m.messageId==='9001'),ownSegments);
   assert.ok(!JSON.stringify(history).includes(IGNORED_NAME),'untrusted output label must not replace catalog meaning in self-history');
   if(requests.length===2){assert.equal(payload(body).current_request.messageId,'102');next=op('read_message',{message_id:'101'});}
   else{
    assert.equal(requests.length,3);const result=JSON.parse(body.messages.filter((m:any)=>m.role==='tool').at(-1).content);assert.equal(result.status,'ok');assert.equal(result.message.messageId,'101');typed(result.message,firstSegments);
    next=send([{type:'text',text:REPLY_LITERAL}]);
   }
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[next]}}]}));notify();
 })().catch(error=>{fail(error);if(!res.headersSent)res.writeHead(500);res.end();});});
 http.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);notify();});});http.on('error',fail);
 const ws=new WebSocketServer({host:'127.0.0.1',port:0});ws.on('error',fail);ws.on('connection',(socket,req)=>{
  try{assert.equal(req.headers.authorization,'Bearer fixture-token');}catch(error){fail(error);}
  peer=socket;peers.add(socket);socket.once('close',()=>{peers.delete(socket);notify();});socket.on('error',fail);
  socket.on('message',raw=>{try{
   const call=JSON.parse(raw.toString());calls.push(call);let data:unknown;
   if(call.action==='get_login_info')data={user_id:SELF};
   else if(call.action==='send_group_msg'){
    assert.equal(call.params.group_id,GROUP);assert.ok(Array.isArray(call.params.message),'wire messages must not be serialized CQ strings');
    if(sent===0)assert.deepEqual(call.params.message,[{type:'face',data:{id:'0'}},{type:'text',data:{text:LITERAL}}]);
    else{assert.equal(sent,1);assert.deepEqual(call.params.message,[{type:'text',data:{text:REPLY_LITERAL}}]);}
    assert.ok(call.params.message.every((segment:any)=>segment.type!=='at'),'literal at/CQ text must not cause real mentions');
    assert.ok(!JSON.stringify(call.params).includes(IGNORED_NAME));data={message_id:String(9001+sent++)};
   }else throw Error(`unexpected API action: ${call.action}`);
   socket.send(JSON.stringify({status:'ok',retcode:0,echo:call.echo,data}));notify();
  }catch(error){fail(error);}});notify();
 });
 const wait=(predicate:()=>boolean,label:string):Promise<void>=>new Promise((resolve,reject)=>{
  let timer:NodeJS.Timeout|undefined;const finish=(error?:unknown)=>{clearTimeout(timer);changed.off('change',check);error?reject(error):resolve();};const check=()=>{if(failure){finish(failure);return;}try{if(predicate())finish();}catch(error){finish(error);}};changed.on('change',check);timer=setTimeout(()=>finish(Error(`${label}: ${output.slice(-3000)}`)),6000);check();
 });
 const ended=()=>[...output.matchAll(/\bturn\.end\b/g)].length;
 try{
  const listening=ws.address()?Promise.resolve():once(ws,'listening');http.listen(0,'127.0.0.1');await Promise.all([listening,once(http,'listening')]);const wsPort=(ws.address() as AddressInfo).port,httpPort=(http.address() as AddressInfo).port;
  mkdirSync(join(dir,'prompts'));mkdirSync(join(dir,'data'));writeFileSync(join(dir,'prompts/listener.md'),'Isolated typed-message fixture.');writeFileSync(join(dir,'.env'),'FIXTURE_TOKEN=fixture-token\nFIXTURE_KEY=fixture-key\n',{mode:0o600});
  const dbPath=join(dir,'data/listener.sqlite'),legacyEntry={messageId:'98',userId:'222',nickname:'legacy user',time:Math.floor(Date.now()/1000)-20,text:LITERAL};
  const initial=new SQLiteMemory({path:dbPath,groupId:GROUP,maxContextChars:24000,retentionDays:7});assert.equal(initial.append(legacyEntry),true);initial.close();
  const before=new DatabaseSync(dbPath,{readOnly:true});let legacyBytes:string;try{legacyBytes=before.prepare("SELECT entry FROM listener_messages WHERE message_id='98'").get()!.entry as string;}finally{before.close();}
  writeFileSync(join(dir,'config.toml'),`[onebot]\nurl="ws://127.0.0.1:${wsPort}"\ntoken_env="FIXTURE_TOKEN"\n[ai]\nenabled=true\nbase_url="http://127.0.0.1:${httpPort}/v1"\nmodel="fixture-structured"\napi_key_env="FIXTURE_KEY"\ntimeout_ms=10000\n[reply]\ndelay_ms=[100,100]\ncooldown_ms=1000\nrandom_probability=0\n[tools]\nreactions=false\nmembers=false\nmention=false\n[logging]\nlevel="debug"\nconsole=true\nfile=false\n[groups."${GROUP}"]\n`);
  child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('../src/index.ts',import.meta.url))],{cwd:dir,env:{PATH:process.env.PATH??'',HOME:dir,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});exit=new Promise((resolve,reject)=>{child!.once('error',error=>{fail(error);reject(error);});child!.once('close',(code,signal)=>{resolve({code,signal});notify();});});void exit.catch(()=>{});for(const stream of [child.stdout!,child.stderr!])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-128*1024);notify();});
  await wait(()=>output.includes('onebot.ready'),'startup');peer!.send(JSON.stringify(event('101',true)));await wait(()=>ended()===1,'first native/literal reply');assert.equal(sent,1);
  peer!.send(JSON.stringify(event('102')));await wait(()=>ended()===2,'local structured read and literal reply');assert.equal(sent,2);assert.equal(requests.length,3);
  assert.deepEqual(calls.map(c=>c.action),['get_login_info','send_group_msg','send_group_msg'],'local reads and literal mention text must not trigger member lookups or other RPCs');
  assert.ok(!output.includes(LITERAL));assert.ok(!output.includes(IGNORED_NAME));assert.equal(child.kill('SIGTERM'),true);assert.deepEqual(await bounded(exit),{code:0,signal:null});assert.ok(output.includes('app.stopped'));
  const db=new DatabaseSync(dbPath,{readOnly:true});try{
   const records=db.prepare('SELECT message_id,entry FROM listener_messages ORDER BY seq').all(),rows=records.map(r=>JSON.parse(r.entry as string));
   assert.deepEqual(rows.map(r=>r.messageId),['98','101','9001','102','9002']);assert.equal(rows.filter(r=>r.bot).length,2);assert.equal(records.find(r=>r.message_id==='98')!.entry,legacyBytes,'opening and projecting history must not migrate old rows');
   assert.deepEqual(rows.find(r=>r.messageId==='101').segments,firstSegments);assert.deepEqual(rows.find(r=>r.messageId==='9001').segments,ownSegments);assert.deepEqual(rows.find(r=>r.messageId==='9002').segments,[{type:'text',text:REPLY_LITERAL}]);
   assert.ok(!JSON.stringify(rows).includes(IGNORED_NAME));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listener_summary').get()!.n,0);
  }finally{db.close();}
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');try{if(exit)await bounded(exit);}catch{child.kill('SIGKILL');if(exit)await bounded(exit).catch(()=>{});}}
  for(const peer of peers)peer.terminate();for(const socket of sockets)socket.destroy();await Promise.all([bounded(new Promise<void>(resolve=>ws.close(()=>resolve()))).catch(()=>{}),bounded(new Promise<void>(resolve=>http.close(()=>resolve()))).catch(()=>{})]);rmSync(dir,{recursive:true,force:true});changed.removeAllListeners();
 }
});
