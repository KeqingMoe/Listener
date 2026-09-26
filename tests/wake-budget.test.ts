import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../src/listener.js';
import type { ListenerConfig } from '../src/listener-config.js';
import { LISTENER_GROUP, type Api, type ChatMessage, type Completion, type Memory, type Model, type TimelineEntry } from '../src/contracts.js';
const self='900000001';
const cfg:ListenerConfig={enabled:true,baseUrl:'https://example.invalid',apiKey:'x',model:'x',timeoutMs:5000,maxTokens:64,debounceMs:1,delayMaxMs:1,cooldownMs:1,memoryPath:':memory:',maxContextChars:8000,retentionDays:7,randomReplyProbability:1,randomCooldownMs:0,randomMaxPerMinute:10,maxToolCallsPerWake:96,wakeTimeoutMs:90000};
class Mem implements Memory{rows:TimelineEntry[]=[];append(e:TimelineEntry){this.rows.push(e);return true;}recent(){return this.rows;}find(id:string){return this.rows.find(e=>e.messageId===id);}context(){return JSON.stringify(this.rows);}async compact(){}clear(){this.rows=[];}close(){}}
const event=(id='1')=>({post_type:'message',message_type:'group',group_id:LISTENER_GROUP,self_id:self,user_id:'123',message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'x'},message:[{type:'text',data:{text:'hello'}}]});
const call=(name:string,args:unknown={})=>({id:`${name}-${Math.random()}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
function setup(complete:(round:number,messages:ChatMessage[])=>Completion|Promise<Completion>,overrides:Partial<ListenerConfig>={}){const requests:ChatMessage[][]=[];const calls:string[]=[];const api:Api={async call(action){calls.push(action);if(action==='send_group_msg')return{message_id:String(calls.length)};return{};}};const memory=new Mem();const model:Model={async complete(messages){requests.push(structuredClone(messages));return complete(requests.length-1,messages);}};const bot=new Listener(api,model,memory,{...cfg,...overrides},()=>0);return{bot,requests,calls};}
async function settle(s:ReturnType<typeof setup>){for(let i=0;i<1500;i++){if(!(s.bot as any).running&&s.requests.length)return;await delay(2);}assert.fail('wake did not settle');}

test('constructor rejects unsafe unified wake budgets',()=>{for(const key of ['maxToolCallsPerWake','wakeTimeoutMs'] as const)for(const value of [0,-1,1.5,NaN,Infinity,600001,true,'96',null])assert.throws(()=>new Listener({call:async()=>null},undefined,undefined,{...cfg,[key]:value} as any));assert.doesNotThrow(()=>new Listener({call:async()=>null},undefined,undefined,{...cfg,maxToolCallsPerWake:1,wakeTimeoutMs:1000}));});

test('all tool calls share one budget and the model sees remaining values',async()=>{const s=setup((round,messages)=>round<7?{content:null,tool_calls:[call('get_group_members',{offset:round,limit:1})]}:{content:null,tool_calls:[call('finish')]},{maxToolCallsPerWake:8});try{await s.bot.receive(event(),self);await settle(s);assert.equal(s.requests.length,8);const budgets=s.requests.map(m=>JSON.parse(String(m[0]!.content).split('\n').at(-1)!).wake_budget);assert.equal(budgets[0].used_tool_calls,0);assert.equal(budgets.at(-1)!.remaining_tool_calls,1);}finally{await s.bot.stop();}});

test('a response is truncated at the shared budget prefix',async()=>{const s=setup(()=>({content:null,tool_calls:[call('get_group_members'),call('get_group_members'),call('get_group_members')]}),{maxToolCallsPerWake:2});try{await s.bot.receive(event(),self);await settle(s);assert.equal(s.requests.length,1);assert.equal(s.calls.filter(x=>x==='get_group_member_list').length,2);}finally{await s.bot.stop();}});

test('invalid and disabled calls consume the same budget as valid calls',async()=>{const s=setup((round)=>round===0?{content:null,tool_calls:[{id:'bad',type:'function',function:{name:'not_a_tool',arguments:'{'}} as any,call('get_group_members')]}:{content:null,tool_calls:[call('finish')]},{maxToolCallsPerWake:2});try{await s.bot.receive(event(),self);await settle(s);assert.equal(s.requests.length,1);assert.equal(s.calls.filter(x=>x==='get_group_member_list').length,1);}finally{await s.bot.stop();}});

test('custom wake timeout is independent of model request timeout',async()=>{const s=setup(async()=>{await delay(20);return{content:null,tool_calls:[call('get_group_members')]};},{maxToolCallsPerWake:96,wakeTimeoutMs:1000,timeoutMs:5000});try{await s.bot.receive(event(),self);await settle(s);assert.ok(s.requests.length>=1);}finally{await s.bot.stop();}});
