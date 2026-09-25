import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Listener} from '../src/listener.js';
import {ModelError} from '../src/model.js';
import {OneBotError} from '../src/client.js';
import {configureLogging,managedLogFilename} from '../src/logger.js';
import {LISTENER_GROUP,OWNER_ID,type TimelineEntry,type Memory,type Model,type Completion,type Api} from '../src/contracts.js';
import type {ListenerConfig} from '../src/listener-config.js';
const secret='NEVER_LOG_CHAT_BODY_OR_ARGUMENTS';
const self='999';
const cfg:ListenerConfig={enabled:true,baseUrl:'https://example.test',apiKey:'key',model:'model',timeoutMs:1000,maxTokens:100,debounceMs:5,cooldownMs:0,memoryPath:':memory:',maxContextChars:8000,retentionDays:7,randomReplyProbability:0};
const completion=(name:string,args:unknown={}):Completion=>({content:null,tool_calls:[{id:'call',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const event=(messageId:string,actor='123',text=secret,mention=true)=>({post_type:'message',message_type:'group',group_id:LISTENER_GROUP,self_id:self,user_id:actor,message_id:messageId,time:Math.floor(Date.now()/1000),sender:{nickname:secret},message:[...(mention?[{type:'at',data:{qq:self}}]:[]),{type:'text',data:{text}}]});
async function until(predicate:()=>boolean){for(let n=0;n<200;n++){if(predicate())return;await delay(5);}throw Error('Test timed out');}
function setup(respond:(n:number,signal?:AbortSignal)=>Promise<Completion>|Completion,sendFail=false,options:Partial<ListenerConfig>={}){
 const directory=mkdtempSync(join(tmpdir(),'listener-trace-'));
 const logger=configureLogging({level:'debug',console:false,file:true,directory,retentionDays:7,maxFileMb:1,maxTotalMb:2},['configured-key']);
 const entries:TimelineEntry[]=[];let requests=0;
 const memory:Memory={append(e){if(entries.some(x=>x.messageId===e.messageId))return false;entries.push(e);return true;},recent:()=>entries,find:id=>entries.find(e=>e.messageId===id),context:()=>JSON.stringify(entries),async compact(){},clear(){entries.length=0;},close(){}};
 const api:Api={async call(action){if(action==='send_group_msg'){if(sendFail)throw new OneBotError('timeout');return{message_id:'1000'};}throw Error(secret);}};
 const model:Model={async complete(_messages,_tools,signal){return respond(++requests,signal);}};
 const bot=new Listener(api,model,memory,{...cfg,...options});
 return {bot,entries,get requests(){return requests;},async records(){await logger.flush();return readdirSync(directory).filter(managedLogFilename).flatMap(name=>readFileSync(join(directory,name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));},async close(){await bot.stop();await logger.close();rmSync(directory,{recursive:true,force:true});}};
}
test('reply trace correlates trigger/model tool/send/end without text or arguments',async()=>{
 const s=setup(()=>completion('send_message',{parts:[{text:secret}]}));
 try{await s.bot.receive(event('1'),self);await until(()=>s.entries.some(e=>e.bot));const rows=await s.records();const start=rows.find(x=>x.event==='turn.start');assert.match(start.turn_id,/^t_[a-f0-9]{16}$/);for(const name of ['trigger.accepted','tool.start','tool.complete','send.start','send.complete','turn.end'])assert.ok(rows.some(x=>x.event===name&&x.turn_id===start.turn_id),name);assert.equal(rows.find(x=>x.event==='turn.end').outcome,'replied');assert.equal(rows.find(x=>x.event==='turn.end').sent_parts,1);assert.ok(!JSON.stringify(rows).includes(secret));}finally{await s.close();}
});
test('silent, prose suppressed, model failure and tool round limit are distinct outcomes',async()=>{
 for(const [respond,outcome,reason] of [
 [()=>completion('stay_silent'),'silent',undefined],
 [()=>({content:secret,tool_calls:[]}), 'prose_suppressed',undefined],
 [()=>{throw new ModelError('http_error',503);},'model_failed','http_error'],
 [()=>completion('invented_secret_tool',{body:secret}),'round_limit',undefined],
 ] as const){const s=setup(respond);try{await s.bot.receive(event('1'),self);await until(()=>s.requests>0&&!(s.bot as any).running);const rows=await s.records();const end=rows.find(x=>x.event==='turn.end');assert.equal(end.outcome,outcome);assert.equal(end.reason,reason);assert.ok(!JSON.stringify(rows).includes(secret));assert.ok(!JSON.stringify(rows).includes('invented_secret_tool'));}finally{await s.close();}}
});
test('uncertain send records delivery_unknown and never retries',async()=>{
 const s=setup(()=>completion('send_message',{parts:[{text:secret}]}),true);
 try{await s.bot.receive(event('1'),self);await until(()=>s.requests>0&&!(s.bot as any).running);const rows=await s.records();assert.equal(rows.filter(x=>x.event==='send.start').length,1);assert.equal(rows.find(x=>x.event==='send.failed').reason,'timeout');assert.equal(rows.find(x=>x.event==='turn.end').outcome,'delivery_unknown');assert.equal(rows.find(x=>x.event==='turn.end').sent_parts,0);}finally{await s.close();}
});
test('new direct message waits for active reply and receives a distinct next-batch trace',async()=>{
 let resolveFirst!:(value:Completion)=>void;
 const s=setup(n=>n===1?new Promise(resolve=>{resolveFirst=resolve;}):completion('stay_silent'));
 try{await s.bot.receive(event('1'),self);await until(()=>s.requests===1);await s.bot.receive(event('2'),self);resolveFirst(completion('send_message',{parts:[{text:secret}]}));await until(()=>s.requests===2&&!(s.bot as any).running);const rows=await s.records();const ends=rows.filter(x=>x.event==='turn.end');assert.equal(ends.length,2);assert.equal(ends[0].outcome,'replied');assert.equal(ends[0].reason,undefined);assert.equal(ends[1].outcome,'silent');assert.notEqual(ends[0].turn_id,ends[1].turn_id);assert.equal(rows.filter(x=>x.event==='send.start').length,1);assert.equal(rows.find(x=>x.event==='send.start').turn_id,ends[0].turn_id);assert.ok(rows.findIndex(x=>x.event==='turn.end'&&x.turn_id===ends[0].turn_id)<rows.findIndex(x=>x.event==='turn.start'&&x.turn_id===ends[1].turn_id));assert.ok(!JSON.stringify(rows).includes(secret));}finally{await s.close();}
});
test('pending merge is visible; debug skip and command identity contain no command body',async()=>{
 const s=setup(()=>completion('stay_silent'),false,{debounceMs:30});
 try{await s.bot.receive(event('1'),self);await s.bot.receive(event('2'),self);await until(()=>s.requests===1&&!(s.bot as any).running);await s.bot.receive(event('3','123',secret,false),self);await s.bot.receive(event('4',OWNER_ID,'/confirm '+ 'a'.repeat(32)),self);const rows=await s.records();assert.ok(rows.some(x=>x.event==='trigger.merged'));assert.ok(!rows.some(x=>x.event==='trigger.dropped'));assert.equal(rows.filter(x=>x.event==='trigger.accepted').length,1);assert.equal(rows.find(x=>x.event==='trigger.merged').turn_id,rows.find(x=>x.event==='trigger.accepted').turn_id);assert.ok(rows.some(x=>x.event==='trigger.skipped'&&x.reason==='random_not_selected'));assert.ok(rows.some(x=>x.event==='command.start'&&/^c_[a-f0-9]{16}$/.test(x.command_id)));assert.ok(!JSON.stringify(rows).includes('a'.repeat(32)));}finally{await s.close();}
});
