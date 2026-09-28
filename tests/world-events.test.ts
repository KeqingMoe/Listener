import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldEventStore, type WorldEventInput } from '../src/world/events.js';
import type { TimelineEntry } from '../src/contracts/index.js';

const dir = () => mkdtempSync(join(tmpdir(), 'qqbot-world-events-'));
const entry = (id: string, time = Date.now() / 1000): TimelineEntry => ({ messageId: id, userId: '100', nickname: 'user', text: `message ${id}`, time, segments: [{ type: 'text', text: `message ${id}` }] });
const messageEvent = (id: string, observedAt = Date.now() / 1000): WorldEventInput => ({ type: 'message.created', observedAt, payload: { kind: 'message', message: entry(id, observedAt) }, provenance: { source: 'onebot', verified: true } });
const open = (groupId = '123'): [WorldEventStore, string] => { const root = dir(); const path = join(root, 'events.sqlite'); return [new WorldEventStore({ path, groupId, retentionDays: 30 }), root]; };
const close = (store: WorldEventStore, root: string) => { store.close(); rmSync(root, { recursive: true, force: true }); };

test('creates a secure group-bound append-only store and reopens it', () => {
  const [store, root] = open('123');
  try { const e = store.appendMessage(entry('1'), { source: 'onebot' }); assert.equal(e.sequence, 1); assert.equal(store.findMessage('1')?.text, 'message 1'); }
  finally { store.close(); const reopened = new WorldEventStore({ path: join(root, 'events.sqlite'), groupId: '123' }); try { assert.equal(reopened.getState().latestSequence, 1); assert.equal(reopened.findMessage('1')?.messageId, '1'); } finally { close(reopened, root); } }
});

test('rejects a wrong group and symlink path', () => {
  const [store, root] = open('123'); const path = join(root, 'events.sqlite'); store.appendMessage(entry('1'), { source: 'onebot' }); store.close();
  assert.throws(() => new WorldEventStore({ path, groupId: '456' }), /group mismatch/);
  close(new WorldEventStore({ path: ':memory:', groupId: '123' }), root);
});

test('deduplicates message echoes without overwriting the first event', () => {
  const [store, root] = open(); try { const first = store.appendMessage(entry('1'), { source: 'onebot' }); const second = store.appendMessage({ ...entry('1'), text: 'late echo changed' }, { source: 'tool' }); assert.equal(second.eventId, first.eventId); assert.equal(store.readEvents({ limit: 10 }).returned, 1); assert.equal(store.findMessage('1')?.text, 'message 1'); } finally { close(store, root); }
});

test('requires an explicit positive finite query limit and returns stable high water pages', () => {
  const [store, root] = open(); try { for (let i = 0; i < 5; i++) store.appendMessage(entry(String(i + 1))); assert.throws(() => store.readEvents({} as never), /limit/); assert.throws(() => store.readEvents({ limit: 0 }), /limit/); const first = store.readEvents({ limit: 2 }); assert.deepEqual(first.events.map(e => e.sequence), [1, 2]); store.appendMessage(entry('6')); const second = store.readEvents({ limit: 10, after: first.lastSequence, highWater: first.highWater }); assert.deepEqual(second.events.map(e => e.sequence), [3, 4, 5]); const fresh = store.readEvents({ limit: 10, after: first.lastSequence }); assert.deepEqual(fresh.events.map(e => e.sequence), [3, 4, 5, 6]); } finally { close(store, root); }
});

test('supports backward, type, actor and time filters', () => {
  const [store, root] = open(); try { const base = 1_700_000_000; store.appendMessage({ ...entry('1', base), userId: 'a' }, { source: 'onebot', occurredAt: base }); store.append({ type: 'poke.created', observedAt: base + 1, actorId: 'b', subject: { kind: 'member', id: 'b' }, payload: { kind: 'poke', user_id: 'b' }, provenance: { source: 'onebot', verified: false } }); store.appendMessage({ ...entry('2', base + 2), userId: 'b' }, { source: 'onebot', observedAt: base + 2, occurredAt: base + 2 }); const page = store.readEvents({ limit: 5, direction: 'backward', actorId: 'b', since: base, until: base + 2 }); assert.deepEqual(page.events.map(e => e.type), ['message.created', 'poke.created']); assert.equal((page.events[1]!.payload as { user_id: string }).user_id, 'b'); } finally { close(store, root); }
});

test('recall is an event and message view keeps original content', () => {
  const [store, root] = open(); try { store.appendMessage(entry('1'), { source: 'onebot' }); store.appendRecall('1', { recalledBy: '200', verified: true }); const events = store.readEvents({ limit: 10 }); assert.deepEqual(events.events.map(e => e.type), ['message.created', 'message.recalled']); const view = store.readMessages({ limit: 10 }); assert.equal(view.messages[0]!.text, 'message 1'); assert.equal(view.messages[0]!.recalled, true); assert.equal(view.messages[0]!.recalledBy, '200'); } finally { close(store, root); }
});

test('allows reaction events with unknown actor and preserves unknown fields as absent', () => {
  const [store, root] = open(); try { const event = store.append({ type: 'reaction.changed', observedAt: Date.now() / 1000, subject: { kind: 'message', id: '1' }, payload: { kind: 'reaction', message_id: '1' }, provenance: { source: 'onebot', verified: false } }); assert.equal(event.actorId, undefined); assert.equal((store.readEvents({ limit: 1 }).events[0]!.payload as { message_id: string }).message_id, '1'); } finally { close(store, root); }
});

test('advances cursor when an event payload exceeds the output budget', () => {
  const [store, root] = open(); try { store.appendMessage({ ...entry('1'), text: 'x'.repeat(4000), segments: [{ type: 'text', text: 'x'.repeat(4000) }] }, { source: 'onebot' }); const page = store.readEvents({ limit: 1 }, 2048); assert.equal(page.returned, 1); assert.equal(page.events[0]!.payload, null); assert.equal(page.events[0]!.payload_omitted, true); assert.equal(page.lastSequence, 1); } finally { close(store, root); }
});

test('observation acknowledgements are monotonic and group scoped', () => {
  const [store, root] = open(); try { store.appendMessage(entry('1')); store.appendMessage(entry('2')); assert.equal(store.getState('ai').unreadEvents, 2); assert.equal(store.ack('ai', 1), 1); assert.equal(store.ack('ai', 0), 1); assert.equal(store.getState('ai').unreadEvents, 1); assert.throws(() => store.ack('ai', 99), /ahead/); } finally { close(store, root); }
});

const metadataEvents:WorldEventInput[] = [
 {type:'member.joined',payload:{kind:'member_joined',user_id:'100',operator_id:'200',sub_type:'approve'},actorId:'200',observedAt:1700000000,provenance:{source:'onebot',verified:false}},
 {type:'member.left',payload:{kind:'member_left',user_id:'100',operator_id:'200',sub_type:'kick'},actorId:'200',observedAt:1700000001,provenance:{source:'onebot',verified:false}},
 {type:'group.ban_changed',payload:{kind:'group_ban',user_id:'0',operator_id:'200',sub_type:'ban',duration:0},actorId:'200',observedAt:1700000002,provenance:{source:'onebot',verified:false}},
 {type:'file.uploaded',payload:{kind:'file_uploaded',user_id:'100',name:'report.txt',size:50},actorId:'100',observedAt:1700000003,provenance:{source:'onebot',verified:false}},
 {type:'group.name_changed',payload:{kind:'group_name',name:'new group',user_id:'100'},observedAt:1700000004,provenance:{source:'onebot',verified:false}},
];
test('group metadata events persist, reopen, filter and account for unread without affecting messages',()=>{
 const [store,root]=open();
 try{
  metadataEvents.forEach(e=>store.append(e));assert.deepEqual(store.readEvents({limit:20}).events.map(e=>e.type),metadataEvents.map(e=>e.type));assert.equal(store.readMessages({limit:20}).returned,0);
  for(const e of metadataEvents){assert.equal(store.getState('metadata').unreadByType[e.type],1);assert.equal(store.readEvents({limit:10,types:[e.type]}).returned,1);}
  assert.equal(store.readEvents({limit:10,actorId:'200'}).returned,3);assert.equal(store.getState('metadata').unreadEvents,5);store.ack('metadata',3);assert.equal(store.getState('metadata').unreadEvents,2);
  const page=store.readEvents({limit:2});store.append({...metadataEvents[0]!,observedAt:1700000005});assert.deepEqual(store.readEvents({limit:10,after:page.lastSequence,highWater:page.highWater}).events.map(e=>e.sequence),[3,4,5]);
  store.close();const reopened=new WorldEventStore({path:join(root,'events.sqlite'),groupId:'123',retentionDays:3650});try{assert.equal(reopened.readEvents({limit:10}).returned,6);assert.deepEqual(reopened.readEvents({limit:1,types:['group.ban_changed']}).events[0]!.subject,{kind:'group',id:'123'});}finally{reopened.close();}
 }finally{close(store,root);}
});
test('metadata payload validators reject raw credentials, malformed values, spoofed subject and actor',()=>{
 const [store,root]=open();
 try{
  for(const event of metadataEvents){for(const key of ['url','file_id','id','busid','raw','message'])assert.throws(()=>store.append({...event,payload:{...event.payload,[key]:'PRIVATE'} as any}),/Invalid world event/);assert.throws(()=>store.append({...event,subject:{kind:'group',id:'456'}}),/subject/);assert.throws(()=>store.append({...event,actorId:'999'}),/actor/);assert.throws(()=>store.append({...event,groupId:'456'}),/Invalid world event/);}
  const badPayloads=[{kind:'member_joined',user_id:'0',sub_type:'approve'},{kind:'member_left',user_id:'100',sub_type:['kick']},{kind:'group_ban',user_id:'0',sub_type:'ban',duration:-1},{kind:'file_uploaded',user_id:'100',name:'http://secret.invalid/key',size:1},{kind:'file_uploaded',user_id:'100',name:'x'.repeat(257),size:1},{kind:'file_uploaded',user_id:'100',name:'ok',size:Number.MAX_SAFE_INTEGER+1},{kind:'group_name',name:'x',user_id:'bad'}];
  for(const payload of badPayloads){const event=metadataEvents.find(e=>e.payload.kind===payload.kind)!;assert.throws(()=>store.append({...event,payload} as WorldEventInput),/Invalid world event/);}
  assert.equal(store.getState().latestSequence,0);
 }finally{close(store,root);}
});
test('new metadata retention keeps immutable deduplicated facts and monotonic sequences',()=>{
 const [store,root]=open();try{
  const old=store.append({...metadataEvents[3]!,dedupKey:'upload-one'});const duplicate=store.append({...metadataEvents[3]!,payload:{kind:'file_uploaded',user_id:'100',name:'changed.txt',size:999},dedupKey:'upload-one'});assert.deepEqual(duplicate,old);
  const current=store.append({...metadataEvents[4]!,observedAt:Date.now()/1000});assert.equal(store.prune(),1);assert.deepEqual(store.readEvents({limit:10}).events.map(e=>e.eventId),[current.eventId]);assert.ok(store.append({...metadataEvents[0]!,observedAt:Date.now()/1000}).sequence>current.sequence);
 }finally{close(store,root);}
});

test('prunes expired events explicitly without changing append semantics', () => {
  const [store, root] = open(); try { const old = Date.now() / 1000 - 31 * 86400; store.appendMessage(entry('old', old), { source: 'migration', observedAt: old, verified: false }); store.appendMessage(entry('new'), { source: 'onebot' }); assert.equal(store.prune(Date.now() / 1000), 1); assert.deepEqual(store.readEvents({ limit: 10 }).events.map(e => e.payload), [(store.readEvents({ limit: 10 }).events[0]!.payload)]); assert.equal(store.findMessage('old'), undefined); } finally { close(store, root); }
});
