import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponsesModel } from '../../../src/model/responses.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import type { ChatMessage, Completion } from '../../../src/contracts/model.ts';
import { LISTENER_GROUP } from '../../../src/contracts/identity.ts';

const options = {
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'private-key',
  model: 'test',
  timeoutMs: 1000,
  maxTokens: 100,
  sessionId: 'group',
  incremental: false,
};
const sse = (raw: any) =>
  new Response(
    `data: ${JSON.stringify({ type: 'response.' + raw.status, response: raw })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
const output = (n: number) => [
  {
    type: 'reasoning',
    id: `reason${n}`,
    encrypted_content: `encrypted${n}`,
    summary: [],
  },
  {
    type: 'function_call',
    id: `fc${n}`,
    call_id: `c${n}`,
    name: 'finish',
    arguments: '{}',
    status: 'completed',
  },
  {
    type: 'compaction',
    id: `compact${n}`,
    encrypted_content: `compact-encrypted${n}`,
  },
  {
    type: 'message',
    id: `msg${n}`,
    role: 'assistant',
    content: [{ type: 'output_text', text: `text${n}`, annotations: [] }],
  },
];
const append = (base: ChatMessage[], r: Completion): ChatMessage[] => [
  ...base,
  { role: 'assistant', content: r.content, tool_calls: r.tool_calls },
  { role: 'tool', tool_call_id: r.tool_calls[0]!.id, content: 'tool-result' },
];

test('full mode preserves all native outputs in order with tool results, persists and survives failure', async (t) => {
  const bodies: any[] = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    if (fail) {
      return new Response('{"error":{"code":"previous_response_not_found"}}', {
        status: 404,
      });
    }
    return sse({
      id: `r${bodies.length}`,
      status: 'completed',
      output: output(bodies.length),
    });
  });
  const folder = mkdtempSync(join(tmpdir(), 'responses-full-')),
    path = join(folder, 'session.sqlite');
  try {
    const model = new ResponsesModel(options),
      base: ChatMessage[] = [
        { role: 'system', content: 'stable' },
        { role: 'user', content: 'user-input' },
      ];
    const first = await model.complete(base),
      next = append(base, first);
    const second = await model.complete(next),
      third = append(next, second);
    assert.deepEqual(bodies[1].input, [
      ...bodies[0].input,
      ...output(1),
      { type: 'function_call_output', call_id: 'c1', output: 'tool-result' },
    ]);
    const cp = model.getContinuationCheckpoint()!;
    assert.equal(JSON.stringify(cp).includes('user-input'), false);
    assert.equal(JSON.stringify(cp).includes('tool-result'), false);
    let session = new ModelSession({ groupId: LISTENER_GROUP, path });
    session.setTransportCheckpoint(cp);
    session.close();
    session = new ModelSession({ groupId: LISTENER_GROUP, path });
    const restored = new ResponsesModel(options);
    restored.restoreContinuationCheckpoint(session.getTransportCheckpoint());
    session.close();
    await restored.complete(third);
    assert.deepEqual(bodies[2].input, [
      ...bodies[1].input,
      ...output(2),
      { type: 'function_call_output', call_id: 'c2', output: 'tool-result' },
    ]);
    const prior = restored.getContinuationCheckpoint();
    fail = true;
    await assert.rejects(
      restored.complete(third),
      (e: any) => e.code === 'http_error' && !e.stateExpired,
    );
    assert.deepEqual(restored.getContinuationCheckpoint(), prior);
    fail = false;
    // 重试下一次投影（包含最后一条成功的assistant消息）。
    const last = append(third, {
      content: 'text3',
      tool_calls: [
        {
          id: 'c3',
          type: 'function',
          function: { name: 'finish', arguments: '{}' },
        },
      ],
    });
    await restored.complete(last);
    assert.deepEqual(bodies[4].input, [
      ...bodies[2].input,
      ...output(3),
      { type: 'function_call_output', call_id: 'c3', output: 'tool-result' },
    ]);
    for (const body of bodies) {
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.prompt_cache_key, bodies[0].prompt_cache_key);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('full checkpoint bounds, isolation, mutation safety and strict validation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    sse({ id: 'r', status: 'completed', output: output(1) }),
  );
  const model = new ResponsesModel(options),
    base: ChatMessage[] = [{ role: 'system', content: 'stable' }];
  await model.complete(base);
  const cp = model.getContinuationCheckpoint()!;
  const restored = new ResponsesModel(options);
  restored.restoreContinuationCheckpoint(cp);
  cp.outputHistory![0]!.items.length = 0;
  assert.equal(
    restored.getContinuationCheckpoint()!.outputHistory![0]!.items.length,
    4,
  );
  for (const invalid of [
    { ...cp, outputHistory: undefined },
    { ...cp, outputHistory: [{ index: -1, items: output(1) }] },
    { ...cp, outputHistory: [{ index: 99, items: output(1) }] },
    {
      ...cp,
      outputHistory: [
        { index: 1, items: output(1) },
        { index: 1, items: output(1) },
      ],
    },
    {
      ...cp,
      outputHistory: [{ index: 1, items: [{ type: 'function_call' }] }],
    },
    { ...cp, outputHistory: [] },
    { ...cp, outputHistory: [{ index: 1, items: output(1), extra: true }] },
  ]) {
    assert.throws(
      () => restored.restoreContinuationCheckpoint(invalid),
      /Invalid continuation checkpoint/,
    );
  }
  assert.throws(
    () =>
      new ResponsesModel({
        ...options,
        incremental: true,
      }).restoreContinuationCheckpoint(cp),
    /Invalid continuation checkpoint/,
  );
  assert.throws(
    () => new ResponsesModel({ ...options, incremental: 'false' as any }),
  );
  model.reset();
  assert.equal(model.getContinuationCheckpoint(), undefined);
});

test('full mode starts fresh on changed projection and never reuses stale opaque output', async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return sse({ id: 'r', status: 'completed', output: output(1) });
  });
  const model = new ResponsesModel(options),
    base: ChatMessage[] = [{ role: 'system', content: 'stable' }];
  await model.complete(base);
  await model.complete([
    { role: 'system', content: 'changed' },
    { role: 'user', content: 'new' },
  ]);
  assert.deepEqual(bodies[1].input, [
    { role: 'user', content: [{ type: 'input_text', text: 'new' }] },
  ]);
  assert.equal(model.getContinuationCheckpoint()!.outputHistory!.length, 1);
});

test('tampered native mapping cannot replace user inputs or change tool arguments', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return sse({ id: 'r', status: 'completed', output: output(1) });
  });
  const model = new ResponsesModel(options),
    base: ChatMessage[] = [
      { role: 'system', content: 'stable' },
      { role: 'user', content: 'user' },
    ];
  const result = await model.complete(base),
    next = append(base, result);
  for (const change of ['index', 'arguments']) {
    const cp = model.getContinuationCheckpoint()!;
    if (change === 'index') {
      cp.outputHistory![0]!.index = 1;
    } else {
      (cp.outputHistory![0]!.items[1] as any).arguments = '{"changed":true}';
    }
    const restored = new ResponsesModel(options);
    if (change === 'index') {
      assert.throws(
        () => restored.restoreContinuationCheckpoint(cp),
        /Invalid continuation checkpoint/,
      );
      continue;
    }
    restored.restoreContinuationCheckpoint(cp);
    await assert.rejects(
      restored.complete(next),
      (e: any) => e.code === 'invalid_response',
    );
    assert.equal(restored.getContinuationCheckpoint(), undefined);
  }
  assert.equal(requests, 1);
});

test('removed middle native mapping fails closed before any request', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    sse({ id: `r${++count}`, status: 'completed', output: output(count) }),
  );
  const model = new ResponsesModel(options),
    base: ChatMessage[] = [{ role: 'user', content: 'start' }];
  const first = await model.complete(base),
    next = append(base, first),
    second = await model.complete(next),
    last = append(next, second);
  const third = await model.complete(last),
    afterThird = append(last, third);
  const cp = model.getContinuationCheckpoint()!;
  cp.outputHistory!.splice(1, 1);
  const restored = new ResponsesModel(options);
  restored.restoreContinuationCheckpoint(cp);
  await assert.rejects(
    restored.complete(afterThird),
    (e: any) => e.code === 'invalid_response',
  );
  assert.equal(count, 3);
  // 校验失败不能让实例停留在busy状态。
  await restored.complete([{ role: 'user', content: 'fresh' }]);
  assert.equal(count, 4);
});

test('full checkpoint resource limit rotates before tool dispatch rather than retaining stale checkpoint', () => {
  const session = new ModelSession({
    groupId: LISTENER_GROUP,
    path: ':memory:',
  });
  try {
    session.setTransportCheckpoint({
      version: 1,
      outputHistory: [
        {
          index: 0,
          items: [{ type: 'reasoning', encrypted_content: 'x'.repeat(300000) }],
        },
      ],
    });
    assert.ok(session.getTransportCheckpoint());
    const id = session.state().sessionId;
    assert.throws(
      () =>
        session.setTransportCheckpoint({
          outputHistory: [{ items: ['x'.repeat(16 * 1024 * 1024)] }],
        }),
      /session_resource_limit/,
    );
    assert.notEqual(session.state().sessionId, id);
    assert.equal(session.getTransportCheckpoint(), undefined);
  } finally {
    session.close();
  }
});
