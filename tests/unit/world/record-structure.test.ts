import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldEventStore } from '../../../src/world/events.ts';
import { extractMessageContent, projectMessageContext } from '../../../src/world/message-content.ts';
import type { TimelineEntry } from '../../../src/contracts/messages.ts';

const record={type:'record',content_status:'not_transcribed'} as const;
const row=():TimelineEntry=>({messageId:'123',userId:'42',nickname:'Alice',time:Date.now()/1000,text:'[record]',...extractMessageContent('123',[{type:'record',data:{url:'https://VOICE_SECRET',file:'FILE_SECRET',text:'FORGED_TRANSCRIPT'}}])});

test('world record remains identifiable by messageId through SQLite reopen and history/context projection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'world-record-')),path=join(dir,'world.sqlite');
 let store=new WorldEventStore({path,groupId:'42'});
 try{
  const event=store.appendMessage(row());
  assert.equal(event.payload.kind,'message');
  store.appendMessage({...row(),messageId:'124',segments:[{type:'unsupported',kind:'record'}]});
  store.close();store=new WorldEventStore({path,groupId:'42'});
  const saved=store.findMessage('123')!;
  assert.equal(saved.messageId,'123');assert.deepEqual(saved.segments,[record]);
  const messages=store.readMessages({limit:10}).messages;
  assert.deepEqual(messages[0]?.segments,[record]);assert.equal(messages[0]?.messageId,'123');
  assert.deepEqual(messages[1]?.segments,[{type:'unsupported',kind:'record'}]);
  const eventPage=store.readEvents({limit:10});
  const payload=eventPage.events[0]!.payload;
  assert.equal(payload?.kind,'message');if(payload?.kind==='message')assert.deepEqual(payload.message.segments,[record]);
  const projected=JSON.parse(projectMessageContext(JSON.stringify({messages})));
  assert.equal(projected.messages[0].messageId,'123');assert.deepEqual(projected.messages[0].segments,[record]);
  assert.deepEqual(projected.messages[1].segments,[{type:'unsupported',kind:'record'}]);
  assert.doesNotMatch(JSON.stringify([saved,messages,eventPage,projected]),/VOICE_SECRET|FILE_SECRET|FORGED_TRANSCRIPT/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('world rejects record transport/transcript attributes and invalid status without relaxing segment limits',()=>{
 const store=new WorldEventStore({path:':memory:',groupId:'42'});
 try{
  for(const extra of [{url:'https://SECRET'},{file:'SECRET'},{text:'FORGED'},{content_status:'transcribed'}]){
   assert.throws(()=>store.appendMessage({...row(),segments:[{...record,...extra}] as TimelineEntry['segments']}),/Invalid message/);
  }
  assert.throws(()=>store.appendMessage({...row(),segments:Array.from({length:129},()=>record)}),/Invalid message/);
  assert.deepEqual(store.appendMessage(row()).subject,{kind:'message',id:'123'});
 }finally{store.close();}
});
