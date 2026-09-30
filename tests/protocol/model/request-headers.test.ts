import test from 'node:test';
import { sendChatStream } from '../../support/model-sse.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIModel } from '../../../src/model/chat.ts';
import { ResponsesModel } from '../../../src/model/responses.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';

const version = createRequire(import.meta.url)('../../../package.json').version;
for (const transport of ['chat', 'responses'] as const) {
  test(`${transport}: always versioned UA, optional dynamic persisted session headers`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headers-'));
    let session = new ModelSession({
      path: join(dir, 'session.sqlite'),
      groupId: '22',
      maxTranscriptBytes: 524288,
    });
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push({ ...req.headers });
      req.resume();
      req.on('end', () =>
        transport === 'chat'
          ? sendChatStream(res, {
              choices: [
                {
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: 'ok' },
                },
              ],
            })
          : (() => {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              const response = {
                id: `r${seen.length}`,
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'ok' }],
                  },
                ],
              };
              res.end(
                `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
              );
            })(),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const options = {
      baseUrl: `http://127.0.0.1:${address.port}/custom`,
      apiKey: 'fixture',
      model: 'fixture',
      timeoutMs: 1000,
      maxTokens: 100,
      sessionId: 'group:22',
    };
    const make = (enabled: boolean) => {
      const scoped = {
        ...options,
        ...(enabled
          ? {
              requestHeaders: () => ({
                'x-opencode-session': session.state().sessionId,
                'uSeR-aGeNt': 'spoof',
                AUTHORIZATION: 'spoof',
                'Content-Type': 'spoof',
              }),
            }
          : {}),
      };
      return transport === 'chat'
        ? new OpenAIModel(scoped)
        : new ResponsesModel(scoped);
    };
    try {
      await make(false).complete([]);
      assert.equal(seen[0]!['user-agent'], `listener/${version}`);
      assert.equal(seen[0]!['x-opencode-session'], undefined);
      const model = make(true),
        first = session.state().sessionId;
      await model.complete([]);
      session.close();
      session = new ModelSession({
        path: join(dir, 'session.sqlite'),
        groupId: '22',
        maxTranscriptBytes: 524288,
      });
      await model.complete([]);
      assert.equal(seen[1]!['x-opencode-session'], first);
      assert.equal(seen[2]!['x-opencode-session'], first);
      session.reset('fixture');
      await model.complete([]);
      assert.notEqual(session.state().sessionId, first);
      assert.equal(seen[3]!['x-opencode-session'], session.state().sessionId);
      for (const h of seen) {
        assert.equal(h['user-agent'], `listener/${version}`);
        assert.equal(h.authorization, 'Bearer fixture');
        assert.equal(h['content-type'], 'application/json');
      }
    } finally {
      session.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
