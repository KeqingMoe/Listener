import test from 'node:test';
import { sendChatStream } from '../../support/model-sse.ts';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
import { LISTENER_GROUP } from '../../../src/contracts/identity.ts';

const GROUP = LISTENER_GROUP,
  OTHER = '22',
  DISABLED = '33',
  SELF = '99999';

async function bounded<T>(promise: Promise<T>, ms = 6000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'wire group metadata persists by scope without waking and is exposed only after explicit observation',
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-notice-entrypoint-'));
    const changed = new EventEmitter(),
      peers = new Set<WebSocket>(),
      sockets = new Set<Socket>();
    let child: ChildProcess | undefined,
      exit:
        | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
        | undefined,
      peer: WebSocket | undefined;
    let output = '',
      failure: unknown,
      modelCalls = 0;
    const calls: string[] = [],
      notify = () => changed.emit('change'),
      fail = (error: unknown) => {
        failure = error;
        notify();
      };
    const base = {
      post_type: 'notice',
      group_id: GROUP,
      self_id: SELF,
      user_id: '111',
      time: Math.floor(Date.now() / 1000),
    };
    const notices = [
      {
        ...base,
        notice_type: 'group_increase',
        sub_type: 'approve',
        operator_id: '222',
      },
      {
        ...base,
        notice_type: 'group_decrease',
        sub_type: 'kick',
        operator_id: '222',
      },
      {
        ...base,
        notice_type: 'group_ban',
        sub_type: 'ban',
        user_id: 0,
        duration: 0,
        operator_id: '222',
      },
      {
        ...base,
        notice_type: 'group_upload',
        event_id: 'upload-one',
        file: {
          id: 'PRIVATE_FILE_CREDENTIAL',
          name: 'OBSERVED_UPLOAD_LABEL.txt',
          size: 123,
          busid: 102,
          url: 'https://private.invalid/credential',
        },
      },
      {
        ...base,
        notice_type: 'notify',
        sub_type: 'group_name',
        name_new: 'OBSERVED_GROUP_NAME',
      },
    ];
    const http = createServer((req, res) => {
      void (async () => {
        req.setEncoding('utf8');
        let source = '';
        for await (const chunk of req) {
          source += chunk;
        }
        const body = JSON.parse(source);
        modelCalls++;
        assert.equal(req.headers.authorization, 'Bearer fixture-key');
        assert.equal(body.model, 'fixture-world-notices');
        const toolResults = body.messages.filter((m: any) => m.role === 'tool');
        if (modelCalls === 1) {
          assert.equal(toolResults.length, 0);
          assert.doesNotMatch(
            JSON.stringify(body.messages),
            /OBSERVED_UPLOAD_LABEL|OBSERVED_GROUP_NAME|PRIVATE_FILE_CREDENTIAL/,
          );
          assert.deepEqual(
            body.tools
              .find((t: any) => t.function.name === 'read_events')
              .function.parameters.properties.types.items.enum.slice(-5),
            [
              'member.joined',
              'member.left',
              'group.ban_changed',
              'file.uploaded',
              'group.name_changed',
            ],
          );
        } else {
          assert.equal(modelCalls, 2);
          const observed = JSON.parse(toolResults.at(-1).content);
          assert.equal(observed.status, 'ok');
          assert.deepEqual(
            observed.events.map((e: any) => e.type),
            [
              'member.joined',
              'member.left',
              'group.ban_changed',
              'file.uploaded',
              'group.name_changed',
              'message.created',
            ],
          );
          assert.deepEqual(
            observed.events.find((e: any) => e.type === 'group.ban_changed')
              .payload,
            {
              kind: 'group_ban',
              user_id: '0',
              sub_type: 'ban',
              duration: 0,
              operator_id: '222',
            },
          );
          assert.deepEqual(
            observed.events.find((e: any) => e.type === 'file.uploaded')
              .payload,
            {
              kind: 'file_uploaded',
              user_id: '111',
              name: 'OBSERVED_UPLOAD_LABEL.txt',
              size: 123,
            },
          );
          assert.deepEqual(
            observed.events.find((e: any) => e.type === 'group.name_changed')
              .payload,
            { kind: 'group_name', name: 'OBSERVED_GROUP_NAME', user_id: '111' },
          );
          for (const entry of observed.events.slice(0, 5)) {
            assert.equal(entry.group_id, GROUP);
            assert.equal(entry.provenance.verified, false);
          }
          assert.doesNotMatch(
            JSON.stringify(observed),
            /PRIVATE_FILE_CREDENTIAL|private\.invalid|busid|file_id/,
          );
        }
        const tool =
          modelCalls === 1
            ? { name: 'read_events', arguments: '{"limit":100}' }
            : { name: 'finish', arguments: '{}' };
        sendChatStream(res, {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `notice-op-${modelCalls}`,
                    type: 'function',
                    function: tool,
                  },
                ],
              },
            },
          ],
        });
        notify();
      })().catch((error) => {
        fail(error);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    });
    http.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    http.on('error', fail);
    const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    ws.on('error', fail);
    ws.on('connection', (socket) => {
      peer = socket;
      peers.add(socket);
      socket.once('close', () => peers.delete(socket));
      socket.on('error', fail);
      socket.on('message', (raw) => {
        try {
          const call = JSON.parse(raw.toString());
          calls.push(call.action);
          assert.ok(
            ['get_login_info', 'get_group_list'].includes(call.action),
            'only startup identity/membership discovery may make external requests',
          );
          socket.send(
            JSON.stringify({
              echo: call.echo,
              status: 'ok',
              retcode: 0,
              data:
                call.action === 'get_group_list'
                  ? [GROUP, OTHER, DISABLED].map((group_id) => ({ group_id }))
                  : { user_id: SELF },
            }),
          );
          notify();
        } catch (error) {
          fail(error);
        }
      });
      notify();
    });
    const wait = (predicate: () => boolean, label: string) =>
      new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (error?: unknown) => {
          clearTimeout(timer);
          changed.off('change', check);
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (failure) {
            return done(failure);
          }
          try {
            if (predicate()) {
              done();
            }
          } catch (error) {
            done(error);
          }
        };
        changed.on('change', check);
        timer = setTimeout(
          () => done(new Error(`${label}: ${output.slice(-2000)}`)),
          6000,
        );
        check();
      });
    const events = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return db
          .prepare(
            'SELECT type,payload,group_id FROM world_events ORDER BY sequence',
          )
          .all();
      } finally {
        db.close();
      }
    };
    try {
      http.listen(0, '127.0.0.1');
      await Promise.all([
        once(http, 'listening'),
        ws.address() ? Promise.resolve() : once(ws, 'listening'),
      ]);
      mkdirSync(join(dir, 'prompts'));
      writeFileSync(
        join(dir, 'prompts/listener.md'),
        'Isolated world-notice fixture.',
      );
      writeFileSync(
        join(dir, '.env'),
        'FIXTURE_TOKEN=fixture-token\nFIXTURE_KEY=fixture-key\n',
        { mode: 0o600 },
      );
      writeFileSync(
        join(dir, 'config.toml'),
        `[bot]
owner_id = "778899"
[onebot]
url = "ws://127.0.0.1:${(ws.address() as AddressInfo).port}"
token_env = "FIXTURE_TOKEN"
[model]
base_url = "http://127.0.0.1:${(http.address() as AddressInfo).port}/v1"
model = "fixture-world-notices"
api_key_env = "FIXTURE_KEY"
timeout_ms = 10000
[storage]
directory = "data"
telemetry_path = "data/listener.sqlite.telemetry.sqlite"
[defaults]
enabled = false
persona = "prompts/listener.md"
reply = { delay_ms = [100,100], cooldown_ms = 1000, random = false }
[logging]
level = "debug"
console = true
file = false
[groups."${GROUP}"]
enabled = true
[groups."${OTHER}"]
enabled = true
[groups."${DISABLED}"]
enabled = false
`,
      );
      child = spawn(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('../../../src/app/bot.ts', import.meta.url)),
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: dir,
            NODE_NO_WARNINGS: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      exit = new Promise((resolve, reject) => {
        child!.once('error', (error) => {
          fail(error);
          reject(error);
        });
        child!.once('close', (code, signal) => {
          resolve({ code, signal });
          notify();
        });
      });
      void exit.catch(() => {});
      for (const stream of [child.stdout!, child.stderr!]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          output = (output + chunk).slice(-128 * 1024);
          notify();
        });
      }
      await wait(() => output.includes('onebot.ready'), 'startup');
      for (const packet of notices) {
        peer!.send(JSON.stringify(packet));
        for (const invalid of [
          { group_id: DISABLED },
          { group_id: '44' },
          { self_id: '88888' },
          { group_id: '01' },
        ]) {
          peer!.send(JSON.stringify({ ...packet, ...invalid }));
        }
      }
      peer!.send(JSON.stringify(notices[3])); // Explicit provider identity deduplicates one replay.
      peer!.send(JSON.stringify({ ...notices[0], group_id: OTHER }));
      peer!.send(
        JSON.stringify({
          ...base,
          notice_type: 'notify',
          sub_type: 'group_announcement',
          content: 'not supported',
        }),
      );
      const pong = once(peer!, 'pong');
      peer!.ping();
      await bounded(pong);
      // Observe beyond the configured 100ms reply delay: a notice must not merely
      // queue a wake that merges with the explicit message sent later.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (failure) {
        throw failure;
      }
      assert.doesNotMatch(
        output,
        /trigger\.accepted|trigger\.scheduled|turn\.start/,
      );
      assert.equal(modelCalls, 0);
      assert.deepEqual(calls, ['get_login_info', 'get_group_list']);
      const ownPath = join(
          dir,
          `data/groups/${GROUP}/listener.sqlite.events.sqlite`,
        ),
        otherPath = join(
          dir,
          `data/groups/${OTHER}/listener.sqlite.events.sqlite`,
        );
      assert.deepEqual(
        events(ownPath).map((row) => row.type),
        [
          'member.joined',
          'member.left',
          'group.ban_changed',
          'file.uploaded',
          'group.name_changed',
        ],
      );
      assert.equal(events(otherPath).length, 1);
      assert.equal(existsSync(join(dir, `data/groups/${DISABLED}`)), false);
      const memory = new DatabaseSync(
        join(dir, `data/groups/${GROUP}/listener.sqlite`),
        {
          readOnly: true,
        },
      );
      try {
        assert.equal(
          memory.prepare('SELECT COUNT(*) AS n FROM listener_messages').get()!
            .n,
          0,
        );
      } finally {
        memory.close();
      }
      peer!.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'group',
          self_id: SELF,
          group_id: GROUP,
          user_id: '111',
          message_id: '1001',
          time: Math.floor(Date.now() / 1000),
          sender: { user_id: '111', nickname: 'fixture' },
          message: [
            { type: 'at', data: { qq: SELF } },
            { type: 'text', data: { text: 'explicit observation trigger' } },
          ],
        }),
      );
      await wait(() => output.includes('turn.end'), 'observation wake');
      assert.equal(modelCalls, 2);
      assert.deepEqual(calls, ['get_login_info', 'get_group_list']);
      child.kill('SIGTERM');
      assert.deepEqual(await bounded(exit), { code: 0, signal: null });
      const persisted = JSON.stringify(events(ownPath));
      assert.doesNotMatch(
        persisted,
        /PRIVATE_FILE_CREDENTIAL|private\.invalid|busid|file_id/,
      );
      assert.equal(events(ownPath).length, 6);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        try {
          if (exit) {
            await bounded(exit);
          }
        } catch {
          child.kill('SIGKILL');
          if (exit) {
            await bounded(exit).catch(() => {});
          }
        }
      }
      for (const socket of peers) {
        socket.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([
        bounded(
          new Promise<void>((resolve) => ws.close(() => resolve())),
        ).catch(() => {}),
        bounded(
          new Promise<void>((resolve) => http.close(() => resolve())),
        ).catch(() => {}),
      ]);
      changed.removeAllListeners();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
