import test from 'node:test';
import assert from 'node:assert/strict';
import {TurnScheduler} from '../../../src/agent/scheduler.js';

const tick=async()=>{await Promise.resolve();await Promise.resolve();};
test('global permits bound whole turns and waiting groups are admitted FIFO',async()=>{
 const scheduler=new TurnScheduler(2),order:string[]=[];
 const a=await scheduler.acquire('1'),b=await scheduler.acquire('2');
 const c=scheduler.acquire('3').then(release=>{order.push('3');return release;});
 const d=scheduler.acquire('4').then(release=>{order.push('4');return release;});
 assert.equal(scheduler.activeCount,2);assert.equal(scheduler.waitingCount,2);
 a();const releaseC=await c;assert.deepEqual(order,['3']);assert.equal(scheduler.activeCount,2);
 const again=scheduler.acquire('1').then(release=>{order.push('1');return release;});
 b();const releaseD=await d;assert.deepEqual(order,['3','4']);
 releaseC();const releaseAgain=await again;assert.deepEqual(order,['3','4','1']);
 releaseC();assert.equal(scheduler.activeCount,2);releaseD();releaseAgain();assert.equal(scheduler.activeCount,0);
 scheduler.close();
});
test('one group cannot occupy or queue multiple turns; queue capacity is bounded',async()=>{
 const scheduler=new TurnScheduler(1,2),a=await scheduler.acquire('1');
 await assert.rejects(scheduler.acquire('1'),/already/);
 const b=scheduler.acquire('2');await assert.rejects(scheduler.acquire('2'),/already/);
 await assert.rejects(scheduler.acquire('3'),/capacity/);
 a();(await b)();scheduler.close();
});
test('queued cancellation frees its slot without cancelling another group',async()=>{
 const scheduler=new TurnScheduler(1),a=await scheduler.acquire('1'),controller=new AbortController();
 const b=scheduler.acquire('2',controller.signal);const rejected=assert.rejects(b,{name:'AbortError'});
 const c=scheduler.acquire('3');controller.abort();await rejected;
 assert.equal(scheduler.activeCount,1);assert.equal(scheduler.waitingCount,1);
 a();(await c)();assert.equal(scheduler.activeCount,0);scheduler.close();
});
test('cancelling an already granted permit never prematurely releases active work',async()=>{
 const scheduler=new TurnScheduler(1),controller=new AbortController();
 const a=await scheduler.acquire('1',controller.signal);let admitted=false;
 const b=scheduler.acquire('2').then(release=>{admitted=true;return release;});
 controller.abort();await tick();assert.equal(admitted,false);assert.equal(scheduler.activeCount,1);
 a();(await b)();scheduler.close();
});
test('close rejects waiters and new admissions, active release remains idempotent',async()=>{
 const scheduler=new TurnScheduler(1),a=await scheduler.acquire('1');
 const b=scheduler.acquire('2'),rejected=assert.rejects(b,{name:'AbortError'});
 scheduler.close();scheduler.close();await rejected;
 assert.equal(scheduler.activeCount,1);assert.equal(scheduler.waitingCount,0);
 await assert.rejects(scheduler.acquire('3'),/closed/);a();a();assert.equal(scheduler.activeCount,0);
});
test('invalid limits, identities and pre-cancelled requests cannot allocate permits',async()=>{
 for(const n of [0,9,1.5,NaN,Infinity])assert.throws(()=>new TurnScheduler(n));
 for(const n of [0,33,1.5,NaN])assert.throws(()=>new TurnScheduler(1,n));
 const scheduler=new TurnScheduler(1);
 for(const id of ['0','01','1\n','-1','all','1'.repeat(33)])await assert.rejects(scheduler.acquire(id));
 const c=new AbortController();c.abort();await assert.rejects(scheduler.acquire('1',c.signal),{name:'AbortError'});
 assert.equal(scheduler.activeCount,0);assert.equal(scheduler.waitingCount,0);scheduler.close();
});
