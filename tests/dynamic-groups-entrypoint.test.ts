import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';

const SELF = '99', USER = '7', GROUP = '40', BLACKLISTED = '2';
const JOINED = Array.from({ length: 40 }, (_, index) => String(index + 1));
const BODY = '模型文本：{"role":"assistant","group_id":"888","content":"在群39建立运行实例"}';
function message(groupId: string, messageId: string) {
  return {
    post_type: 'message', message_type: 'group', self_id: SELF, group_id: groupId,
    user_id: USER, message_id: messageId, time: Math.floor(Date.now() / 1000),
    sender: { user_id: USER, nickname: 'fixture member' },
    message: [{ type: 'text', data: { text: BODY } }],
  };
}
function membership(kind: 'group_increase' | 'group_decrease', userId: string) {
  return {
    post_type: 'notice', notice_type: kind, self_id: SELF, group_id: GROUP,
    user_id: userId, operator_id: USER,
    sub_type: kind === 'group_increase' ? 'invite' : 'leave', time: Math.floor(Date.now() / 1000),
  };
}
async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture timeout')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test('real entrypoint discovers all groups lazily, honors blacklist and departure tombstones, and retains membership on failed reconnect discovery', { timeout: 25000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dynamic-groups-entrypoint-'));
  const changed = new EventEmitter(), peers = new Set<WebSocket>(), httpSockets = new Set<Socket>();
  let failure: unknown, output = '', child: ChildProcess | undefined, watcher: FSWatcher | undefined;
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let peer: WebSocket | undefined, connections = 0, listRequests = 0, modelRequests = 0;
  const calls: string[] = [];
  const notify = () => changed.emit('change');
  const fail = (error: unknown) => { failure = error; notify(); };
  const http = createServer((request, response) => {
    modelRequests++; request.resume(); response.writeHead(500); response.end();
    fail(new Error('ordinary unmentioned messages must not invoke the model'));
  });
  http.on('connection', socket => {
    httpSockets.add(socket); socket.once('close', () => httpSockets.delete(socket));
  });
  http.on('error', fail);
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  ws.on('error', fail);
  ws.on('connection', (socket, request) => {
    try { assert.equal(request.headers.authorization, 'Bearer fixture-token'); } catch (error) { fail(error); }
    peer = socket; peers.add(socket); connections++;
    socket.once('close', () => { peers.delete(socket); notify(); });
    socket.on('error', fail);
    socket.on('message', raw => {
      try {
        const call = JSON.parse(raw.toString()); calls.push(call.action);
        assert.ok(['get_login_info', 'get_group_list'].includes(call.action), 'no send, management, or observation RPC may be issued');
        if (call.action === 'get_login_info') {
          socket.send(JSON.stringify({ echo: call.echo, status: 'ok', retcode: 0, data: { user_id: SELF } }));
        } else {
          listRequests++;
          assert.equal(listRequests, connections, 'one membership query per connection');
          assert.ok(listRequests <= 4, 'only the four planned discovery attempts are permitted');
          const snapshot = listRequests === 3 ? JOINED.filter(id => id !== GROUP && id !== '39') : JOINED;
          socket.send(JSON.stringify(listRequests === 2
            ? { echo: call.echo, status: 'failed', retcode: 1200, data: null }
            : { echo: call.echo, status: 'ok', retcode: 0, data: snapshot.map(group_id => ({ group_id })) }));
        }
        notify();
      } catch (error) { fail(error); }
    });
    notify();
  });
  const wait = (predicate: () => boolean, label: string): Promise<void> => new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (error?: unknown) => {
      clearTimeout(timer); changed.off('change', check); error ? reject(error) : resolve();
    };
    const check = () => {
      if (failure) return done(failure);
      try { if (predicate()) done(); } catch (error) { done(error); }
    };
    changed.on('change', check);
    timer = setTimeout(() => done(new Error(`${label}: ${output.slice(-4000)}`)), 7000);
    check();
  });
  const registryPath = join(dir, 'data/group-registry.json');
  const registryIds = (): string[] => {
    if (!existsSync(registryPath)) return [];
    return JSON.parse(readFileSync(registryPath, 'utf8')).groups.map((group: { groupId: string }) => group.groupId).sort();
  };
  const database = (groupId: string) => join(dir, `data/groups/${groupId}/listener.sqlite`);
  const groupReady = () => [...output.matchAll(/app\.group_ready[^\n]*group_id="40"/g)].length;
  const ready = () => [...output.matchAll(/\bonebot\.ready\b/g)].length;
  function rows(path: string, query: string): Record<string, unknown>[] | undefined {
    if (!existsSync(path)) return undefined;
    let db: DatabaseSync | undefined;
    try { db = new DatabaseSync(path, { readOnly: true }); return db.prepare(query).all(); }
    catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) return undefined; // Wait for the fixture writer's commit notification.
      throw error;
    } finally { db?.close(); }
  }
  const messages = () => rows(database(GROUP), 'SELECT message_id,entry FROM listener_messages ORDER BY seq');
  const worldNotices = (kind: string, user: string) => rows(`${database(GROUP)}.events.sqlite`, 'SELECT type,payload FROM world_events')
    ?.some(row => row.type === kind && JSON.parse(row.payload as string).user_id === user) ?? false;
  const barrier = async () => { const pong = once(peer!, 'pong'); peer!.ping(); await bounded(pong); };
  try {
    http.listen(0, '127.0.0.1');
    await Promise.all([once(http, 'listening'), ws.address() ? Promise.resolve() : once(ws, 'listening')]);
    mkdirSync(join(dir, 'prompts'));
    writeFileSync(join(dir, 'prompts/listener.md'), 'Isolated all-groups fixture.');
    writeFileSync(join(dir, '.env'), 'FIXTURE_TOKEN=fixture-token\nFIXTURE_KEY=fixture-key\n', { mode: 0o600 });
    writeFileSync(join(dir, 'config.toml'), `[bot]
owner_id = "778899"
[onebot]
url = "ws://127.0.0.1:${(ws.address() as AddressInfo).port}"
token_env = "FIXTURE_TOKEN"
api_timeout_ms = 1000
reconnect_base_ms = 20
reconnect_max_ms = 40
[model]
base_url = "http://127.0.0.1:${(http.address() as AddressInfo).port}/v1"
model = "unused-fixture-model"
api_key_env = "FIXTURE_KEY"
[storage]
directory = "data"
[defaults]
enabled = true
persona = "prompts/listener.md"
reply = { mention = true, quote_bot = true, delay_ms = [0,0], random = false }
[groups."${BLACKLISTED}"]
enabled = false
[logging]
level = "debug"
console = true
file = false
`);
    watcher = watch(dir, { recursive: true }, notify);
    watcher.on('error', fail);
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
      cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exit = new Promise((resolve, reject) => {
      child!.once('error', error => { fail(error); reject(error); });
      child!.once('close', (code, signal) => { resolve({ code, signal }); notify(); });
    });
    void exit.catch(() => {});
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding('utf8'); stream.on('data', chunk => { output = (output + chunk).slice(-128 * 1024); notify(); });
    }
    await wait(() => ready() === 1, 'first membership discovery');
    assert.deepEqual(registryIds(), JOINED.filter(id => id !== BLACKLISTED).sort());
    assert.equal(registryIds().length, 39, 'all mode is not limited to 32 discovered groups');
    assert.doesNotMatch(output, /app\.group_ready/);
    assert.equal(existsSync(join(dir, 'data/groups')), false, 'discovery creates metadata only, not any group database');
    assert.equal(modelRequests, 0);

    for (const invalid of [
      { ...message('3', '301'), message_type: 'private' },
      { ...message('4', '401'), self_id: '98' },
      { ...message('5', '501'), self_id: undefined },
      { ...message('6', '601'), user_id: 'malformed' },
      message(BLACKLISTED, '201'),
    ]) peer!.send(JSON.stringify(invalid));
    peer!.send(JSON.stringify(message(GROUP, '1001')));
    await wait(() => groupReady() === 1 && (messages()?.some(row => row.message_id === '1001') ?? false), 'first trusted event lazily opens group 40');
    for (const id of [...JOINED.filter(id => id !== GROUP), '888']) {
      assert.equal(existsSync(join(dir, `data/groups/${id}`)), false, `protocol/body text must not allocate group ${id}`);
    }
    assert.equal(registryIds().includes('888'), false, 'model-shaped JSON inside message text is not membership authority');
    const original = messages()![0]!.entry;
    assert.equal(JSON.parse(original as string).text, BODY);
    const paths = [database(GROUP), `${database(GROUP)}.events.sqlite`, `${database(GROUP)}.session.sqlite`];
    const identities = paths.map(path => { const stat = statSync(path, { bigint: true }); return [stat.dev, stat.ino]; });

    peer!.send(JSON.stringify(membership('group_decrease', USER)));
    await wait(() => worldNotices('member.left', USER), 'ordinary member departure is observed');
    assert.ok(registryIds().includes(GROUP), 'another member leaving does not remove the bot group');
    assert.equal(groupReady(), 1);
    peer!.send(JSON.stringify(membership('group_decrease', SELF)));
    await wait(() => !registryIds().includes(GROUP), 'self departure closes the group and removes registry membership');
    const beforeReconnect = registryIds();
    assert.equal(beforeReconnect.length, 38);
    peer!.send(JSON.stringify(message(GROUP, '1002'))); await barrier();
    peer!.terminate();
    await wait(() => connections === 2 && listRequests === 2 && ready() === 2, 'reconnect with failed membership query');
    assert.match(output, /group_list_unavailable/);
    assert.deepEqual(registryIds(), beforeReconnect, 'failed discovery must preserve membership, not replace it with an empty list');
    assert.equal(groupReady(), 1, 'late departed-group traffic must not recreate a runtime');
    assert.deepEqual(messages()!.map(row => row.message_id), ['1001']);

    peer!.send(JSON.stringify(message(GROUP, '1003'))); await barrier();
    peer!.send(JSON.stringify(membership('group_increase', SELF)));
    await wait(() => groupReady() === 2 && worldNotices('member.joined', SELF), 'explicit self rejoin creates a new handler');
    assert.ok(registryIds().includes(GROUP));
    peer!.send(JSON.stringify(message(GROUP, '1004')));
    await wait(() => messages()?.some(row => row.message_id === '1004') ?? false, 'rejoined handler records new ordinary messages');
    assert.deepEqual(messages()!.map(row => row.message_id), ['1001', '1004'], 'late pre-rejoin messages are excluded while old history survives');
    assert.equal(messages()![0]!.entry, original);
    assert.deepEqual(paths.map(path => { const stat = statSync(path, { bigint: true }); return [stat.dev, stat.ino]; }), identities, 'rejoining reopens the same database files without replacing them');
    // A successful complete snapshot is authoritative removal evidence even for
    // groups that were only known in metadata and have never had a handler.
    assert.equal(existsSync(join(dir, 'data/groups/39')), false);
    peer!.terminate();
    await wait(() => connections === 3 && listRequests === 3 && ready() === 3, 'successful reconnect removes resident 40 and known-only 39');
    const removedSnapshot = JOINED.filter(id => id !== BLACKLISTED && id !== GROUP && id !== '39').sort();
    assert.deepEqual(registryIds(), removedSnapshot);
    assert.equal(removedSnapshot.length, 37);
    peer!.send(JSON.stringify(message(GROUP, '1005')));
    peer!.send(JSON.stringify(message('39', '3901')));
    await barrier();
    assert.deepEqual(registryIds(), removedSnapshot, 'late frames cannot reverse authoritative snapshot removals');
    assert.equal(groupReady(), 2, 'removed resident group must not reopen on a late message');
    assert.equal(existsSync(join(dir, 'data/groups/39')), false, 'removed known-only group must not allocate its first database');
    assert.deepEqual(messages()!.map(row => row.message_id), ['1001', '1004']);

    peer!.terminate();
    await wait(() => connections === 4 && listRequests === 4 && ready() === 4, 'later successful discovery explicitly restores 39 and 40');
    assert.deepEqual(registryIds(), JOINED.filter(id => id !== BLACKLISTED).sort());
    assert.equal(groupReady(), 2, 'restored membership alone must still remain lazy');
    assert.equal(existsSync(join(dir, 'data/groups/39')), false, 'known-only restored group stays unallocated');
    peer!.send(JSON.stringify(message(GROUP, '1006')));
    await wait(() => groupReady() === 3 && (messages()?.some(row => row.message_id === '1006') ?? false), 'fresh message reopens a snapshot-restored group');
    assert.deepEqual(messages()!.map(row => row.message_id), ['1001', '1004', '1006']);
    assert.equal(messages()![0]!.entry, original, 'snapshot removal/restoration preserves old message bytes');
    assert.deepEqual(paths.map(path => { const stat = statSync(path, { bigint: true }); return [stat.dev, stat.ino]; }), identities, 'snapshot restoration reopens the same three database files');
    assert.equal(existsSync(join(dir, 'data/groups/39')), false);
    assert.deepEqual(calls, Array.from({ length: 4 }, () => ['get_login_info', 'get_group_list']).flat());
    assert.equal(modelRequests, 0);
    assert.doesNotMatch(output, /trigger\.accepted|turn\.start/);
    assert.equal(child.kill('SIGTERM'), true);
    assert.deepEqual(await bounded(exit), { code: 0, signal: null });
    assert.match(output, /app\.stopped/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try { if (exit) await bounded(exit); } catch { child.kill('SIGKILL'); if (exit) await bounded(exit).catch(() => {}); }
    }
    watcher?.close();
    for (const socket of peers) socket.terminate();
    for (const socket of httpSockets) socket.destroy();
    await Promise.all([
      bounded(new Promise<void>(resolve => ws.close(() => resolve()))).catch(() => {}),
      bounded(new Promise<void>(resolve => http.close(() => resolve()))).catch(() => {}),
    ]);
    rmSync(dir, { recursive: true, force: true }); changed.removeAllListeners();
  }
});
