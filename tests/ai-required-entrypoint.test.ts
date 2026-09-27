import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

test('model settings are mandatory before connecting; maintenance commands do not need an available model', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'required-model-entrypoint-'));
  const changes = new EventEmitter(), sockets = new Set<Socket>(), peers = new Set<WebSocket>();
  let requests = 0, connections = 0, sends = 0, failure: unknown, output = '';
  let peer: WebSocket | undefined, child: ChildProcess | undefined, exit: Promise<number | null> | undefined;
  const notify = () => changes.emit('change');
  const http = createServer((_request, response) => { requests++; response.writeHead(503); response.end('fixture unavailable'); notify(); });
  http.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  ws.on('connection', socket => {
    connections++; peer = socket; peers.add(socket); socket.on('close', () => peers.delete(socket));
    socket.on('message', raw => {
      try {
        const call = JSON.parse(raw.toString());
        let data: unknown;
        if (call.action === 'get_login_info') data = { user_id: '99' };
        else if (call.action === 'get_group_list') data = ['11', '22', '33', '44'].map(group_id => ({ group_id }));
        else {
          assert.equal(call.action, 'send_group_msg', 'maintenance must not perform any other mutation');
          assert.ok(['11', '22', '33', '44'].includes(String(call.params.group_id)));
          sends++; data = { message_id: String(9000 + sends) };
        }
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: call.echo }));
      } catch (error) { failure = error; }
      notify();
    });
    notify();
  });
  const wait = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => { clearTimeout(timer); changes.off('change', check); error ? reject(error) : resolve(); };
    const check = () => { if (failure) finish(failure); else if (predicate()) finish(); };
    const timer = setTimeout(() => finish(Error(`fixture timeout: ${output.slice(-3000)}`)), 8000);
    changes.on('change', check); check();
  });
  const start = () => {
    output = '';
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
      cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exit = new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', code => { resolve(code); notify(); }); });
    void exit.catch(error => { failure = error; notify(); });
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { output += chunk.toString(); notify(); });
    return exit;
  };
  try {
    http.listen(0, '127.0.0.1');
    await Promise.all([once(http, 'listening'), ws.address() ? Promise.resolve() : once(ws, 'listening')]);
    mkdirSync(join(dir, 'prompts')); writeFileSync(join(dir, 'prompts/listener.md'), 'Synthetic maintenance fixture.');
    const source = `[bot]\nowner_id="778899"\n[onebot]\nurl="ws://127.0.0.1:${(ws.address() as AddressInfo).port}"\ntoken_env="FIXTURE_TOKEN"\n[model]\nbase_url="http://127.0.0.1:${(http.address() as AddressInfo).port}/v1"\nmodel="fixture-model"\napi_key_env="FIXTURE_KEY"\n[defaults]\nenabled=true\n[groups."11"]\nenabled=true\n[logging]\nlevel="debug"\n`;
    for (const invalid of [
      { config: source, secrets: 'FIXTURE_TOKEN=PRIVATE_TEST_TOKEN\n', field: 'model.api_key_env' },
      { config: source.replace('model="fixture-model"', 'model=""'), secrets: 'FIXTURE_TOKEN=PRIVATE_TEST_TOKEN\nFIXTURE_KEY=PRIVATE_TEST_KEY\n', field: 'model.model' },
      { config: source + '[runtime]\nai_enabled=false\n', secrets: 'FIXTURE_TOKEN=PRIVATE_TEST_TOKEN\nFIXTURE_KEY=PRIVATE_TEST_KEY\n', field: 'runtime' },
    ]) {
      writeFileSync(join(dir, 'config.toml'), invalid.config);
      writeFileSync(join(dir, '.env'), invalid.secrets, { mode: 0o600 });
      assert.equal(await start(), 1);
      assert.ok(output.includes(invalid.field));
      assert.doesNotMatch(output, /PRIVATE_TEST/);
      assert.equal(connections, 0); assert.equal(requests, 0);
      assert.equal(existsSync(join(dir, 'data')), false);
    }
    writeFileSync(join(dir, 'config.toml'), source);
    start(); await wait(() => output.includes('onebot.ready'));
    for (const [index, text] of ['/ping', '/help', '/reset', '/confirm ' + '0'.repeat(32)].entries()) {
      peer!.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: ['11', '22', '33', '44'][index], self_id: '99', user_id: '778899', message_id: String(index + 1), time: Math.floor(Date.now() / 1000), sender: { nickname: 'Fixture owner' }, message: [{ type: 'text', data: { text } }] }));
      await wait(() => (output.match(/\bcommand\.end\b/g) ?? []).length === index + 1);
    }
    assert.equal(sends, 4); assert.equal(requests, 0, 'commands bypass the deliberately unavailable model endpoint');
    for (const suffix of ['', '.events.sqlite', '.session.sqlite']) assert.equal(existsSync(join(dir, 'data/groups/11/listener.sqlite' + suffix)), true);
    assert.equal(child!.kill('SIGTERM'), true); assert.equal(await exit, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit?.catch(() => {}); }
    for (const socket of peers) socket.terminate(); for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => ws.close(() => resolve())), new Promise<void>(resolve => http.close(() => resolve()))]);
    rmSync(dir, { recursive: true, force: true }); changes.removeAllListeners();
  }
});
