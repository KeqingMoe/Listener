import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAIModel, ModelError } from '../../../src/model/chat.ts';
import {
  ResponsesModel,
  ResponseStateExpiredError,
} from '../../../src/model/responses.ts';
import {
  ENCRYPTED_REASONING,
  responseInspection,
  sanitizeInspection,
  sanitizeInspectionValue,
} from '../../../src/observability/request-inspection.ts';
import type {
  ModelRequestRecord,
  ModelRequestStart,
} from '../../../src/observability/model-usage.ts';

const options = {
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'fixture-api-key',
  model: 'fixture',
  timeoutMs: 1000,
  maxTokens: 10,
};
const reply = {
  id: 'chat-business-id',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      delta: {
        role: 'assistant',
        content: 'hello',
        reasoning_content: 'actual provider reasoning',
      },
    },
  ],
};
const chatStream = (raw: unknown, headers: Record<string, string> = {}) =>
  new Response(`data: ${JSON.stringify(raw)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
const responseStream = (raw: any, headers: Record<string, string> = {}) =>
  new Response(
    `data: ${JSON.stringify({ type: 'response.' + raw.status, response: raw })}\n\n`,
    { headers: { 'content-type': 'text/event-stream', ...headers } },
  );

test('inspection sanitizes only credentials, preserves business data and omits inline images', () => {
  const code = 'a'.repeat(32);
  const original = {
    group_id: '123',
    message_id: '456',
    call_id: 'call',
    response_id: 'res',
    face_ref: 'face',
    cursor: 'cursor',
    parameters: { limit: 10 },
    chat: 'ordinary secret word',
    Authorization: 'Bearer nope',
    Cookie: 'session=nope',
    api_key: 'key',
    password: 'password',
    content: 'fixture-api-key',
    args: JSON.stringify({ status: 'confirmation_required', code }),
    command: `/confirm ${code}`,
    encrypted_content: 'cipher',
    url: 'data:image/png;base64,AAAA',
  };
  const clean = sanitizeInspectionValue(original, ['fixture-api-key']);
  const s = JSON.stringify(clean.value);
  for (const v of ['fixture-api-key', code, 'session=nope', 'cipher']) {
    assert.ok(!s.includes(v));
  }
  for (const v of [
    '123',
    '456',
    'call',
    'res',
    'face',
    'cursor',
    'ordinary secret word',
  ]) {
    assert.ok(s.includes(v));
  }
  assert.match(s, /image data omitted; 26 bytes/);
  assert.match(s, /not readable/);
  const malformed = sanitizeInspection({
    responseJson:
      '[partial response] {"api_key":"privatekey", "message_id":"business-id", "password":"pw"',
  });
  assert.ok(!malformed.responseJson!.includes('privatekey'));
  assert.ok(!malformed.responseJson!.includes('"pw"'));
  assert.ok(malformed.responseJson!.includes('business-id'));
  const large = sanitizeInspection({
    requestJson: JSON.stringify({
      model: 'fixture',
      messages: [{ role: 'user', content: '文'.repeat(600000) }],
    }),
  });
  assert.equal(large.contentTruncated, true);
  assert.ok(Buffer.byteLength(large.requestJson!) <= 1024 * 1024);
  assert.equal(JSON.parse(large.requestJson!).model, 'fixture');
  assert.match(large.requestJson!, /truncated/);
});

test('structured image base64 is omitted precisely while business data stays intact', () => {
  const original = {
    image: {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    },
    standalone: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' },
    business: {
      type: 'base64',
      media_type: 'application/octet-stream',
      data: 'keep-business-data',
    },
    other: { data: 'keep-other-data' },
    remote: {
      type: 'image',
      source: { type: 'url', url: 'https://example.invalid/image.png' },
    },
  };
  const result = sanitizeInspectionValue(original);
  const value = result.value as typeof original;
  assert.equal(value.image.source.data, '[image data omitted; 4 bytes]');
  assert.equal(value.standalone.data, '[image data omitted; 4 bytes]');
  assert.equal(result.truncated, true);
  assert.deepEqual(value.business, original.business);
  assert.deepEqual(value.other, original.other);
  assert.deepEqual(value.remote, original.remote);
});

test('reasoning marks encrypted content only when no readable text exists', () => {
  const inspect = (...output: unknown[]) =>
    responseInspection(JSON.stringify({ output })).reasoningText;
  assert.equal(
    inspect(
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'visible' }],
        encrypted_content: 'opaque',
      },
      { type: 'reasoning', encrypted_content: 'opaque' },
    ),
    `visible\n${ENCRYPTED_REASONING}`,
  );
  assert.equal(
    inspect({
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'raw' }],
      encrypted_content: 'opaque',
    }),
    'raw',
  );
  assert.equal(inspect({ type: 'reasoning', summary: [] }), undefined);
});

test('text headers redact complete auth and cookie values without swallowing ordinary prose', () => {
  const original =
    'ordinary token: count secret: story\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\r\nCookie: a=secret_one; b=secret_two\nSet-Cookie: sid=secret_three; Path=/; HttpOnly\nCookie: c=secret_four; d=secret_five\nProxy-Authorization: Digest username="private_user", response="private_digest"\nmessage_id: 123 cursor: business-cursor';
  const text = sanitizeInspectionValue(original).value as string;
  for (const credential of [
    'dXNlcjpwYXNzd29yZA==',
    'secret_one',
    'secret_two',
    'secret_three',
    'secret_four',
    'secret_five',
    'private_user',
    'private_digest',
  ]) {
    assert.ok(!text.includes(credential), credential);
  }
  assert.ok(text.includes('ordinary token: count secret: story'));
  assert.ok(text.includes('message_id: 123 cursor: business-cursor'));
  assert.equal(
    sanitizeInspectionValue(
      'provider says Authorization: Basic dXNlcjpwYXNzd29yZA==',
    ).value,
    'provider says Authorization: [REDACTED]',
  );
  const json = sanitizeInspectionValue({
    token: 'credential-token',
    secret: 'credential-secret',
    text: 'token: budget secret: narrative',
    message_id: '123',
  }).value as Record<string, unknown>;
  assert.equal(json.token, '[REDACTED]');
  assert.equal(json.secret, '[REDACTED]');
  assert.equal(json.text, 'token: budget secret: narrative');
  assert.equal(json.message_id, '123');
});

test('structured truncation preserves __proto__ as an own key without modifying prototypes', () => {
  const input = JSON.parse(
    '{"__proto__":{"business_id":"keep"},"message_id":"123","content":"' +
      'x'.repeat(5000) +
      '"}',
  );
  const clean = sanitizeInspectionValue(input, [], 1024);
  const value = clean.value as Record<string, unknown>;
  assert.equal(clean.truncated, true);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(value.__proto__)), {
    business_id: 'keep',
  });
  assert.equal(JSON.parse(JSON.stringify(value)).message_id, '123');
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 1024);
});

test('Chat immutable start and finally end capture streaming request and assembled response', async (t) => {
  let wire = '';
  const starts: ModelRequestStart[] = [],
    ends: ModelRequestRecord[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      wire = String(init?.body);
      return chatStream(reply, {
        'x-request-id': 'provider-id',
        'set-cookie': 'never-capture',
      });
    },
  );
  const model = new OpenAIModel({
    ...options,
    onRequestStart: (r) => {
      starts.push(r);
      assert.ok(Object.isFrozen(r));
      throw new Error('observer');
    },
    onRequest: (r) => {
      ends.push(r);
      throw new Error('observer');
    },
  });
  assert.equal(
    (await model.complete([{ role: 'user', content: 'private prompt' }]))
      .content,
    'hello',
  );
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0]!.requestJson, wire);
  assert.equal(JSON.parse(wire).stream, true);
  assert.equal(ends[0]!.inspection?.requestJson, wire);
  assert.equal(ends[0]!.inspection?.reasoningText, 'actual provider reasoning');
  assert.equal(ends[0]!.inspection?.responseId, 'chat-business-id');
  assert.equal(ends[0]!.inspection?.providerRequestId, 'provider-id');
  const { inspection, ...publicRecord } = ends[0]!;
  assert.ok(!JSON.stringify(publicRecord).includes('private prompt'));
  assert.ok(!JSON.stringify(inspection).includes('never-capture'));
});

test('Chat stalled HTTP error body is partial and preserves known 400, not timeout, with no retry', async (t) => {
  let calls = 0;
  const ends: ModelRequestRecord[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('provider detail'));
        },
      }),
      { status: 400 },
    );
  });
  const model = new OpenAIModel({
    ...options,
    timeoutMs: 20,
    onRequest: (r) => ends.push(r),
  });
  const start = performance.now();
  await assert.rejects(
    model.complete([]),
    (error: unknown) =>
      error instanceof ModelError &&
      error.code === 'http_error' &&
      error.httpStatus === 400 &&
      !error.message.includes('provider detail'),
  );
  assert.ok(performance.now() - start < 400);
  assert.equal(calls, 1);
  assert.equal(ends[0]!.inspection?.contentTruncated, true);
  assert.match(ends[0]!.inspection!.errorText!, /partial.*\nprovider detail/);
});

test('Chat cancellation without assistant output still has paired inspection and collected partial body', async (t) => {
  const abort = new AbortController();
  const starts: ModelRequestStart[] = [],
    ends: ModelRequestRecord[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"partial":'));
            init?.signal?.addEventListener('abort', () =>
              c.error(Error('aborted')),
            );
            setTimeout(() => abort.abort(), 5);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  await assert.rejects(
    new OpenAIModel({
      ...options,
      onRequestStart: (r) => starts.push(r),
      onRequest: (r) => ends.push(r),
    }).complete([], [], abort.signal),
    (e: unknown) => e instanceof ModelError && e.code === 'cancelled',
  );
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0]!.requestId, ends[0]!.requestId);
  assert.equal(ends[0]!.inspection?.contentTruncated, true);
  assert.match(ends[0]!.inspection!.responseJson!, /partial/);
});

test('Responses captures reasoning, actual live/restored modes and explicit expired-chain error without replay', async (t) => {
  const starts: ModelRequestStart[] = [],
    ends: ModelRequestRecord[] = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1
      ? responseStream(
          {
            id: 'resp-one',
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 2 },
            output: [
              {
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'actual summary' }],
                encrypted_content: 'opaque',
              },
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'answer' }],
              },
            ],
          },
          { 'x-request-id': 'response-provider' },
        )
      : new Response(
          JSON.stringify({
            error: {
              code: 'previous_response_not_found',
              message: 'full provider error',
            },
          }),
          { status: 400 },
        );
  });
  const model = new ResponsesModel({
    ...options,
    sessionId: 'test',
    onRequestStart: (r) => starts.push(r),
    onRequest: (r) => ends.push(r),
  });
  const messages = [{ role: 'user' as const, content: 'question' }];
  await model.complete(messages);
  const checkpoint = model.getContinuationCheckpoint()!;
  assert.equal(ends[0]!.inspection!.reasoningText, 'actual summary');
  const restored = new ResponsesModel({
    ...options,
    sessionId: 'test',
    onRequestStart: (r) => starts.push(r),
    onRequest: (r) => ends.push(r),
  });
  restored.restoreContinuationCheckpoint(checkpoint);
  const next = [
    ...messages,
    { role: 'assistant' as const, content: 'answer' },
    { role: 'user' as const, content: 'next' },
  ];
  await assert.rejects(restored.complete(next), ResponseStateExpiredError);
  assert.equal(calls, 2);
  assert.equal(starts[1]!.requestMode, 'continue_restored');
  assert.equal(
    JSON.parse(starts[1]!.requestJson).previous_response_id,
    'resp-one',
  );
  assert.equal(ends[1]!.inspection?.previousResponseId, 'resp-one');
  assert.match(ends[1]!.inspection!.errorText!, /full provider error/);
  await assert.rejects(model.complete(next), ResponseStateExpiredError);
  assert.equal(starts[2]!.requestMode, 'continue_live');
  assert.equal(calls, 3);
});
