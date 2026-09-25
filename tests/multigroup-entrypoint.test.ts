import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
import { LISTENER_GROUP } from '../src/contracts.js';

const A=LISTENER_GROUP,B='22',SELF='99999';
function event(group:string,id:string,text:string,direct=true){return {post_type:'message',message_type:'group',group_id:group,user_id:'12345',self_id:SELF,message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'fixture-user'},message:[...(direct?[{type:'at',data:{qq:SELF}}]:[]),{type:'text',data:{text}}]};}
async function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{
 let timer:NodeJS.Timeout|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture operation timed out')),ms);})]);}
 finally{clearTimeout(timer);}
}

test('actual entrypoint shares local transports, isolates two group databases, and shuts down active/queued turns', {timeout:30000}, async()=>{
 const dir=mkdtempSync(join(tmpdir(),'listener-multigroup-entrypoint-'));
 const changed=new EventEmitter();let failure:unknown;let output='';let child:ChildProcess|undefined;
 let childExited:Promise<{code:number|null;signal:NodeJS.Signals|null}>|undefined;
 const notify=()=>changed.emit('change');const fail=(error:unknown)=>{failure=error;notify();};
 const sockets=new Set<Socket>(),peers=new Set<WebSocket>();let connectionCount=0;let peer:WebSocket|undefined;
 const calls:Array<{action:string;params:Record<string,unknown>}>=[];
 const requests:Array<{group:string;body:any}>=[];let holdModel=false;let held:ServerResponse|undefined;let heldCancelled=false;
 const http=createServer((req,res)=>{void(async()=>{
  assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer fixture-model-key');
  let bodyText='';for await(const chunk of req){bodyText+=chunk.toString();assert.ok(bodyText.length<1024*1024);}
  const body=JSON.parse(bodyText);assert.equal(body.model,'fixture-model');
  const group=/本轮只服务群 (\d+)/.exec(body.messages[0].content)?.[1];assert.ok(group===A||group===B);
  requests.push({group,body});
  if(holdModel){held=res;res.once('close',()=>{heldCancelled=!res.writableEnded;notify();});notify();return;}
  const args={parts:[{segments:group===A?[{type:'face',id:'20'}]:[{type:'text',text:'reply-only-B'}]}]};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:`fixture_${requests.length}`,type:'function',function:{name:'send_message',arguments:JSON.stringify(args)}}]}}]}));notify();
 })().catch(error=>{fail(error);if(!res.headersSent)res.writeHead(500);res.end();});});
 http.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);notify();});});http.on('error',fail);
 const ws=new WebSocketServer({host:'127.0.0.1',port:0});ws.on('error',fail);
 ws.on('connection',(socket,request)=>{
  connectionCount++;peer=socket;peers.add(socket);socket.once('close',()=>{peers.delete(socket);notify();});socket.on('error',fail);
  try{assert.equal(request.headers.authorization,'Bearer fixture-onebot-token');}catch(error){fail(error);}
  socket.on('message',raw=>{try{
   const call=JSON.parse(raw.toString());calls.push(call);let data:unknown;
   if(call.action==='get_login_info')data={user_id:SELF,nickname:'Listener fixture'};
   else{assert.equal(call.action,'send_group_msg');assert.ok(call.params.group_id===A||call.params.group_id===B);data={message_id:String(80000+calls.length)};}
   socket.send(JSON.stringify({status:'ok',retcode:0,data,echo:call.echo}));notify();
  }catch(error){fail(error);}});notify();
 });
 const wait=(predicate:()=>boolean,label:string,timeout=8000):Promise<void>=>new Promise((resolve,reject)=>{
  let timer:NodeJS.Timeout|undefined;
  const finish=(error?:unknown)=>{clearTimeout(timer);changed.off('change',check);error?reject(error):resolve();};
  const check=()=>{if(failure){finish(failure);return;}try{if(predicate())finish();}catch(error){finish(error);}};
  changed.on('change',check);timer=setTimeout(()=>finish(Error(`${label} timed out; child log tail: ${output.slice(-5000)}`)),timeout);check();
 });
 const sends=()=>calls.filter(call=>call.action==='send_group_msg');
 const queuedB=()=>[...output.matchAll(new RegExp(`trigger\\.queued[^\\n]*group_id="${B}"`,'g'))].length;
 try{
  const wsListening=ws.address()?Promise.resolve():once(ws,'listening');
  http.listen(0,'127.0.0.1');await Promise.all([once(http,'listening'),wsListening]);
  const httpPort=(http.address() as AddressInfo).port,wsPort=(ws.address() as AddressInfo).port;
  mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'You are Listener in a local integration fixture.');
  writeFileSync(join(dir,'config.toml'),`[onebot]\nurl="ws://127.0.0.1:${wsPort}"\ntoken_env="FIXTURE_ONEBOT_TOKEN"\n[ai]\nenabled=true\nbase_url="http://127.0.0.1:${httpPort}/v1"\nmodel="fixture-model"\napi_key_env="FIXTURE_MODEL_KEY"\ntimeout_ms=10000\nmax_concurrent_turns=1\n[reply]\ndelay_ms=[100,100]\ncooldown_ms=1000\nrandom_probability=0\n[logging]\nlevel="debug"\nconsole=true\nfile=false\n[groups."${A}"]\n[groups."${B}"]\n`);
  child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('../src/index.ts',import.meta.url))],{
   cwd:dir,env:{PATH:process.env.PATH??'',HOME:dir,NODE_NO_WARNINGS:'1',FIXTURE_ONEBOT_TOKEN:'fixture-onebot-token',FIXTURE_MODEL_KEY:'fixture-model-key'},stdio:['ignore','pipe','pipe'],
  });
  childExited=new Promise((resolve,reject)=>{child!.once('error',error=>{fail(error);reject(error);});child!.once('close',(code,signal)=>{resolve({code,signal});notify();});});
  // Attach a handler immediately so early spawn failures never become unhandled rejections.
  void childExited.catch(()=>{});
  for(const stream of [child.stdout!,child.stderr!])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-128*1024);notify();});
  await wait(()=>output.includes('onebot.ready'),'entrypoint ready');assert.ok(peer);
  // Ignored traffic precedes valid events on the same ordered transport.
  peer.send(JSON.stringify(event('77','91','unlisted-fixture-body')));
  peer.send(JSON.stringify({...event(A,'92','private-fixture-body'),message_type:'private'}));
  peer.send(JSON.stringify(event(A,'1','only-A-fixture-body')));peer.send(JSON.stringify(event(B,'1','only-B-fixture-body')));
  await wait(()=>sends().length===2&&requests.length===2&&output.split('turn.end').length>=3,'both groups replied');
  assert.equal(connectionCount,1);assert.equal(calls.filter(c=>c.action==='get_login_info').length,1);
  assert.deepEqual(new Set(sends().map(call=>call.params.group_id)),new Set([A,B]));
  assert.deepEqual(sends().find(c=>c.params.group_id===A)!.params.message,[{type:'face',data:{id:'20'}}]);
  assert.deepEqual(sends().find(c=>c.params.group_id===B)!.params.message,[{type:'text',data:{text:'reply-only-B'}}]);
  for(const request of requests){const all=JSON.stringify(request.body.messages);assert.ok(all.includes(request.group===A?'only-A-fixture-body':'only-B-fixture-body'));
   assert.ok(!all.includes(request.group===A?'only-B-fixture-body':'only-A-fixture-body'));assert.ok(!all.includes('unlisted-fixture-body'));assert.ok(!all.includes('private-fixture-body'));}
  peer.send(JSON.stringify(event(B,'2','/ping',false)));
  await wait(()=>sends().length===3,'group B ping');assert.equal(sends()[2]!.params.group_id,B);
  assert.deepEqual(sends()[2]!.params.message,[{type:'text',data:{text:'pong'}}]);assert.equal(requests.length,2);
  // A holds the sole global permit while B reaches its admission queue.
  holdModel=true;peer.send(JSON.stringify(event(A,'3','hold-A-model')));
  await wait(()=>!!held&&requests.length===3,'active model request');assert.equal(requests[2]!.group,A);
  const previouslyQueued=queuedB();peer.send(JSON.stringify(event(B,'3','queued-B-turn')));
  await wait(()=>queuedB()>previouslyQueued,'group B admission queue');assert.equal(requests.length,3);
  assert.equal(child.kill('SIGTERM'),true);const exit=await bounded(childExited,5000);
  assert.deepEqual(exit,{code:0,signal:null});assert.ok(output.includes('app.stopped'));
  await wait(()=>heldCancelled&&peers.size===0&&sockets.size===0,'all child network resources closed');
  assert.equal(connectionCount,1);assert.equal(requests.length,3);assert.equal(sends().length,3);
  const paths=[[A,join(dir,'data/listener.sqlite')],[B,join(dir,'data/groups/22/listener.sqlite')]] as const;
  for(const [group,path]of paths){
   const db=new DatabaseSync(path,{readOnly:true});try{
    assert.equal(db.prepare('SELECT group_id FROM listener_identity WHERE singleton=1').get()!.group_id,group);
    const entries=db.prepare('SELECT entry FROM listener_messages ORDER BY seq').all().map(row=>JSON.parse(row.entry as string));
    assert.equal(entries.filter(entry=>entry.messageId==='1').length,1);assert.ok(entries.find(entry=>entry.messageId==='1').text.includes(group===A?'only-A-fixture-body':'only-B-fixture-body'));
    const text=JSON.stringify(entries);assert.ok(!text.includes(group===A?'only-B-fixture-body':'only-A-fixture-body'));assert.ok(!text.includes('private-fixture-body'));assert.ok(!text.includes('unlisted-fixture-body'));
    assert.ok(entries.some(entry=>entry.messageId==='3'));assert.equal(entries.filter(entry=>entry.bot).length,group===A?1:2);
    if(group===A)assert.ok(text.includes('偷笑'));else assert.ok(text.includes('pong'));
   }finally{db.close();}
  }
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM');try{if(childExited)await bounded(childExited,3000);}catch{child.kill('SIGKILL');if(childExited)await bounded(childExited,3000).catch(()=>{});}
  }
  held?.destroy();for(const socket of peers)socket.terminate();for(const socket of sockets)socket.destroy();
  await Promise.all([bounded(new Promise<void>(resolve=>ws.close(()=>resolve())),3000).catch(()=>{}),bounded(new Promise<void>(resolve=>http.close(()=>resolve())),3000).catch(()=>{})]);
  rmSync(dir,{recursive:true,force:true});changed.removeAllListeners();
 }
});
