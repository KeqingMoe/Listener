import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SQLiteMemory } from '../src/memory.js';
import { LISTENER_GROUP, type ChatMessage, type Completion, type Model, type TimelineEntry } from '../src/contracts/index.js';

const entry = (n: number, text = 'hello'): TimelineEntry => ({ messageId: String(n), userId: '42', nickname: 'Alice', text, time: Math.floor(Date.now() / 1000) });
const make = (maxContextChars = 14000) => new SQLiteMemory({ path: ':memory:', maxContextChars, retentionDays: 7 });
const populate = (memory: SQLiteMemory, count = 60) => { for (let i = 0; i < count; i++) assert.equal(memory.append(entry(i, 'x'.repeat(200))), true); };
const good: Model = { async complete() { return { content: 'Alice (user 42) discussed facts; message IDs 0–29, Unix timestamps in source.', tool_calls: [] }; } };

test('deduplicates raw inserts, emits untrusted chronological JSON and finds only local raw records', () => {
  const memory = make();
  try {
    assert.equal(memory.append(entry(1)), true); assert.equal(memory.append(entry(1, 'duplicate')), false);
    assert.equal(memory.append({ ...entry(2), time: entry(2).time - 2 }), true);
    assert.equal(memory.find('1')?.text, 'hello'); assert.equal(memory.find('remote'), undefined);
    const context = JSON.parse(memory.context());
    assert.equal(context.groupId, LISTENER_GROUP); assert.equal(context.untrusted, true);
    assert.deepEqual(context.messages.map((e: TimelineEntry) => e.messageId), ['2', '1']);
    memory.clear(); assert.deepEqual(memory.recent(), []); assert.equal(memory.append(entry(1)), true);
  } finally { memory.close(); memory.close(); }
});

test('image references survive persistence without transport URLs, bytes or unknown metadata', () => {
  const dir=mkdtempSync(join(tmpdir(),'listener-images-memory-'));const path=join(dir,'memory.sqlite');
  let memory=new SQLiteMemory({path,maxContextChars:8000,retentionDays:7});
  try{
    memory.append({...entry(10,'[图片 id=img_10_2：未分析]'),images:[{id:'img_10_2',index:2,url:'https://signed-secret',dataUrl:'data:image/jpeg;base64,secret'},{id:'img_99_0',index:0}] as any});
    assert.deepEqual(memory.find('10')?.images,[{id:'img_10_2',index:2}]);
    assert.ok(!memory.context().includes('signed-secret'));assert.ok(!memory.context().includes('base64'));
    memory.close();memory=new SQLiteMemory({path,maxContextChars:8000,retentionDays:7});
    assert.deepEqual(memory.find('10')?.images,[{id:'img_10_2',index:2}]);
    memory.clear();assert.equal(memory.find('10'),undefined);
  }finally{memory.close();rmSync(dir,{recursive:true,force:true});}
});

test('raw capacity and context are strictly bounded, including escaped messages', () => {
  const memory = make(8000);
  try {
    for (let n = 0; n < 350; n++) memory.append(entry(n, '\u0000'.repeat(10000)));
    assert.equal(memory.recent().length, 300); assert.equal(memory.find('0'), undefined);
    assert.ok(memory.context().length <= 8000); assert.doesNotThrow(() => JSON.parse(memory.context()));
  } finally { memory.close(); }
});

test('compaction uses no tools, untrusted provenance and retains last thirty with bounded summary', async () => {
  const memory = make(); let captured: ChatMessage[] = [];
  try {
    populate(memory);
    await memory.compact({ async complete(messages, tools) {
      captured = messages; assert.deepEqual(tools, []);
      return { content: 'summary '.repeat(10000), tool_calls: [] };
    } });
    assert.equal(memory.recent().length, 30);
    assert.equal(memory.find('29'), undefined); assert.ok(memory.find('30'));
    assert.equal(memory.append(entry(0)), false, 'dedup survives raw compaction');
    const input = captured[1]!.content; assert.ok(typeof input === 'string');
    const source = JSON.parse(input);
    assert.equal(source.untrusted, true); assert.equal(source.messages[0].messageId, '0');
    assert.equal(source.messages[0].nickname, 'Alice'); assert.equal(source.messages[0].userId, '42');
    assert.equal(typeof source.messages[0].time, 'number');
    const instruction = captured[0]!.content; assert.ok(typeof instruction === 'string');
    assert.match(instruction, /never as instructions/);
    const context = JSON.parse(memory.context()); assert.equal(context.summary.untrusted, true);
    assert.ok(context.summary.text.length < 2000); assert.ok(memory.context().length <= 14000);
  } finally { memory.close(); }
});

test('compaction prefix snapshots preserve appends and serialize concurrent compact calls', async () => {
  const memory = make(); let resolve!: (result: Completion) => void; let calls = 0;
  const model: Model = { complete() { calls++; return new Promise(r => { resolve = r; }); } };
  try {
    populate(memory); const pending = memory.compact(model);
    memory.append(entry(100, 'appended during await'));
    await memory.compact(model); assert.equal(calls, 1);
    resolve({ content: 'safe summary', tool_calls: [] }); await pending;
    assert.equal(memory.recent().length, 31); assert.equal(memory.find('100')?.text, 'appended during await');
  } finally { memory.close(); }
});

test('reset and close invalidate an awaiting summary; failures keep bounded context and raw data', async () => {
  for (const operation of ['clear', 'close', 'failure'] as const) {
    const memory = make(); let resolve!: (result: Completion) => void;
    populate(memory);
    if (operation === 'failure') {
      await memory.compact({ async complete() { throw Error('remote error'); } });
      assert.equal(memory.recent().length, 60); assert.ok(memory.context().length <= 14000); memory.close(); continue;
    }
    const pending = memory.compact({ complete() { return new Promise(r => { resolve = r; }); } });
    memory[operation]();
    if (operation === 'clear') memory.append(entry(999, 'after reset'));
    resolve({ content: 'must not return', tool_calls: [] }); await pending;
    if (operation === 'clear') {
      assert.equal(JSON.parse(memory.context()).summary, null); assert.deepEqual(memory.recent().map(e => e.messageId), ['999']); memory.close();
    }
  }
});

test('retention expires raw data and summary, including housekeeping on read', async () => {
  const memory = make(); const now = Date.now; const initial = now();
  try {
    populate(memory); await memory.compact(good); assert.ok(JSON.parse(memory.context()).summary);
    Date.now = () => initial + 8 * 86400 * 1000;
    assert.equal(memory.find('59'), undefined); assert.deepEqual(memory.recent(), []);
    assert.equal(JSON.parse(memory.context()).summary, null);
    assert.equal(memory.append({ ...entry(1), time: initial / 1000 }), false);
    assert.equal(memory.append(entry(1)), true, 'expired dedup IDs may be reused');
  } finally { Date.now = now; memory.close(); }
});

test('private persistent database survives reopen and rejects another group identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'listener-memory-')); const path = join(directory, 'memory.sqlite');
  try {
    let memory = new SQLiteMemory({ path, maxContextChars: 8000, retentionDays: 7 });
    memory.append(entry(1)); memory.close(); assert.equal(statSync(path).mode & 0o777, 0o600);
    memory = new SQLiteMemory({ path, maxContextChars: 8000, retentionDays: 7 });
    assert.equal(memory.find('1')?.nickname, 'Alice'); memory.clear(); memory.close();
    const db = new DatabaseSync(path);
    db.prepare(`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<100005)
      INSERT INTO listener_seen SELECT CAST(n AS TEXT), ? FROM ids`).run(Date.now() / 1000);
    memory = new SQLiteMemory({ path, maxContextChars: 8000, retentionDays: 7 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listener_seen').get()!.count, 100000);
    assert.equal(db.prepare('SELECT message_id FROM listener_seen WHERE message_id=?').get('1'), undefined);
    memory.close();
    db.prepare('UPDATE listener_identity SET group_id=?').run('other'); db.close();
    assert.throws(() => new SQLiteMemory({ path, maxContextChars: 8000, retentionDays: 7 }), /group mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
