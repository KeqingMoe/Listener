import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  ResponsesModel,
  ResponseStateExpiredError,
} from '../../../src/model/responses.ts';
import type { ChatMessage } from '../../../src/contracts/model.ts';
import type { ToolDefinition } from '../../../src/contracts/tools.ts';
import { MODEL_USER_AGENT } from '../../../src/config/version.ts';

const make = (
  url: string,
  extra: Partial<
    import('../../../src/model/responses.ts').ResponsesModelOptions
  > = {},
) =>
  new ResponsesModel({
    baseUrl: url,
    apiKey: 'secret-key',
    model: 'test-model',
    timeoutMs: 1000,
    maxTokens: 100,
    sessionId: 'group-1',
    ...extra,
  });
const append = (
  messages: ChatMessage[],
  r: import('../../../src/contracts/model.ts').Completion,
  discard = false,
): ChatMessage[] => [
  ...messages,
  {
    role: 'assistant',
    content: discard ? null : r.content,
    ...(r.tool_calls.length ? { tool_calls: r.tool_calls } : {}),
  },
  ...r.tool_calls.map((c) => ({
    role: 'tool' as const,
    tool_call_id: c.id,
    content: '{"status":"ok"}',
  })),
];
const tool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'finish',
    description: 'done',
    parameters: { type: 'object' },
  },
};

function streamResponse(res: import('node:http').ServerResponse) {
  const end = res.end.bind(res);
  res.end = ((data?: any, ...args: any[]) => {
    if (
      res.statusCode === 200 &&
      !res.headersSent &&
      typeof data === 'string'
    ) {
      const raw = JSON.parse(data);
      res.setHeader('content-type', 'text/event-stream');
      data = `data: ${JSON.stringify({ type: 'response.' + (raw.status ?? 'failed'), response: raw })}\n\n`;
    }
    return end(data, ...args);
  }) as typeof res.end;
}

async function fixture(
  handler: (body: any, res: import('node:http').ServerResponse) => void,
) {
  const server = createServer((req, res) => {
    streamResponse(res);
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => handler(JSON.parse(b), res));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const a = server.address();
  assert.ok(a && typeof a !== 'string');
  return { server, url: `http://127.0.0.1:${a.port}/v1` };
}

const response = (id: string) => ({
  id,
  status: 'completed',
  output: [
    { type: 'function_call', call_id: 'c1', name: 'finish', arguments: '{}' },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 1 },
  },
});

test('restored continuation cannot cross endpoint or credential identity', async () => {
  const bodies: any[] = [];
  const handler = (body: any, res: import('node:http').ServerResponse) => {
    bodies.push(body);
    res.end(JSON.stringify(response('chain')));
  };
  const first = await fixture(handler),
    second = await fixture(handler);
  try {
    const original = make(first.url),
      messages: ChatMessage[] = [{ role: 'system', content: 'stable' }],
      r = await original.complete(messages, [tool]),
      checkpoint = original.getContinuationCheckpoint()!;
    for (const model of [
      make(second.url),
      make(first.url, { apiKey: 'changed-private-key' }),
    ]) {
      model.restoreContinuationCheckpoint(checkpoint);
      await model.complete(append(messages, r), [tool]);
      assert.equal(bodies.at(-1).previous_response_id, undefined);
    }
    assert.doesNotMatch(
      JSON.stringify(checkpoint),
      /secret-key|changed-private-key|127\.0\.0\.1/,
    );
  } finally {
    first.server.close();
    second.server.close();
  }
});

test('system-only empty input; checkpoint retains opaque output and tools change breaks reuse', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(
      JSON.stringify({
        ...response('r' + bodies.length),
        output: [
          { type: 'reasoning', encrypted_content: 'opaque' },
          { type: 'compaction', encrypted_content: 'opaque-compact' },
          ...response('r').output,
        ],
      }),
    );
  });
  try {
    const m = make(f.url, { compactionThreshold: 2000 });
    const messages: ChatMessage[] = [{ role: 'system', content: 'stable' }];
    const r = await m.complete(messages, [tool]);
    assert.deepEqual(bodies[0].input, []);
    assert.equal(bodies[0].context_management, undefined);
    assert.equal(bodies[0].max_output_tokens, 100);
    assert.match(bodies[0].prompt_cache_key, /^[a-f0-9]{64}$/);
    const cp = m.getCheckpoint()!;
    assert.equal(cp.outputItems.length, 3);
    cp.baselineMessages[0]!.content = 'mutated';
    assert.equal(m.getCheckpoint()!.baselineMessages[0]!.content, 'stable');
    await m.complete(append(messages, r), [
      { ...tool, function: { ...tool.function, description: 'changed' } },
    ]);
    assert.equal(bodies[1].previous_response_id, undefined);
    assert.equal(bodies[1].input[0].type, 'function_call');
  } finally {
    f.server.close();
  }
});

test('text plus tool result can be continued with actual content or legacy null projection', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(
      JSON.stringify({
        ...response('r' + bodies.length),
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'first' },
              { type: 'output_text', text: 'second' },
            ],
          },
          ...response('r').output,
        ],
      }),
    );
  });
  try {
    for (const discard of [true, false]) {
      const m = make(f.url);
      const messages: ChatMessage[] = [{ role: 'system', content: 'stable' }],
        r = await m.complete(messages, [tool]);
      assert.equal(r.content, 'first\nsecond');
      await m.complete(append(messages, r, discard), [tool]);
      assert.equal(bodies.at(-1).input.length, 1);
      assert.ok(bodies.at(-1).previous_response_id);
    }
  } finally {
    f.server.close();
  }
});

test('separate model instances cannot share response chains or cache identity', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(JSON.stringify(response('r' + bodies.length)));
  });
  try {
    const a = make(f.url, { sessionId: 'a' }),
      b = make(f.url, { sessionId: 'b' });
    await a.complete([], [tool]);
    await b.complete([], [tool]);
    assert.equal(bodies[1].previous_response_id, undefined);
    assert.notEqual(bodies[0].prompt_cache_key, bodies[1].prompt_cache_key);
  } finally {
    f.server.close();
  }
});

test('bounded invalid tool semantics pass through but invalid output envelopes are rejected', async () => {
  let raw: any = {
    ...response('r'),
    output: [
      { type: 'function_call', call_id: 'c', name: 'unknown', arguments: '{' },
    ],
  };
  const f = await fixture((_b, res) => res.end(JSON.stringify(raw)));
  try {
    const m = make(f.url);
    assert.equal(
      (await m.complete([], [tool])).tool_calls[0]!.function.arguments,
      '{',
    );
    for (const output of [
      [
        {
          type: 'function_call',
          call_id: 'c',
          name: 'x',
          arguments: 'x'.repeat(16385),
        },
      ],
      [response('r').output[0], response('r').output[0]],
      [{ type: 'unknown_opaque' }],
      Array.from({ length: 9 }, (_, i) => ({
        type: 'function_call',
        call_id: String(i),
        name: 'x',
        arguments: '{}',
      })),
    ]) {
      raw = { ...response('r'), output };
      await assert.rejects(
        m.complete([], [tool]),
        (e: any) => e.code === 'invalid_response',
      );
      assert.equal(m.getCheckpoint(), undefined);
    }
  } finally {
    f.server.close();
  }
});

test('incomplete output records usage and observer cannot mask truncated response', async () => {
  const records: import('../../../src/observability/model-usage.ts').ModelRequestRecord[] =
    [];
  const f = await fixture((_b, res) =>
    res.end(
      JSON.stringify({
        ...response('r'),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    ),
  );
  try {
    const m = make(f.url, {
      onRequest: (r) => {
        records.push(r);
        throw Error('observer-secret');
      },
    });
    await assert.rejects(
      m.complete([]),
      (e: any) => e.code === 'truncated_response',
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]!.usage.cachedInputTokens, 5);
    assert.equal(records[0]!.errorCode, 'truncated_response');
    assert.ok(!JSON.stringify(records).includes('secret'));
  } finally {
    f.server.close();
  }
});

test('known previous response expiry is classified safely, no automatic retry', async () => {
  let count = 0;
  const f = await fixture((_b, res) => {
    if (++count === 1) {
      res.end(JSON.stringify(response('r')));
    } else {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: {
            code: 'previous_response_not_found',
            message: 'secret-error',
          },
        }),
      );
    }
  });
  try {
    const m = make(f.url),
      messages: ChatMessage[] = [];
    const r = await m.complete(messages, [tool]);
    await assert.rejects(
      m.complete(append(messages, r), [tool]),
      (e: any) =>
        e instanceof ResponseStateExpiredError && !e.message.includes('secret'),
    );
    assert.equal(count, 2);
    assert.equal(m.getCheckpoint(), undefined);
  } finally {
    f.server.close();
  }
});

test('unrelated 404 is not treated as expired state and URL/credentials never leak', async () => {
  const f = await fixture((_b, res) => {
    res.statusCode = 404;
    res.end(
      JSON.stringify({ error: { code: 'not_found', message: 'secret' } }),
    );
  });
  try {
    await assert.rejects(
      make(f.url).complete([]),
      (e: any) =>
        e.code === 'http_error' &&
        !e.stateExpired &&
        !e.message.includes('secret'),
    );
    for (const baseUrl of [
      'http://remote.invalid',
      'https://secret@host.invalid',
      'https://host.invalid?secret',
    ]) {
      assert.throws(
        () => make(baseUrl),
        (e) => e instanceof Error && !e.message.includes('secret'),
      );
    }
  } finally {
    f.server.close();
  }
});

test('abort and reset discard late state and callback runs once', async () => {
  let release: (() => void) | undefined,
    reachedResolve: () => void = () => {};
  const reached = new Promise<void>((r) => {
    reachedResolve = r;
  });
  const f = await fixture((_b, res) => {
    release = () => res.end(JSON.stringify(response('late')));
    reachedResolve();
  });
  const records: unknown[] = [];
  try {
    const m = make(f.url, { onRequest: (r) => records.push(r) });
    const request = m.complete([]);
    await reached;
    m.reset();
    release!();
    await assert.rejects(request, (e: any) => e.code === 'cancelled');
    assert.equal(m.getCheckpoint(), undefined);
    assert.equal(records.length, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      m.complete([], [], controller.signal),
      (e: any) => e.code === 'cancelled',
    );
    assert.equal(records.length, 2);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test('uses empty input first and only delta with previous response', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(JSON.stringify(response(`r${bodies.length}`)));
  });
  try {
    const m = new ResponsesModel({
      baseUrl: f.url,
      apiKey: 'x',
      model: 'm',
      timeoutMs: 1000,
      maxTokens: 100,
      sessionId: 'g1',
    });
    const first: ChatMessage[] = [
      { role: 'system', content: 'stable' },
      { role: 'user', content: 'wake' },
    ];
    await m.complete(first, [tool]);
    const second: ChatMessage[] = [
      ...first,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'finish', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"status":"ok"}' },
    ];
    await m.complete(second, [tool]);
    assert.equal(bodies[0].input.length, 1);
    assert.equal(bodies[1].previous_response_id, 'r1');
    assert.equal(bodies[1].input.length, 1);
  } finally {
    f.server.close();
  }
});

test('prefix mismatch starts a full independent input chain', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(JSON.stringify(response(String(bodies.length))));
  });
  try {
    const m = new ResponsesModel({
      baseUrl: f.url,
      apiKey: 'x',
      model: 'm',
      timeoutMs: 1000,
      maxTokens: 100,
      sessionId: 'g1',
    });
    await m.complete(
      [
        { role: 'system', content: 'a' },
        { role: 'user', content: 'x' },
      ],
      [tool],
    );
    await m.complete(
      [
        { role: 'system', content: 'changed' },
        { role: 'user', content: 'y' },
      ],
      [tool],
    );
    assert.equal(bodies[1].previous_response_id, undefined);
    assert.equal(bodies[1].input.length, 1);
  } finally {
    f.server.close();
  }
});

test('continuation checkpoint restores only a digest and resumes with delta', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(JSON.stringify(response('r' + bodies.length)));
  });
  try {
    const a = make(f.url, { sessionId: 'persist' }),
      base: ChatMessage[] = [
        { role: 'system', content: 'stable' },
        { role: 'user', content: 'wake' },
      ];
    const r = await a.complete(base, [tool]),
      cp = a.getContinuationCheckpoint()!;
    assert.equal(JSON.stringify(cp).includes('wake'), false);
    assert.equal(JSON.stringify(cp).includes('data:'), false);
    const b = make(f.url, { sessionId: 'persist' });
    b.restoreContinuationCheckpoint(cp);
    const next: ChatMessage[] = [
      ...base,
      { role: 'assistant', content: null, tool_calls: r.tool_calls },
      {
        role: 'tool',
        tool_call_id: r.tool_calls[0]!.id,
        content: '{"status":"ok"}',
      },
    ];
    await b.complete(next, [tool]);
    assert.equal(bodies[1].previous_response_id, 'r1');
    assert.equal(bodies[1].input.length, 1);
  } finally {
    f.server.close();
  }
});

test('restored checkpoint never trims a changed or shorter history, or changed header', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(JSON.stringify(response('r' + bodies.length)));
  });
  try {
    const base: ChatMessage[] = [
        { role: 'system', content: 'stable' },
        { role: 'user', content: 'PRIVATE-original' },
      ],
      a = make(f.url),
      r = await a.complete(base, [tool]),
      cp = a.getContinuationCheckpoint()!,
      next = append(base, r);
    for (const changed of [
      [],
      [{ role: 'system' as const, content: 'other' }, ...next.slice(1)],
      [
        ...next.slice(0, 1),
        { role: 'user' as const, content: 'PRIVATE-modified' },
        ...next.slice(2),
      ],
    ]) {
      const b = make(f.url);
      b.restoreContinuationCheckpoint(cp);
      await b.complete(changed, [tool]);
      assert.equal(bodies.at(-1).previous_response_id, undefined);
      assert.equal(bodies.at(-1).input.length, changed.length ? 3 : 0);
    }
  } finally {
    f.server.close();
  }
});

test('checkpoint excludes image bytes, assistant text, and tool arguments; null-content projection resumes', async () => {
  const bodies: any[] = [];
  const f = await fixture((b, res) => {
    bodies.push(b);
    res.end(
      JSON.stringify({
        ...response('r' + bodies.length),
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'PRIVATE-assistant' }],
          },
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'finish',
            arguments: '{"PRIVATE":"argument"}',
          },
        ],
      }),
    );
  });
  try {
    const base: ChatMessage[] = [
        { role: 'system', content: 'stable' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,PRIVATE' },
            },
          ],
        },
      ],
      a = make(f.url),
      r = await a.complete(base, [tool]),
      cp = a.getContinuationCheckpoint()!;
    assert.ok(!JSON.stringify(cp).includes('PRIVATE'));
    assert.ok(!JSON.stringify(cp).includes('data:image'));
    assert.match(cp.baselineNullContentHash!, /^[a-f0-9]{64}$/);
    const b = make(f.url);
    b.restoreContinuationCheckpoint(cp);
    await b.complete(append(base, r, true), [tool]);
    assert.equal(bodies.at(-1).input.length, 1);
    assert.equal(bodies.at(-1).previous_response_id, 'r1');
  } finally {
    f.server.close();
  }
});

test('restored checkpoint expiry clears durable metadata without retries', async () => {
  let count = 0;
  const f = await fixture((_b, res) => {
    if (++count === 1) {
      res.end(JSON.stringify(response('r')));
    } else {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: { code: 'previous_response_not_found', message: 'PRIVATE' },
        }),
      );
    }
  });
  try {
    const a = make(f.url),
      r = await a.complete([], [tool]),
      b = make(f.url);
    b.restoreContinuationCheckpoint(a.getContinuationCheckpoint());
    await assert.rejects(
      b.complete(append([], r), [tool]),
      (e) => e instanceof ResponseStateExpiredError,
    );
    assert.equal(b.getContinuationCheckpoint(), undefined);
    assert.equal(count, 2);
  } finally {
    f.server.close();
  }
});

test('tampered or invalid continuation checkpoints reset and reject', async () => {
  const f = await fixture((_b, res) => res.end(JSON.stringify(response('r'))));
  try {
    const m = make(f.url);
    assert.throws(
      () =>
        m.restoreContinuationCheckpoint({
          version: 1,
          responseId: 'secret',
          headerHash: '0'.repeat(64),
          baselineLength: 1,
          baselineHash: '0'.repeat(64),
          extra: 'x',
        }),
      /Invalid continuation checkpoint/,
    );
    assert.equal(m.getContinuationCheckpoint(), undefined);
    for (const invalid of [
      null,
      [],
      { version: 2 },
      {
        version: 1,
        responseId: 'r',
        headerHash: '0'.repeat(64),
        baselineLength: -1,
        baselineHash: '0'.repeat(64),
      },
      {
        version: 1,
        responseId: 'r',
        headerHash: '0'.repeat(64),
        baselineLength: 1,
        baselineHash: '0'.repeat(64),
        baselineNullContentHash: undefined,
      },
    ]) {
      assert.throws(
        () => m.restoreContinuationCheckpoint(invalid),
        /Invalid continuation checkpoint/,
      );
    }
  } finally {
    f.server.close();
  }
});

test('image content and tool results use Responses-native item shapes', async () => {
  let body: any;
  const f = await fixture((b, res) => {
    body = b;
    res.end(JSON.stringify(response('r')));
  });
  try {
    await make(f.url).complete(
      [
        { role: 'system', content: 'stable' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'image' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' },
            },
          ],
        },
        {
          role: 'assistant',
          content: 'explanation',
          tool_calls: [
            {
              id: 'c0',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c0', content: 'result' },
      ],
      [tool],
    );
    assert.deepEqual(body.input[0].content, [
      { type: 'input_text', text: 'image' },
      {
        type: 'input_image',
        image_url: 'data:image/png;base64,AAAA',
        detail: 'low',
      },
    ]);
    assert.equal(body.input[1].content[0].type, 'output_text');
    assert.equal(body.input[2].type, 'function_call');
    assert.equal(body.input[3].type, 'function_call_output');
    assert.equal(body.input[3].call_id, 'c0');
  } finally {
    f.server.close();
  }
});

test('timeout includes stalled body and oversized response is bounded', async () => {
  let stall = true;
  const f = await fixture((_b, res) => {
    if (stall) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'x'.repeat(2 * 1024 * 1024 + 1) })}\n\n`,
      );
    }
  });
  try {
    const records: import('../../../src/observability/model-usage.ts').ModelRequestRecord[] =
      [];
    const m = make(f.url, { timeoutMs: 30, onRequest: (r) => records.push(r) });
    await assert.rejects(m.complete([]), (e: any) => e.code === 'timeout');
    assert.equal(records[0]!.errorCode, 'timeout');
    assert.equal(m.getCheckpoint(), undefined);
    stall = false;
    await assert.rejects(
      make(f.url, {
        timeoutMs: 3000,
        onRequest: (r) => records.push(r),
      }).complete([]),
      (e: any) => e.code === 'response_too_large',
    );
    assert.equal(records.length, 2);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test('compaction is opt-in and usage is normalized', async () => {
  let body: any;
  const f = await fixture((b, res) => {
    body = b;
    res.end(JSON.stringify(response('r')));
  });
  try {
    const m = new ResponsesModel({
      baseUrl: f.url,
      apiKey: 'x',
      model: 'm',
      timeoutMs: 1000,
      maxTokens: 100,
      sessionId: 'g1',
      serverCompactionVerified: true,
      compactionThreshold: 1000,
    });
    await m.complete([{ role: 'system', content: 's' }], [tool]);
    assert.deepEqual(body.context_management, [
      { type: 'compaction', compact_threshold: 1000 },
    ]);
  } finally {
    f.server.close();
  }
});

test('request headers provider is evaluated per request and cannot override auth envelope', async () => {
  const headers: any[] = [];
  let session = 'first';
  const server = createServer((req, res) => {
    streamResponse(res);
    headers.push({ ...req.headers });
    req.resume();
    req.on('end', () =>
      res.end(JSON.stringify(response(`r${headers.length}`))),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const a = server.address();
  assert.ok(a && typeof a !== 'string');
  try {
    const m = make(`http://127.0.0.1:${a.port}/v1`, {
      requestHeaders: () => ({
        'uSeR-aGeNt': 'spoof',
        'x-opencode-session': session,
        Authorization: 'spoof',
        'CONTENT-TYPE': 'spoof',
      }),
    });
    await m.complete([]);
    session = 'second';
    await m.complete([]);
    assert.equal(headers[0]['user-agent'], MODEL_USER_AGENT);
    assert.equal(headers[0]['x-opencode-session'], 'first');
    assert.equal(headers[1]['x-opencode-session'], 'second');
    assert.equal(headers[0].authorization, 'Bearer secret-key');
  } finally {
    server.close();
  }
});
