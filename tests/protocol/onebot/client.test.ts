import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { OneBotClient } from '../../../src/onebot/client.ts';

async function fixture(
  handler?: (ws: WebSocket, packet: any) => void,
  heartbeatMs = 1000,
  loginData: (connection: number) => unknown = () => ({ user_id: 1 }),
) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) {
    throw new Error('Missing address');
  }
  let connections = 0;
  let socket: WebSocket;
  server.on('connection', (ws, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    connections++;
    socket = ws;
    ws.on('message', (raw) => {
      const packet = JSON.parse(raw.toString());
      if (packet.action === 'get_login_info') {
        ws.send(
          JSON.stringify({
            echo: packet.echo,
            status: 'ok',
            retcode: 0,
            data: loginData(connections),
          }),
        );
      } else {
        handler?.(ws, packet);
      }
    });
  });
  const client = new OneBotClient({
    url: `ws://127.0.0.1:${address.port}`,
    token: 'test-token',
    apiTimeoutMs: 80,
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    heartbeatMs,
  });
  const ready = once(client, 'ready');
  client.start();
  await ready;
  return {
    client,
    get socket() {
      return socket!;
    },
    get connections() {
      return connections;
    },
    async close() {
      await client.stop();
      for (const ws of server.clients) {
        ws.terminate();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test('successful void wire responses normalize omitted data without losing valid falsy payloads', async () => {
  const values: Record<string, unknown> = {
    omitted: undefined,
    nil: null,
    no: false,
    zero: 0,
    empty: '',
    object: { value: 1 },
  };
  const f = await fixture((ws, p) => {
    const wire = JSON.stringify({
      echo: p.echo,
      status: 'ok',
      retcode: 0,
      data: values[p.action],
    });
    if (p.action === 'omitted') {
      assert.equal(Object.hasOwn(JSON.parse(wire), 'data'), false);
    }
    ws.send(wire);
  });
  try {
    for (const [action, value] of Object.entries(values)) {
      assert.deepEqual(await f.client.call(action), value ?? null);
    }
  } finally {
    await f.close();
  }
});

test('missing data never turns a failed or malformed envelope into success', async () => {
  const replies: Record<string, object> = {
    failed: { status: 'failed', retcode: 1200 },
    failedZero: { status: 'failed', retcode: 0 },
    nonzero: { status: 'ok', retcode: 1 },
    stringCode: { status: 'ok', retcode: '0' },
    missingStatus: { retcode: 0 },
    missingCode: { status: 'ok' },
  };
  const f = await fixture((ws, p) =>
    ws.send(JSON.stringify({ echo: p.echo, ...replies[p.action] })),
  );
  try {
    for (const action of Object.keys(replies)) {
      await assert.rejects(f.client.call(action), /OneBot API failed/);
    }
  } finally {
    await f.close();
  }
});

test(
  'auth header, login, concurrent reversed echo correlation and API errors',
  { timeout: 3000 },
  async () => {
    const packets: any[] = [];
    const f = await fixture((ws, p) => {
      if (p.action === 'bad') {
        ws.send(
          JSON.stringify({
            echo: p.echo,
            status: 'failed',
            retcode: 100,
            wording: 'secret payload',
          }),
        );
      } else {
        packets.push(p);
        if (packets.length === 2) {
          for (const packet of packets.reverse()) {
            ws.send(
              JSON.stringify({
                echo: packet.echo,
                status: 'ok',
                retcode: 0,
                data: packet.action,
              }),
            );
          }
        }
      }
    });
    try {
      assert.deepEqual(
        await Promise.all([f.client.call('first'), f.client.call('second')]),
        ['first', 'second'],
      );
      await assert.rejects(f.client.call('bad'), {
        message: 'OneBot API failed',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'timeouts never retry and late/unknown responses are ignored',
  { timeout: 3000 },
  async () => {
    let sends = 0;
    const f = await fixture((ws, p) => {
      sends++;
      ws.send(JSON.stringify({ echo: 'unknown', status: 'ok', retcode: 0 }));
      ws.send('{invalid');
    });
    try {
      await assert.rejects(f.client.call('ignored'), /timeout/);
      assert.equal(sends, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'disconnect rejects pending and reconnect authenticates again',
  { timeout: 3000 },
  async () => {
    const f = await fixture();
    try {
      const pending = assert.rejects(f.client.call('pending'), /disconnected/);
      const ready = once(f.client, 'ready');
      f.socket.terminate();
      await pending;
      await ready;
      assert.equal(f.connections, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  'in-flight requests are bounded and stop rejects all without reconnect',
  { timeout: 3000 },
  async () => {
    const f = await fixture();
    try {
      const calls = Array.from({ length: 64 }, () =>
        assert.rejects(f.client.call('pending'), /stopped/),
      );
      await assert.rejects(f.client.call('overflow'), /busy/);
      await f.client.stop();
      await Promise.all(calls);
      await assert.rejects(f.client.call('offline'), /unavailable/);
    } finally {
      await f.close();
    }
  },
);

test(
  'invalid login identities reconnect without announcing ready until valid',
  { timeout: 3000 },
  async () => {
    const invalid = [
      null,
      {},
      [],
      { user_id: 0 },
      { user_id: -1 },
      { user_id: 1.5 },
      { user_id: Number.MAX_SAFE_INTEGER + 1 },
      { user_id: '' },
      { user_id: '0' },
      { user_id: '01' },
      { user_id: '-1' },
      { user_id: 'not-an-id' },
    ];
    const f = await fixture(undefined, 1000, (connection) =>
      connection <= invalid.length
        ? invalid[connection - 1]
        : { user_id: '123' },
    );
    try {
      // fixture waits for the FIRST ready event; any invalid ready would return too soon.
      assert.equal(f.connections, invalid.length + 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'real WebSocket keeps reaction notices separate from chat and unknown events',
  { timeout: 3000 },
  async () => {
    const f = await fixture();
    const notices: unknown[] = [],
      messages: unknown[] = [];
    f.client.on('notice', (packet) => notices.push(packet));
    f.client.on('message', (packet) => messages.push(packet));
    try {
      const reaction = {
        post_type: 'notice',
        notice_type: 'group_msg_emoji_like',
        group_id: '10',
        message_id: '20',
        likes: [{ emoji_id: '76', count: 3 }],
        is_add: true,
      };
      for (const packet of [
        { post_type: 'notice', notice_type: 'unrecognized_group_notice' },
        { post_type: 'notice', notice_type: 'friend_msg_emoji_like' },
        { post_type: 'meta_event', meta_event_type: 'heartbeat' },
        { ...reaction, echo: 'unknown-response' },
        reaction,
      ]) {
        f.socket.send(JSON.stringify(packet));
      }
      const delivered = once(f.client, 'message');
      const chat = {
        post_type: 'message',
        message_type: 'group',
        group_id: '10',
        message_id: '21',
      };
      f.socket.send(JSON.stringify(chat));
      await delivered;
      assert.deepEqual(notices, [reaction]);
      assert.deepEqual(
        messages,
        [chat],
        'reaction notices never masquerade as chat messages',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'real WebSocket forwards all supported group metadata notices but no invented announcements',
  { timeout: 3000 },
  async () => {
    const f = await fixture(),
      notices: unknown[] = [],
      messages: unknown[] = [];
    f.client.on('notice', (event) => notices.push(event));
    f.client.on('message', (event) => messages.push(event));
    try {
      const base = {
        post_type: 'notice',
        group_id: '10',
        self_id: '1',
        user_id: '100',
      };
      const expected = [
        {
          ...base,
          notice_type: 'group_increase',
          sub_type: 'approve',
          operator_id: '200',
        },
        {
          ...base,
          notice_type: 'group_decrease',
          sub_type: 'kick',
          operator_id: '200',
        },
        {
          ...base,
          notice_type: 'group_ban',
          sub_type: 'ban',
          duration: 60,
          operator_id: '200',
        },
        {
          ...base,
          notice_type: 'group_upload',
          file: {
            id: 'private-transport-id',
            name: 'report.txt',
            size: 50,
            busid: 102,
          },
        },
        {
          ...base,
          notice_type: 'notify',
          sub_type: 'group_name',
          name_new: 'new group',
        },
        {
          ...base,
          notice_type: 'group_recall',
          message_id: '20',
          operator_id: '200',
        },
        { ...base, notice_type: 'notify', sub_type: 'poke', target_id: '1' },
      ];
      for (const packet of [
        ...expected,
        { ...base, notice_type: 'notify', sub_type: 'group_announcement' },
        { ...base, notice_type: 'group_notice' },
        { ...base, notice_type: 'friend_add' },
      ]) {
        f.socket.send(JSON.stringify(packet));
      }
      const barrier = once(f.client, 'message');
      f.socket.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'group',
          group_id: '10',
          message_id: '21',
        }),
      );
      await barrier;
      assert.deepEqual(notices, expected);
      assert.equal(messages.length, 1);
    } finally {
      await f.close();
    }
  },
);

test('missing pong triggers reconnect', { timeout: 3000 }, async () => {
  const f = await fixture(undefined, 20);
  try {
    // ws exposes autoPong as a construction option; mutate only in this mock peer.
    (f.socket as any)._autoPong = false;
    await once(f.client, 'ready');
    assert.equal(f.connections, 2);
  } finally {
    await f.close();
  }
});
