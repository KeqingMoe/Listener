import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { OneBotClient } from '../src/client.js';

async function fixture(handler?: (ws: WebSocket, packet: any) => void, heartbeatMs = 1000, loginData: (connection: number) => unknown = () => ({ user_id: 1 })) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Missing address');
  let connections = 0;
  let socket: WebSocket;
  server.on('connection', (ws, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    connections++;
    socket = ws;
    ws.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action === 'get_login_info') ws.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: loginData(connections) }));
      else handler?.(ws, packet);
    });
  });
  const client = new OneBotClient({ url: `ws://127.0.0.1:${address.port}`, token: 'test-token', apiTimeoutMs: 80, reconnectBaseMs: 10, reconnectMaxMs: 20, heartbeatMs });
  const ready = once(client, 'ready');
  client.start();
  await ready;
  return { client, get socket() { return socket!; }, get connections() { return connections; }, async close() {
    await client.stop();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('auth header, login, concurrent reversed echo correlation and API errors', { timeout: 3000 }, async () => {
  const packets: any[] = [];
  const f = await fixture((ws, p) => {
    if (p.action === 'bad') ws.send(JSON.stringify({ echo: p.echo, status: 'failed', retcode: 100, wording: 'secret payload' }));
    else {
      packets.push(p);
      if (packets.length === 2) for (const packet of packets.reverse()) ws.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: packet.action }));
    }
  });
  try {
    assert.deepEqual(await Promise.all([f.client.call('first'), f.client.call('second')]), ['first', 'second']);
    await assert.rejects(f.client.call('bad'), { message: 'OneBot API failed' });
  } finally { await f.close(); }
});

test('timeouts never retry and late/unknown responses are ignored', { timeout: 3000 }, async () => {
  let sends = 0;
  const f = await fixture((ws, p) => {
    sends++;
    ws.send(JSON.stringify({ echo: 'unknown', status: 'ok', retcode: 0 }));
    ws.send('{invalid');
  });
  try {
    await assert.rejects(f.client.call('ignored'), /timeout/);
    assert.equal(sends, 1);
  } finally { await f.close(); }
});

test('disconnect rejects pending and reconnect authenticates again', { timeout: 3000 }, async () => {
  const f = await fixture();
  try {
    const pending = assert.rejects(f.client.call('pending'), /disconnected/);
    const ready = once(f.client, 'ready');
    f.socket.terminate();
    await pending;
    await ready;
    assert.equal(f.connections, 2);
  } finally { await f.close(); }
});

test('in-flight requests are bounded and stop rejects all without reconnect', { timeout: 3000 }, async () => {
  const f = await fixture();
  try {
    const calls = Array.from({ length: 64 }, () => assert.rejects(f.client.call('pending'), /stopped/));
    await assert.rejects(f.client.call('overflow'), /busy/);
    await f.client.stop();
    await Promise.all(calls);
    await assert.rejects(f.client.call('offline'), /unavailable/);
  } finally { await f.close(); }
});

test('invalid login identities reconnect without announcing ready until valid', { timeout: 3000 }, async () => {
  const invalid = [null, {}, [], { user_id: 0 }, { user_id: -1 }, { user_id: 1.5 },
    { user_id: Number.MAX_SAFE_INTEGER + 1 }, { user_id: '' }, { user_id: '0' },
    { user_id: '01' }, { user_id: '-1' }, { user_id: 'not-an-id' }];
  const f = await fixture(undefined, 1000, connection => connection <= invalid.length ? invalid[connection - 1] : { user_id: '123' });
  try {
    // fixture waits for the FIRST ready event; any invalid ready would return too soon.
    assert.equal(f.connections, invalid.length + 1);
  } finally { await f.close(); }
});

test('missing pong triggers reconnect', { timeout: 3000 }, async () => {
  const f = await fixture(undefined, 20);
  try {
    // ws exposes autoPong as a construction option; mutate only in this mock peer.
    (f.socket as any)._autoPong = false;
    await once(f.client, 'ready');
    assert.equal(f.connections, 2);
  } finally { await f.close(); }
});
