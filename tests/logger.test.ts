import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { configureLogging, formatLogLine, log, managedLogFilename, newTraceId, sanitizeLogFields, withLogContext, type LoggingConfig } from '../src/logger.js';

const config = (directory: string, extra: Partial<LoggingConfig> = {}): LoggingConfig => ({ level: 'debug', console: false, file: true, directory, retentionDays: 7, maxFileMb: 1, maxTotalMb: 2, ...extra });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'listener-log-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function records(directory: string): Promise<Record<string, unknown>[]> {
  const names = (await readdir(directory)).filter(managedLogFilename).sort();
  return (await Promise.all(names.map(name => readFile(join(directory, name), 'utf8')))).flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

test('unconfigured logging is no-op and sanitization is strict at every level', async t => {
  assert.doesNotThrow(() => log('info', 'app.start', { body: 'private' }));
  const directory = join(await fixture(t), 'logs');
  const logger = configureLogging(config(directory), ['needle', 'send_message']);
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    log(level, 'app.safe', {
      actor_id: 123, message_id: -4, group_id: '123', duration_ms: 1.2, count: Infinity,
      reason: 'prefix_needle_suffix', status: 'ok', phase: 'BAD', submitted: true,
      tool: 'send_message', action: 'get_msg', tools: ['get_member_info', 'send_message', 'secret'],
      turn_id: 't_0123456789abcdef', command_id: 'c_0123456789abcdef', image_id: 'img_-1_2',
      body: 'private', content: 'private', card: 'private', confirmationcode: 'private',
      headers: { authorization: 'private' }, error: new Error('private'), msg: 'private',
      event: 'app.evil', level: 'evil', time: 'private', nested: { reason: 'private' },
    });
    log(level, 'app.needle', { status: 'ok' });
    log(level, 'unknown.event', {});
    log(level, 'app.bad\nprivate', {});
  }
  await logger.close();
  const rows = await records(directory);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.event, 'app.safe');
    assert.equal(row.actor_id, 123);
    assert.equal(row.group_id, '123');
    assert.equal(row.message_id, -4);
    assert.equal(row.reason, undefined);
    assert.equal(row.tool, undefined);
    assert.equal(row.action, 'get_msg');
    assert.deepEqual(row.tools, ['get_member_info']);
    assert.equal(row.status, 'ok');
    assert.equal(row.submitted, true);
    assert.equal(row.turn_id, 't_0123456789abcdef');
    assert.match(String(row.time), /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!JSON.stringify(row).includes('private'));
    assert.ok(!JSON.stringify(row).includes('needle'));
    assert.ok(Buffer.byteLength(JSON.stringify(row) + '\n') <= 4096);
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory)) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  assert.doesNotThrow(() => log('info', 'app.done'));
});

test('autonomous moderation and explicit unmute tool names remain observable without sensitive arguments',()=>{
 const tools=['mute_member','unmute_member','recall_message','set_member_card'];
 for(const tool of tools)assert.deepEqual(sanitizeLogFields({tool,action:tool,tools,body:'private',card:'private',code:'private',args:{user_id:'123'}}),{tool,action:tool,tools});
 assert.deepEqual(sanitizeLogFields({tool:'kick_member',tools:['unmute_member','publish_announcement']}),{tool:'kick_member',tools:['unmute_member']});
 assert.deepEqual(sanitizeLogFields({tool:'invented_tool',tools:['invented_tool'],args:{secret:'private'}}),{tools:[]});
});

test('context propagates through async work without leaking between turns', async t => {
  const directory = join(await fixture(t), 'logs');
  const logger = configureLogging(config(directory));
  const first = newTraceId(); const second = newTraceId();
  assert.match(first, /^t_[a-f0-9]{16}$/);
  assert.match(newTraceId('c'), /^c_[a-f0-9]{16}$/);
  assert.notEqual(first, second);
  await Promise.all([first, second].map((turn_id, index) => withLogContext({ turn_id, actor_id: index }, async () => {
    await new Promise(resolve => setTimeout(resolve, 2 - index));
    log('info', 'turn.start');
    withLogContext({ status: 'nested', body: 'private' }, () => log('info', 'tool.start', { tool: 'finish' }));
    log('info', 'turn.end', { actor_id: 10 + index });
  })));
  log('info', 'app.idle');
  await logger.close();
  const rows = await records(directory);
  assert.equal(rows.length, 7);
  for (const [index, id] of [first, second].entries()) {
    const own = rows.filter(row => row.turn_id === id);
    assert.equal(own.length, 3);
    assert.equal(own.find(row => row.event === 'turn.start')?.actor_id, index);
    assert.equal(own.find(row => row.event === 'turn.end')?.actor_id, 10 + index);
    assert.equal(own.find(row => row.event === 'turn.end')?.status, undefined);
  }
  assert.equal(rows.find(row => row.event === 'app.idle')?.turn_id, undefined);
});

test('viewer revalidates untrusted records and ignores freeform messages', () => {
  const raw = { time: '2026-01-01T00:00:00.000Z', level: 'info', event: 'app.start', status: 'ok', msg: 'private', error: { stack: 'private' }, reason: 'has space' };
  assert.equal(formatLogLine(raw), '2026-01-01T00:00:00.000Z INFO  app.start status="ok"');
  assert.equal(formatLogLine(JSON.stringify(raw)), formatLogLine(raw));
  assert.equal(formatLogLine('not json'), undefined);
  assert.equal(formatLogLine({ ...raw, event: 'app.foo\nprivate' }), undefined);
  assert.equal(formatLogLine('x'.repeat(4097)), undefined);
  assert.deepEqual(sanitizeLogFields({ duration_ms: {}, tools: [{}], reply_to: NaN, target_id: Number.MAX_VALUE }), { tools: [] });
  const hostile = new Proxy({}, { get() { throw new Error('private'); } });
  assert.doesNotThrow(() => log('info', 'app.test', hostile));
  assert.deepEqual(sanitizeLogFields(hostile), {});
  let reads = 0;
  const alternating = { get submitted() { return ++reads === 1 ? true : { body: 'private' }; } };
  assert.deepEqual(sanitizeLogFields(alternating), { submitted: true });
  const customArray = ['finish'];
  customArray.slice = () => { throw new Error('must not invoke user method'); };
  assert.deepEqual(sanitizeLogFields({ tools: customArray }), { tools: ['finish'] });
});

test('rotates at size, enforces aggregate cap, and bounds all records', async t => {
  const directory = join(await fixture(t), 'logs');
  const logger = configureLogging(config(directory));
  const fields = { reason: 'a'.repeat(64), status: 'b'.repeat(64), phase: 'c'.repeat(64), outcome: 'd'.repeat(64), trigger: 'e'.repeat(64), tools: Array(32).fill('get_group_members') };
  for (let batch = 0; batch < 8; batch++) {
    for (let i = 0; i < 450; i++) log('info', 'model.complete', fields);
    await logger.flush();
  }
  await logger.close();
  const names = (await readdir(directory)).filter(managedLogFilename);
  assert.ok(names.length >= 2);
  let total = 0;
  for (const name of names) {
    const info = await stat(join(directory, name));
    assert.ok(info.size <= 1024 * 1024);
    total += info.size;
    const text = await readFile(join(directory, name), 'utf8');
    for (const line of text.trim().split('\n')) assert.ok(Buffer.byteLength(line + '\n') <= 4096);
  }
  assert.ok(total <= 2 * 1024 * 1024);
});

test('UTC day rotation and retention only prune owned regular files', async t => {
  const root = await fixture(t); const directory = join(root, 'logs');
  await mkdir(directory);
  const old = 'listener-2020-01-01-T000000000-aaaaaaaaaaaaaaaaaaaaaaaa.jsonl';
  const symlinkName = 'listener-2020-01-01-T000000000-bbbbbbbbbbbbbbbbbbbbbbbb.jsonl';
  await writeFile(join(directory, old), 'old');
  await writeFile(join(root, 'keep'), 'private');
  await symlink(join(root, 'keep'), join(directory, symlinkName));
  await writeFile(join(directory, 'unrelated.jsonl'), 'keep');
  await mkdir(join(directory, 'listener-2020-01-01-T000000000-cccccccccccccccccccccccc.jsonl'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T23:59:59.000Z') });
  const logger = configureLogging(config(directory, { retentionDays: 1 }));
  log('info', 'app.first'); await logger.flush();
  assert.ok((await readdir(directory)).some(name => name.startsWith('listener-2026-01-01')));
  t.mock.timers.setTime(Date.parse('2026-01-02T00:00:01.000Z'));
  log('info', 'app.next'); await logger.close();
  const names = await readdir(directory);
  assert.ok(!names.includes(old));
  assert.ok(!names.some(name => name.startsWith('listener-2026-01-01')));
  assert.ok(names.some(name => name.startsWith('listener-2026-01-02')));
  assert.ok(names.includes(symlinkName));
  assert.equal(await readFile(join(root, 'keep'), 'utf8'), 'private');
  assert.equal(await readFile(join(directory, 'unrelated.jsonl'), 'utf8'), 'keep');
});

test('bad directories and symlink directories safely disable file output', async t => {
  const root = await fixture(t);
  const blocked = join(root, 'not-directory'); await writeFile(blocked, 'keep');
  let logger = configureLogging(config(blocked));
  assert.doesNotThrow(() => log('error', 'app.failure', { error: new Error('private') }));
  await logger.flush(); await logger.close();
  const target = join(root, 'target'); await mkdir(target);
  const link = join(root, 'link'); await symlink(target, link);
  logger = configureLogging(config(link));
  log('info', 'app.test'); await logger.close();
  assert.deepEqual(await readdir(target), []);
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
  assert.throws(() => configureLogging(config(target, { maxFileMb: 2, maxTotalMb: 1 })), /^Error: Invalid logging configuration$/);
});

test('queue overload drops records instead of creating unbounded writes', async t => {
  const directory = join(await fixture(t), 'logs');
  const logger = configureLogging(config(directory));
  for (let i = 0; i < 10000; i++) log('debug', 'app.burst', { count: i });
  await logger.close();
  const rows = await records(directory);
  assert.ok(rows.length > 0 && rows.length <= 1025);
});

test('file failure falls back to readable console and respects minimum level', async t => {
  const root = await fixture(t); const blocked = join(root, 'blocked'); await writeFile(blocked, 'keep');
  const script = `import { configureLogging, log } from './src/logger.ts';
    const logger = configureLogging(${JSON.stringify(config(blocked, { console: true, level: 'warn' }))});
    log('info','app.hidden'); log('warn','app.visible',{status:'ok',body:'private'}); await logger.close(); process.stdout.write('still-open\\n');`;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 5000 });
  assert.match(result.stdout, /WARN  app.visible status="ok"/);
  assert.match(result.stdout, /still-open/);
  assert.ok(!result.stdout.includes('hidden'));
  assert.ok(!result.stdout.includes('private'));
  assert.ok(!result.stderr.includes(blocked));
});

test('close is bounded even when console never completes a write', async () => {
  const script = `import { configureLogging, log } from './src/logger.ts';
    const logger = configureLogging({level:'debug',console:true,file:false,directory:'.',retentionDays:1,maxFileMb:1,maxTotalMb:1});
    process.stdout.write = () => false;
    for(let i=0;i<10000;i++) log('info','app.stalled',{count:i});
    const started=Date.now(); await logger.close();
    if(Date.now()-started > 3000) process.exitCode=1;`;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 5000 });
});

test('real blocked stdout cannot halt disk logging or bounded application shutdown', async t => {
  const directory = join(await fixture(t), 'logs');
  const script = `import { configureLogging, log } from './src/logger.ts';
    const logger=configureLogging(${JSON.stringify(config(directory, { console: true }))});
    for(let i=0;i<1000;i++) log('info','app.burst',{count:i,tools:Array(32).fill('get_group_members')});
    await logger.flush();
    log('info','app.after_stall',{count:1000});
    const started=Date.now();
    await logger.close();
    if(Date.now()-started > 2500) process.exit(2);
    // A library must not forcibly exit its caller or destroy shared stdio.
    // The real application exits after its own bounded shutdown completes.
    process.exit(0);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  // Intentionally never consume stdout: this is a real pipe, not a mocked write.
  child.stderr.resume();
  t.after(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child remained alive with blocked stdout')); }, 3500);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 && signal === null ? resolve() : reject(new Error(`Child exit: ${code}/${signal}`)); });
  });
  const rows = await records(directory);
  assert.equal(rows.length, 1001);
  assert.equal(rows.at(-1)?.event, 'app.after_stall');
});

test('stdout EPIPE cannot escape as an uncaught exception', async () => {
  const script = `import { configureLogging, log } from './src/logger.ts';
    const logger = configureLogging({level:'debug',console:true,file:false,directory:'.',retentionDays:1,maxFileMb:1,maxTotalMb:1});
    process.stdout.destroy(Object.assign(new Error('private'), {code:'EPIPE'}));
    log('error','app.failure'); await logger.close();
    await new Promise(resolve => setImmediate(resolve));`;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 5000 });
  assert.ok(!result.stderr.includes('private'));
});
