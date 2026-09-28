import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { LogReader, parseLogArgs } from '../src/cli/logs.js';
import { managedLogFilename } from '../src/observability/logger.js';

const turn = 't_0123456789abcdef';
const otherTurn = 't_fedcba9876543210';
const name = (index: number) => `listener-2026-04-01-T00000000${index}-${'a'.repeat(24)}.jsonl`;
const options = { level: 'debug' as const, lines: 100 };
const row = (count: number, extra: Record<string, unknown> = {}) => JSON.stringify({ time: '2026-04-01T00:00:00.000Z', level: 'info', event: 'turn.complete', count, ...extra }) + '\n';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'listener-view-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function counts(lines: string[]) { return lines.map(line => Number(/(?:^| )count=(\d+)(?: |$)/.exec(line)?.[1])); }

test('log arguments parse defaults and all supported flags', () => {
  assert.deepEqual(parseLogArgs([]), { follow: false, level: 'debug', lines: 100, help: false });
  assert.deepEqual(parseLogArgs(['--follow', '--level', 'warn', '--turn', turn, '--lines', '37', '--directory', './data/logs', '--help']), {
    follow: true, level: 'warn', turn, lines: 37, directory: resolve('./data/logs'), help: true,
  });
  for (const level of ['debug', 'info', 'warn', 'error']) assert.equal(parseLogArgs(['--level', level]).level, level);
  assert.equal(parseLogArgs(['--lines', '1000']).lines, 1000);
});

test('invalid, repeated, missing, and injection-like arguments are rejected safely', () => {
  for (const args of [
    ['--unknown'], ['--follow', '--follow'], ['--level'], ['--directory'], ['--lines'], ['--turn'],
    ['--level', 'fatal'], ['--level', 'constructor'], ['--level', 'INFO'], ['--level', '--follow'],
    ['--lines', '0'], ['--lines', '-1'], ['--lines', '1001'], ['--lines', '1.5'], ['--lines', 'Infinity'],
    ['--turn', otherTurn + '\nprivate'], ['--turn', 'c_0123456789abcdef'], ['--turn', 'private'],
    ['--lines', '2', '--lines', '3'], ['--directory', ''], ['private'],
  ]) {
    assert.throws(() => parseLogArgs(args), error => error instanceof Error && /^Invalid (log arguments|log level|turn id|line count)$/.test(error.message), JSON.stringify(args));
  }
});

test('snapshot returns last N matching records across owned files and then no duplicates', async t => {
  const root = await fixture(t);
  assert.ok(managedLogFilename(name(1)));
  await writeFile(join(root, name(1)), row(1, { level: 'warn', turn_id: turn }) + row(2, { level: 'error', turn_id: turn }));
  await writeFile(join(root, name(2)), row(3, { level: 'debug', turn_id: turn }) + row(4, { level: 'error', turn_id: otherTurn }) + row(5, { level: 'warn', turn_id: turn }) + row(6, { level: 'error', turn_id: turn }));
  await writeFile(join(root, 'unrelated.jsonl'), row(999, { level: 'error', turn_id: turn }));
  const reader = new LogReader(root, { level: 'warn', turn, lines: 3 });
  assert.deepEqual(counts(await reader.scan(true)), [2, 5, 6]);
  assert.deepEqual(await reader.scan(), []);
  assert.deepEqual(await reader.scan(), []);
});

test('follow buffers partial JSON and split UTF8 bytes until newline, discovers rotations once', async t => {
  const root = await fixture(t); const path = join(root, name(1));
  await writeFile(path, row(1));
  const reader = new LogReader(root, options);
  assert.deepEqual(counts(await reader.scan(true)), [1]);
  const next = Buffer.from(row(2, { content: '中文私密', turn_id: turn }));
  const split = next.indexOf(Buffer.from('中')) + 1;
  await appendFile(path, next.subarray(0, split));
  assert.deepEqual(await reader.scan(), []);
  await appendFile(path, next.subarray(split, next.length - 1));
  assert.deepEqual(await reader.scan(), []);
  await appendFile(path, next.subarray(next.length - 1));
  const lines = await reader.scan();
  assert.deepEqual(counts(lines), [2]);
  assert.ok(!lines.join('').includes('私密'));
  assert.ok(!lines.join('').includes('\ufffd'));
  assert.deepEqual(await reader.scan(), []);
  await appendFile(path, row(3));
  await writeFile(join(root, name(2)), row(4));
  assert.deepEqual(counts(await reader.scan()), [3, 4]);
  assert.deepEqual(await reader.scan(), []);
  await rm(path);
  await appendFile(join(root, name(2)), row(5));
  assert.deepEqual(counts(await reader.scan()), [5]);
});

test('follow tolerates truncation and replacement without repeating old records', async t => {
  const root = await fixture(t); const path = join(root, name(1));
  await writeFile(path, row(1) + row(2));
  const reader = new LogReader(root, options);
  assert.deepEqual(counts(await reader.scan(true)), [1, 2]);
  await writeFile(path, row(3));
  assert.deepEqual(counts(await reader.scan()), [3]);
  assert.deepEqual(await reader.scan(), []);
  // Keep the original inode alive so replacement cannot reuse its inode number.
  const { rename } = await import('node:fs/promises');
  await rename(path, join(root, 'old-unowned'));
  await writeFile(path, row(4));
  assert.deepEqual(counts(await reader.scan()), [4]);
  assert.deepEqual(await reader.scan(), []);
});

test('malformed and injected raw fields are never printed', async t => {
  const root = await fixture(t);
  const malicious = { body: 'private-body', msg: 'private-msg', content: 'private-content', headers: { Authorization: 'private-token' }, err: { stack: 'private-stack' }, card: 'private-card', confirmationcode: 'private-code', url: 'https://private.example/path', status: 'private status', tool: 'private-tool', tools: ['private-tool', 'finish'] };
  await writeFile(join(root, name(1)), [
    'private-malformed\n', 'null\n', '[]\n', '42\n',
    row(1, malicious), row(2, { event: 'app.event\nprivate-injection' }),
    row(3, { level: 'constructor' }), row(4, { time: 'private-time' }),
    row(5, { event: 'unknown.event' }), row(6, { ...malicious, event: 'app.valid', level: 'error' }),
    'x'.repeat(9000) + '\n', row(7, { event: 'app.last' }),
  ].join(''));
  const lines = await new LogReader(root, options).scan(true);
  assert.deepEqual(counts(lines), [1, 6, 7]);
  assert.ok(!lines.join('\n').includes('private'));
  assert.ok(lines[0]!.includes('tools=["finish"]'));
});

test('owned symlink files and directories are skipped, final directory symlink is rejected', async t => {
  const root = await fixture(t); const directory = join(root, 'logs'); await mkdir(directory);
  const target = join(root, 'private.jsonl'); await writeFile(target, row(999));
  await symlink(target, join(directory, name(1)));
  await mkdir(join(directory, name(2)));
  await writeFile(join(directory, name(3)), row(3));
  assert.deepEqual(counts(await new LogReader(directory, options).scan(true)), [3]);
  const link = join(root, 'linked-logs'); await symlink(directory, link);
  await assert.rejects(new LogReader(link, options).scan(true), /^Error: Log directory unavailable$/);
  assert.deepEqual(await new LogReader(join(root, 'missing'), options).scan(true), []);
});

test('viewer exits on SIGTERM with actual unread stdout pipe', async t => {
  const root = await fixture(t);
  for (let file = 0; file < 4; file++) {
    await writeFile(join(root, name(file)), Array.from({ length: 250 }, (_, index) => row(file * 250 + index, { tools: Array(32).fill('get_group_members') })).join(''));
  }
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/cli/logs.ts'), '--directory', root, '--follow', '--lines', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  // 'readable' observes availability without consuming any bytes from stdout.
  let signalTimer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.once('readable', () => { signalTimer = setTimeout(() => child.kill('SIGTERM'), 250); });
  t.after(() => { if (signalTimer) clearTimeout(signalTimer); child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Viewer remained alive with blocked stdout')); }, 3500);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(deadline); code === 0 && signal === null ? resolve() : reject(new Error(`Viewer exit: ${code}/${signal}`)); });
  });
});

test('CLI help works without loading a config or printing raw paths', async t => {
  const root = await fixture(t);
  const executable = resolve('src/cli/logs.ts');
  const tsxLoader = import.meta.resolve('tsx');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', tsxLoader, executable, '--help'], { cwd: root, timeout: 5000 });
  assert.match(stdout, /--follow/);
  assert.match(stdout, /--level/);
  assert.match(stdout, /--turn/);
  assert.match(stdout, /--lines/);
  assert.match(stdout, /--directory/);
  assert.equal(stderr, '');
  assert.ok(!stdout.includes(root));
});
