import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOneBotEvent, recordToolMessage } from '../src/world-event-ingest.js';
import { WorldEventStore } from '../src/world-events.js';
import type { TimelineEntry } from '../src/contracts.js';
const eventBase = { post_type: 'message', message_type: 'group', group_id: '123', self_id: '999', user_id: '100', message_id: 10, message: [{ type: 'text', data: { text: 'hello' } }], sender: { user_id: '100', nickname: 'Alice' }, time: 1700000000 };
const root = () => mkdtempSync(join(tmpdir(), 'qqbot-world-ingest-'));

test('normalizes a group message into typed append input and identifies self echo', () => {
  const input = normalizeOneBotEvent(eventBase, '999', 'onebot', 1700000001); assert.equal(input?.type, 'message.created'); assert.equal(input?.groupId, '123'); assert.equal(input?.actorId, '100'); assert.equal(input?.dedupKey, 'message:10'); assert.equal((input?.payload as any).message.segments[0].type, 'text');
  const self = normalizeOneBotEvent({ ...eventBase, user_id: '999', sender: { user_id: '999' }, message_id: 11 }, '999'); assert.equal((self?.payload as any).message.bot, true);
});

test('rejects private, wrong-group, malformed, and unknown events without guessing', () => {
  assert.equal(normalizeOneBotEvent({ ...eventBase, message_type: 'private' }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ ...eventBase, group_id: 'bad' }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ ...eventBase, sender: { user_id: '101' } }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ post_type: 'notice', notice_type: 'mystery', group_id: '123' }, '999'), undefined);
  assert.equal(normalizeOneBotEvent({ ...eventBase, message: [{ type: 'text', data: { get text() { throw Error(); } } }] }, '999'), undefined);
});

test('normalizes recall, poke, and dirty reaction notices conservatively', () => {
  const recall = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'group_recall', group_id: '123', message_id: '10', operator_id: '200', user_id: '100' }, '999'); assert.equal(recall?.type, 'message.recalled'); assert.equal(recall?.actorId, '200'); assert.equal((recall?.payload as any).recalled_by, '200');
  const poke = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: '123', user_id: '100', target_id: '999' }, '999'); assert.equal(poke?.type, 'poke.created'); assert.equal(poke?.subject?.id, '999');
  const reaction = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'group_msg_emoji_like', group_id: '123', message_id: '10', user_id: '100', is_add: true, likes: { count: 999 } }, '999'); assert.equal(reaction?.type, 'reaction.changed'); assert.equal((reaction?.payload as any).action, undefined); assert.equal(reaction?.actorId, undefined);
});

test('uses explicit provider event identity only for reaction/poke dedup', () => {
  const a = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: '123', user_id: '100', target_id: '999', event_id: 'n1' }, '999'); const b = normalizeOneBotEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: '123', user_id: '100', target_id: '999' }, '999'); assert.match(a?.dedupKey ?? '', /^notice:/); assert.equal(b?.dedupKey, undefined);
});

const notice = {post_type:'notice',group_id:'123',self_id:'999',time:1700000000};
const normalized = (fields:Record<string,unknown>) => normalizeOneBotEvent({...notice,...fields},'999','onebot',1700000001);

test('member notices preserve upstream subtype, subject and explicitly reported operator',()=>{
 for(const sub_type of ['approve','invite']){
  const n=normalized({notice_type:'group_increase',sub_type,user_id:100,operator_id:200})!;
  assert.equal(n.type,'member.joined');assert.deepEqual(n.payload,{kind:'member_joined',user_id:'100',sub_type,operator_id:'200'});assert.equal(n.actorId,'200');assert.deepEqual(n.subject,{kind:'member',id:'100'});assert.deepEqual(n.provenance,{source:'onebot',verified:false});assert.equal(n.occurredAt,1700000000);
 }
 for(const sub_type of ['leave','kick','kick_me','disband']){
  const n=normalized({notice_type:'group_decrease',sub_type,user_id:'100',operator_id:'200'})!;
  assert.equal(n.type,'member.left');assert.deepEqual(n.payload,{kind:'member_left',user_id:'100',sub_type,operator_id:'200'});
 }
});

test('unknown operators remain absent rather than inferring the leaving member as actor',()=>{
 for(const fields of [{},{operator_id:0},{operator_id:'0'}]){
  const n=normalized({notice_type:'group_decrease',sub_type:'leave',user_id:'100',...fields})!;
  assert.equal(n.actorId,undefined);assert.deepEqual(n.payload,{kind:'member_left',user_id:'100',sub_type:'leave'});
 }
});

test('ban notices preserve raw subtype/duration and whole-group target without guessing state',()=>{
 for(const user_id of ['100',0,'0'])for(const sub_type of ['ban','lift_ban'])for(const duration of [0,60,Number.MAX_SAFE_INTEGER]){
  const n=normalized({notice_type:'group_ban',sub_type,user_id,operator_id:200,duration})!;
  assert.equal(n.type,'group.ban_changed');assert.deepEqual(n.payload,{kind:'group_ban',sub_type,user_id:String(user_id),operator_id:'200',duration});assert.deepEqual(n.subject,user_id==='100'?{kind:'member',id:'100'}:{kind:'group',id:'123'});assert.equal(n.provenance.verified,false);
 }
});

test('file uploads retain bounded metadata and never persist remote capabilities or payloads',()=>{
 const n=normalized({notice_type:'group_upload',user_id:100,file:{id:'PRIVATE_FILE_ID',file_id:'PRIVATE_FILE_ID_2',name:'report.txt',size:123,busid:102,url:'https://private.invalid/token',path:'/private/path',extra:'PRIVATE_RAW'}})!;
 assert.equal(n.type,'file.uploaded');assert.equal(n.actorId,'100');assert.deepEqual(n.subject,{kind:'group',id:'123'});assert.deepEqual(n.payload,{kind:'file_uploaded',user_id:'100',name:'report.txt',size:123});assert.doesNotMatch(JSON.stringify(n),/PRIVATE|private|busid|file_id|url|path/);
 const long=normalized({notice_type:'group_upload',user_id:100,file:{name:'x'.repeat(255)+'😀'.repeat(200),size:0}})!;assert.equal((long.payload as any).name.length,255);
 const url=normalized({notice_type:'group_upload',user_id:100,file:{name:'\u0000https://private.invalid/token',size:0}})!;assert.equal((url.payload as any).name,'[redacted]');
});

test('group name uses only the documented native notice; announcement-like envelopes stay unsupported',()=>{
 const n=normalized({notice_type:'notify',sub_type:'group_name',name_new:'new group',user_id:'100',operator_id:'200',old_name:'PRIVATE_OLD'})!;
 assert.equal(n.type,'group.name_changed');assert.deepEqual(n.payload,{kind:'group_name',name:'new group',user_id:'100'});assert.equal(n.actorId,undefined);assert.deepEqual(n.subject,{kind:'group',id:'123'});assert.doesNotMatch(JSON.stringify(n),/PRIVATE_OLD/);
 for(const fields of [{notice_type:'group_notice'},{notice_type:'group_announcement'},{notice_type:'notify',sub_type:'group_notice'},{notice_type:'notify',sub_type:'group_profile'}])assert.equal(normalized({...fields,name_new:'title',content:'do not invent events'}),undefined);
});

test('new notice validation rejects invalid scope, identities, variants and numeric metadata',()=>{
 const good={notice_type:'group_ban',user_id:'100',operator_id:'200',sub_type:'ban',duration:60};
 for(const fields of [{group_id:'0'},{group_id:1.5},{self_id:'998'},{operator_id:-1},{operator_id:'bad'},{user_id:-1},{user_id:'00'},{sub_type:'unknown'},{duration:-1},{duration:1.5},{duration:Infinity},{duration:'60'},{duration:Number.MAX_SAFE_INTEGER+1}])assert.equal(normalized({...good,...fields}),undefined,JSON.stringify(fields));
 for(const fields of [{notice_type:'group_increase',sub_type:'kick',user_id:100},{notice_type:'group_decrease',sub_type:'approve',user_id:100},{notice_type:'group_increase',sub_type:'approve',user_id:0},{notice_type:'group_upload',user_id:100,file:{name:'ok',size:-1}},{notice_type:'group_upload',user_id:100,file:{name:'ok',size:1.5}},{notice_type:'group_upload',user_id:100,file:{name:'',size:1}},{notice_type:'notify',sub_type:'group_name',name_new:'',user_id:100}])assert.equal(normalized(fields),undefined);
 let accessed=false;assert.equal(normalized({notice_type:'group_upload',user_id:100,file:{get name(){accessed=true;throw Error();},size:1}}),undefined);assert.equal(accessed,false);
});

test('new notices only deduplicate explicit provider identities and stay isolated between groups',()=>{
 const fields={notice_type:'group_upload',user_id:100,file:{name:'same.txt',size:5}},store=new WorldEventStore({path:':memory:',groupId:'123'});
 try{
  const first=store.append(normalized(fields)!);const second=store.append(normalized(fields)!);assert.notEqual(first.eventId,second.eventId);
  const withId=normalized({...fields,event_id:'provider-unique'})!;assert.equal(store.append(withId).eventId,store.append(withId).eventId);assert.notEqual(withId.dedupKey,normalized({...fields,event_id:'provider-unique',group_id:'456'})!.dedupKey);
  assert.throws(()=>store.append(normalized({...fields,group_id:'456'})!),/Invalid world event/);assert.equal(store.readMessages({limit:10}).returned,0);
 }finally{store.close();}
});

test('recordToolMessage writes only validated ACK entries and store deduplicates echo', () => {
  const base = root(), path = join(base, 'world.sqlite'), store = new WorldEventStore({ path, groupId: '123' }); const entry: TimelineEntry = { messageId: '55', userId: '999', nickname: 'Bot', text: 'sent', time: 1700000000, bot: true, segments: [{ type: 'text', text: 'sent' }] };
  try { const first = recordToolMessage(store, entry, 1700000001); const echo = normalizeOneBotEvent({ ...eventBase, user_id: '999', sender: { user_id: '999' }, message_id: 55, message: [{ type: 'text', data: { text: 'sent' } }] }, '999', 'onebot', 1700000002); const second = echo ? store.append(echo) : undefined; assert.equal(second?.eventId, first.eventId); assert.equal(store.readEvents({ limit: 10 }).returned, 1); } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
});
