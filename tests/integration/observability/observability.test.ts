import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureLogging,
  withLogContext,
} from '../../../src/observability/logger.ts';
import { OpenAIModel, ModelError } from '../../../src/model/chat.ts';
import { SQLiteMemory } from '../../../src/agent/memory.ts';
import { Moderation } from '../../../src/tools/management/moderation.ts';
import { ImageTools } from '../../../src/tools/images/tools.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import { type Memory } from '../../../src/contracts/messages.ts';
import { type TurnContext } from '../../../src/contracts/tools.ts';

const secret = 'private-body-header-key-card';

async function capture(work: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'listener-observability-'));
  const logger = configureLogging({
    level: 'debug',
    console: false,
    file: true,
    directory,
    retentionDays: 1,
    maxFileMb: 1,
    maxTotalMb: 2,
  });
  try {
    await withLogContext(
      {
        turn_id: 't_0123456789abcdef',
        group_id: LISTENER_GROUP,
        actor_id: OWNER_ID,
        message_id: '100',
      },
      work,
    );
    await logger.flush();
    const text = (
      await Promise.all(
        (await readdir(directory)).map((name) =>
          readFile(join(directory, name), 'utf8'),
        ),
      )
    ).join('');
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes('https://'));
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const model = (timeoutMs = 1000) =>
  new OpenAIModel({
    baseUrl: 'https://example.invalid/v1',
    apiKey: secret,
    model: secret,
    timeoutMs,
    maxTokens: 10,
  });
const reply = (usage: unknown = {}, finish_reason = 'stop') =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: secret }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

test('model logs sanitized usage, durations, inherited trace, and stable completion shape', async () => {
  const original = globalThis.fetch;
  try {
    const rows = await capture(async () => {
      globalThis.fetch = async () =>
        reply({
          prompt_tokens: 12,
          completion_tokens: -1,
          total_tokens: secret,
          detail: secret,
        });
      assert.deepEqual(
        await model().complete([{ role: 'user', content: secret }]),
        { content: secret, tool_calls: [] },
      );
      globalThis.fetch = async () =>
        reply({ prompt_tokens: 1.5, completion_tokens: 4, total_tokens: 16 });
      await model().complete([]);
    });
    const completed = rows.filter((row) => row.event === 'model.complete');
    assert.equal(completed.length, 2);
    assert.equal(completed[0]!.prompt_tokens, 12);
    assert.equal(completed[0]!.completion_tokens, undefined);
    assert.equal(completed[0]!.total_tokens, undefined);
    assert.equal(completed[1]!.prompt_tokens, undefined);
    assert.equal(completed[1]!.completion_tokens, 4);
    assert.equal(completed[1]!.total_tokens, 16);
    for (const row of completed) {
      assert.ok(row.duration_ms >= 0);
      assert.equal(row.outcome, 'success');
      assert.equal(row.turn_id, 't_0123456789abcdef');
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('model failure classification never logs remote errors, headers, bodies or abort reasons', async () => {
  const original = globalThis.fetch;
  try {
    const rows = await capture(async () => {
      const cases: Array<[string, () => Promise<Response>]> = [
        [
          'http_error',
          async () =>
            new Response(secret, {
              status: 429,
              headers: { 'x-secret': secret },
            }),
        ],
        [
          'network_error',
          async () => {
            throw new Error(secret);
          },
        ],
        ['invalid_response', async () => new Response(secret)],
        [
          'truncated_response',
          async () =>
            new Response(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: secret }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            ),
        ],
        [
          'response_too_large',
          async () =>
            new Response(secret, {
              headers: {
                'content-type': 'text/event-stream',
                'content-length': '20000000',
              },
            }),
        ],
      ];
      for (const [code, fetcher] of cases) {
        globalThis.fetch = fetcher;
        await assert.rejects(
          model().complete([]),
          (error) =>
            error instanceof ModelError &&
            error.code === code &&
            error.message === 'Model request failed',
        );
      }
      globalThis.fetch = async (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = options!.signal!;
          if (signal.aborted) {
            reject(new Error(secret));
          } else {
            signal.addEventListener('abort', () => reject(new Error(secret)), {
              once: true,
            });
          }
        });
      await assert.rejects(
        model(5).complete([]),
        (error) => error instanceof ModelError && error.code === 'timeout',
      );
      const controller = new AbortController();
      controller.abort(new Error(secret));
      await assert.rejects(
        model().complete([], [], controller.signal),
        (error) => error instanceof ModelError && error.code === 'cancelled',
      );
    });
    const failures = rows.filter((row) => row.event === 'model.failed');
    assert.deepEqual(
      failures.map((row) => row.reason),
      [
        'http_error',
        'network_error',
        'invalid_response',
        'truncated_response',
        'response_too_large',
        'timeout',
        'cancelled',
      ],
    );
    assert.equal(failures[0]!.http_status, 429);
    assert.equal(failures.at(-1)!.level, 'info');
    for (const row of failures) {
      assert.ok(row.duration_ms >= 0);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('moderation proposal and confirmation audits contain IDs but no card or code', async () => {
  const context: TurnContext = {
    groupId: LISTENER_GROUP,
    actorId: OWNER_ID,
    selfId: '999',
    messageId: '100',
  };
  let code = '';
  const rows = await capture(async () => {
    const api: Api = {
      async call(action, params = {}) {
        if (action === 'get_login_info') {
          return { user_id: '999' };
        }
        if (action === 'get_group_member_info') {
          return {
            group_id: LISTENER_GROUP,
            user_id: params.user_id,
            role: params.user_id === '999' ? 'admin' : 'member',
          };
        }
        throw new Error(secret);
      },
    };
    const moderation = new Moderation(api, Date.now, { memberCard: 'confirm' });
    const proposal = await moderation.request(
      'set_member_card',
      { user_id: '123', card: secret },
      context,
    );
    code = String(proposal.code);
    assert.equal(proposal.status, 'confirmation_required');
    await moderation.confirm(code, { ...context, messageId: '101' });
  });
  const audits = rows.filter((row) => row.event === 'moderation.audit');
  assert.deepEqual(
    audits.map((row) => row.outcome),
    ['confirmation_required', 'delivery_unknown'],
  );
  assert.deepEqual(
    audits.map((row) => row.message_id),
    ['100', '101'],
  );
  assert.equal(audits[0]!.target_id, '123');
  assert.ok(!JSON.stringify(rows).includes(code));
});

test('image logs cover origin validation download failures and safe image metrics without transport URLs', async () => {
  const context: TurnContext = {
    groupId: LISTENER_GROUP,
    actorId: '123',
    selfId: '999',
    messageId: '1',
  };
  const rows = await capture(async () => {
    const memory: Memory = {
      recent: () => [
        {
          messageId: '1',
          userId: '123',
          nickname: secret,
          text: secret,
          time: 1,
          images: [{ id: 'img_1_0', index: 0 }],
        },
      ],
      find: () => undefined,
      append: () => true,
      context: () => '',
      compact: async () => {},
      clear() {},
      close() {},
    };
    let raw: unknown = {
      message_type: 'group',
      group_id: LISTENER_GROUP,
      message_id: '1',
      sender: { user_id: '123', card: secret },
      message: [
        { type: 'image', data: { url: `https://gchat.qpic.cn/${secret}` } },
      ],
    };
    const api: Api = {
      async call() {
        return raw;
      },
    };
    let failure: string | undefined;
    const tools = new ImageTools(
      api,
      memory,
      { enabled: true, maxDownloadMb: 1 },
      async () => {
        if (failure) {
          throw new Error(failure);
        }
        return {
          dataUrl: 'data:image/jpeg;base64,YQ==',
          width: 1,
          height: 2,
          firstFrameOnly: true,
        };
      },
    );
    const state = tools.createTurn();
    await tools.view({ image_ids: ['img_1_0', 'img_2_0'] }, context, state);
    await tools.view({ image_ids: ['img_1_0'] }, context, state);
    failure = `https://example.invalid/${secret}`;
    await tools.view({ image_ids: ['img_1_0'] }, context, tools.createTurn());
    failure = 'Image download timed out';
    await tools.view({ image_ids: ['img_1_0'] }, context, tools.createTurn());
    raw = {};
    await tools.view({ image_ids: ['img_1_0'] }, context, tools.createTurn());
  });
  const complete = rows.find((row) => row.event === 'image.complete')!;
  assert.equal(complete.width, 1);
  assert.equal(complete.height, 2);
  assert.equal(complete.first_frame_only, true);
  assert.equal(
    complete.output_bytes,
    Buffer.byteLength('data:image/jpeg;base64,YQ=='),
  );
  assert.ok(complete.duration_ms >= 0);
  assert.ok(rows.some((row) => row.event === 'image.reused'));
  assert.deepEqual(
    rows
      .filter((row) => row.event === 'image.failed')
      .map((row) => [row.phase, row.reason]),
    [
      ['origin_lookup', 'origin_unavailable'],
      ['download_decode', 'download_failed'],
      ['download_decode', 'timeout'],
      ['validation', 'invalid_image'],
    ],
  );
});

test('memory only logs actual compaction, preserves swallowed failures and marks stale cancellation', async () => {
  const rows = await capture(async () => {
    const memory = new SQLiteMemory({
      path: ':memory:',
      maxContextChars: 1000,
      retentionDays: 1,
    });
    const fill = () => {
      for (let n = 0; n < 40; n++) {
        memory.append({
          messageId: String(n),
          userId: '123',
          nickname: secret,
          text: secret.repeat(8),
          time: Date.now() / 1000,
        });
      }
    };
    try {
      await memory.compact({
        complete: async () => {
          throw Error('must not run');
        },
      });
      fill();
      await memory.compact({
        complete: async () => {
          throw Error(secret);
        },
      });
      const controller = new AbortController();
      await memory.compact(
        {
          complete: async () => {
            controller.abort(secret);
            return { content: secret, tool_calls: [] };
          },
        },
        controller.signal,
      );
      await memory.compact({
        complete: async () => ({ content: secret, tool_calls: [] }),
      });
      await memory.compact({
        complete: async () => {
          memory.clear();
          return { content: secret, tool_calls: [] };
        },
      });
    } finally {
      memory.close();
    }
  });
  assert.equal(
    rows.filter((row) => row.event === 'memory.compact_start').length,
    4,
  );
  assert.ok(
    rows.some(
      (row) =>
        row.event === 'memory.compact_failed' &&
        row.reason === 'summarizer_failed',
    ),
  );
  assert.deepEqual(
    rows
      .filter((row) => row.event === 'memory.compact_skipped')
      .map((row) => row.reason),
    ['cancelled', 'stale'],
  );
  const completed = rows.find(
    (row) => row.event === 'memory.compact_complete',
  )!;
  assert.ok(completed.rows_after < completed.rows_before);
  assert.ok(completed.chars_after < completed.chars_before);
  assert.ok(rows.some((row) => row.event === 'memory.cleared'));
});
