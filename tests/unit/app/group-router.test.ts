import test from 'node:test';
import assert from 'node:assert/strict';
import {GroupRouter,type GroupHandler} from '../../../src/app/group-router.ts';

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
test('new group metadata notices route by whitelist only and require matching self identity',async()=>{
 const a=handler(),b=handler(),router=new GroupRouter([['1',a.service],['2',b.service]]);router.setConnected(true);
 const kinds=[{notice_type:'group_increase',sub_type:'approve'},{notice_type:'group_decrease',sub_type:'kick'},{notice_type:'group_ban',sub_type:'ban'},{notice_type:'group_upload'},{notice_type:'notify',sub_type:'group_name'},{notice_type:'group_msg_emoji_like'},{notice_type:'group_recall'},{notice_type:'notify',sub_type:'poke'}];
 const expected:unknown[]=[];
 for(const kind of kinds){const packet={post_type:'notice',group_id:'1',self_id:'99',...kind};await router.receive(packet,'99');expected.push([packet,'99']);for(const wrong of [{group_id:'3'},{group_id:'01'},{group_id:-1},{self_id:'98'},{self_id:0},{self_id:'099'},{post_type:'message',message_type:'private'}])await router.receive({...packet,...wrong},'99');}
 assert.deepEqual(a.calls,expected);assert.equal(b.calls.length,0);
 for(const self of ['','0','099','bad'])await router.receive({post_type:'notice',group_id:'1',notice_type:'group_upload'},self);
 let touched=false;await router.receive({post_type:'notice',get group_id(){touched=true;return '1';},notice_type:'group_upload'},'99');assert.equal(touched,false);
 await router.receive({post_type:'notice',group_id:'1',notice_type:'notify',sub_type:'group_announcement'},'99');assert.deepEqual(a.calls,expected);
 router.setConnected(false);await router.receive({post_type:'notice',group_id:'1',notice_type:'group_upload'},'99');assert.deepEqual(a.calls,expected);await router.stop();
});

test('routing registry rejects duplicate groups or a shared Listener instance',()=>{
 const a=handler(),b=handler();
 assert.throws(()=>new GroupRouter([['1',a.service],['1',b.service]]));
 assert.throws(()=>new GroupRouter([['1',a.service],['2',a.service]]));
 assert.throws(()=>new GroupRouter([['01',a.service]]));
 assert.equal(new GroupRouter(Array.from({length:64},(_,n)=>[String(n+1),handler().service] as const)).size,64);
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
