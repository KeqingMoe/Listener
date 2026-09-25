import test from 'node:test';
import assert from 'node:assert/strict';
import {GroupRouter,type GroupHandler} from '../src/group-router.js';

function handler(){
 const calls:unknown[]=[],connections:boolean[]=[];let stopped=0;
 const service:GroupHandler={receive:async(event,self)=>{calls.push([event,self]);},setConnected(value){connections.push(value);},async stop(){stopped++;}};
 return {service,calls,connections,get stopped(){return stopped;}};
}
const event=(group_id:unknown)=>({post_type:'message',message_type:'group',group_id});
test('router dispatches only enabled group messages to the matching instance',async()=>{
 const a=handler(),b=handler(),router=new GroupRouter([['1',a.service],['2',b.service]]);
 assert.deepEqual(a.connections,[false]);assert.equal(router.size,2);
 await router.receive(event('1'),'99');assert.equal(a.calls.length,0);
 router.setConnected(true);
 const first=event('1'),second=event(2);
 await router.receive(first,'99');await router.receive(second,'99');
 for(const unknown of [event('3'),event('01'),event('all'),{...event('1'),message_type:'private'},{...event('1'),post_type:'notice'},null,{}])await router.receive(unknown,'99');
 assert.deepEqual(a.calls,[[first,'99']]);assert.deepEqual(b.calls,[[second,'99']]);
 router.setConnected(false);await router.receive(first,'99');assert.equal(a.calls.length,1);
 router.setConnected(true);await router.receive(first,'99');assert.equal(a.calls.length,2);
 await router.stop();router.setConnected(true);await router.receive(first,'99');
 assert.equal(a.calls.length,2);assert.equal(a.stopped,1);assert.equal(b.stopped,1);
 await router.stop();assert.equal(a.stopped,1);
});
test('routing registry rejects duplicate groups or a shared Listener instance',()=>{
 const a=handler(),b=handler();
 assert.throws(()=>new GroupRouter([['1',a.service],['1',b.service]]));
 assert.throws(()=>new GroupRouter([['1',a.service],['2',a.service]]));
 assert.throws(()=>new GroupRouter([['01',a.service]]));
 assert.throws(()=>new GroupRouter(Array.from({length:33},(_,n)=>[String(n+1),handler().service] as const)));
 assert.equal(new GroupRouter([]).size,0);
});
test('a slow group receive never serializes delivery to another group',async()=>{
 const a=handler(),b=handler();let release!:()=>void;
 a.service.receive=()=>new Promise<void>(resolve=>{release=resolve;});
 const router=new GroupRouter([['1',a.service],['2',b.service]]);router.setConnected(true);
 const waiting=router.receive(event('1'),'99');await router.receive(event('2'),'99');
 assert.equal(b.calls.length,1);release();await waiting;await router.stop();
});
test('shutdown attempts every group even when one fails',async()=>{
 const a=handler(),b=handler();a.service.stop=async()=>{throw Error('mock');};
 const router=new GroupRouter([['1',a.service],['2',b.service]]);router.setConnected(true);
 await assert.rejects(router.stop(),/shutdown/);assert.equal(b.stopped,1);
 await router.receive(event('2'),'99');assert.equal(b.calls.length,0);
});
