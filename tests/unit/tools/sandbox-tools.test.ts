import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SandboxTools,
  SANDBOX_TOOL_NAMES,
} from '../../../src/tools/sandbox/tools.ts';
import {
  buildExtendedToolDefinitions,
  createExtendedTools,
} from '../../../src/tools/extended.ts';
import { TOOL_CAPABILITIES } from '../../../src/config/tool-policy.ts';
import type { SandboxService } from '../../../src/sandbox/service.ts';

const context = { selfId: '1', groupId: '2', actorId: '3', messageId: '4' };

test('execution and task detail preserve guest diagnostics but host throws stay sanitized', async () => {
  const { tools, service } = fixture();
  const diagnostic = {
    kind: 'guest_exception' as const,
    phase: 'execute' as const,
    name: 'ReferenceError',
    message: "'Intl' is not defined",
    truncated: false,
  };
  const args = {
    description: 'probe',
    code: 'return Intl.name;',
    mode: 'sync',
    wait_ms: 1000,
  };
  service.execute = async () => ({
    status: 'failed',
    error: 'execution_error',
    logs: [],
    diagnostic,
  });
  assert.deepEqual(
    (await tools.execute('execute_javascript', args, context)).diagnostic,
    diagnostic,
  );
  const job = { job_id: 'js_1', status: 'failed', diagnostic };
  service.query = (() => job) as SandboxService['query'];
  service.cancel = (() => job) as SandboxService['cancel'];
  for (const name of ['query_javascript_jobs', 'cancel_javascript_job']) {
    assert.deepEqual(
      (await tools.execute(name, { job_id: 'js_1' }, context)).job,
      job,
    );
  }
  service.execute = async () => {
    throw new Error('PRIVATE_HOST_PATH');
  };
  assert.deepEqual(await tools.execute('execute_javascript', args, context), {
    status: 'error',
    error: 'sandbox_failed',
  });
});

const memory = {
  append: () => false,
  recent: () => [],
  find: () => undefined,
  context: () => '',
  async compact() {},
  clear() {},
  close() {},
};
const api = {
  async call() {
    throw Error('provider must not run');
  },
};

function fixture() {
  const calls: any[] = [];
  const service = {
    async execute(input: any, signal: any) {
      calls.push(['execute', input, signal]);
      return { status: 'completed', value: 'ok', logs: [] };
    },
    query(scope: any, q: any) {
      calls.push(['query', scope, q]);
      return q.jobId ? undefined : { jobs: [], offset: 0, hasMore: false };
    },
    cancel(scope: any, id: any) {
      calls.push(['cancel', scope, id]);
      return undefined;
    },
  } as unknown as SandboxService;
  return { calls, service, tools: new SandboxTools(service) };
}

test('sandbox tools use trusted account/group and mode is required', async () => {
  const { tools, calls } = fixture();
  const args = {
    description: 'factorial',
    code: 'return 1n.toString();',
    mode: 'sync',
    wait_ms: 1500,
  };
  assert.equal(
    (await tools.execute('execute_javascript', args, context)).status,
    'ok',
  );
  assert.deepEqual(calls[0][1], {
    description: args.description,
    code: args.code,
    mode: 'sync',
    waitMs: 1500,
    selfId: '1',
    groupId: '2',
  });
  for (const a of [
    { ...args, selfId: '99' },
    { ...args, groupId: '99' },
    { description: 'x', code: 'return "x";' },
    { ...args, mode: {} },
    { ...args, description: 'x'.repeat(1025) },
    { ...args, code: 'x'.repeat(65537) },
  ]) {
    assert.equal(
      (await tools.execute('execute_javascript', a, context)).error,
      'invalid_arguments',
    );
  }
  assert.equal(calls[0][1].waitMs, 1500);
  for (const a of [
    { ...args, wait_ms: undefined },
    { ...args, wait_ms: null },
    { ...args, wait_ms: 0 },
    { ...args, wait_ms: -1 },
    { ...args, wait_ms: 1.5 },
    { ...args, wait_ms: 2147483648 },
    { ...args, wait_ms: '1' },
    { ...args, mode: 'async' },
    { ...args, mode: 'async', wait_ms: 1 },
  ]) {
    assert.equal(
      (await tools.execute('execute_javascript', a, context)).error,
      'invalid_arguments',
    );
  }
  assert.equal(calls.length, 1);
});

test('wait_ms is conditional without a default and maps only nonasync service input', async () => {
  const { tools, calls } = fixture();
  for (const mode of ['sync', 'auto']) {
    const base = { description: 'calculate', code: 'return "42";', mode };
    assert.equal(
      (await tools.execute('execute_javascript', base, context)).error,
      'invalid_arguments',
    );
    for (const wait_ms of [
      null,
      undefined,
      NaN,
      Infinity,
      0,
      -1,
      1.5,
      2147483648,
      '1',
      true,
    ]) {
      assert.equal(
        (
          await tools.execute(
            'execute_javascript',
            { ...base, wait_ms },
            context,
          )
        ).error,
        'invalid_arguments',
      );
    }
    for (const wait_ms of [1, 2147483647]) {
      assert.equal(
        (
          await tools.execute(
            'execute_javascript',
            { ...base, wait_ms },
            context,
          )
        ).status,
        'ok',
      );
      assert.deepEqual(calls.at(-1)[1], {
        ...base,
        selfId: '1',
        groupId: '2',
        waitMs: wait_ms,
      });
    }
  }
  const base = {
    description: 'calculate',
    code: 'return "42";',
    mode: 'async',
  };
  const count = calls.length;
  for (const wait_ms of [undefined, null, 1, 2147483647]) {
    assert.equal(
      (await tools.execute('execute_javascript', { ...base, wait_ms }, context))
        .error,
      'invalid_arguments',
    );
  }
  assert.equal(calls.length, count);
  assert.equal(
    (await tools.execute('execute_javascript', base, context)).status,
    'ok',
  );
  assert.deepEqual(calls.at(-1)[1], { ...base, selfId: '1', groupId: '2' });
  const schema = tools.definitions()[0]!.function.parameters;
  assert.deepEqual(schema.required, ['description', 'code', 'mode']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema, 'oneOf'), false);
  const wait = (schema.properties as any).wait_ms;
  assert.equal(wait.type, 'integer');
  assert.equal(wait.minimum, 1);
  assert.equal(wait.maximum, 2147483647);
  assert.equal(Object.hasOwn(wait, 'default'), false);
});

test('sandbox queries and cancellation are scoped and missing jobs are explicit', async () => {
  const { tools, calls } = fixture();
  assert.equal(
    (await tools.execute('query_javascript_jobs', {}, context)).offset,
    0,
  );
  assert.equal(
    (
      await tools.execute(
        'query_javascript_jobs',
        { job_id: 'js_missing' },
        context,
      )
    ).error,
    'job_not_found',
  );
  assert.equal(
    (
      await tools.execute(
        'cancel_javascript_job',
        { job_id: 'js_missing' },
        context,
      )
    ).error,
    'job_not_found',
  );
  assert.deepEqual(calls[2][1], { selfId: '1', groupId: '2' });
  for (const args of [
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { offset: 1.5 },
    { status: 'bad' },
    { groupId: '99' },
  ]) {
    assert.equal(
      (await tools.execute('query_javascript_jobs', args, context)).error,
      'invalid_arguments',
    );
  }
});

test('sandbox accessors are rejected without execution and service failures do not leak details', async () => {
  const { tools, calls, service } = fixture();
  let reads = 0;
  const args = {
    description: 'x',
    mode: 'sync',
    get code() {
      reads++;
      return 'return "x";';
    },
  };
  assert.equal(
    (await tools.execute('execute_javascript', args, context)).error,
    'invalid_arguments',
  );
  assert.equal(reads, 0);
  assert.equal(calls.length, 0);
  service.query = () => {
    throw Error('/private/path SECRET');
  };
  assert.deepEqual(await tools.execute('query_javascript_jobs', {}, context), {
    status: 'error',
    error: 'sandbox_failed',
  });
});

test('sandbox status projection distinguishes tool success from task status', async () => {
  const { tools, service } = fixture();
  const args = {
    description: 'x',
    code: 'return "x";',
    mode: 'auto',
    wait_ms: 2500,
  };
  assert.deepEqual(await tools.execute('execute_javascript', args, context), {
    status: 'ok',
    task_status: 'completed',
    value: 'ok',
    logs: [],
  });
  service.execute = async () => ({ status: 'pending', job_id: 'js_1' });
  assert.deepEqual(await tools.execute('execute_javascript', args, context), {
    status: 'pending',
    job_id: 'js_1',
  });
  for (const status of [
    'failed',
    'cancelled',
    'interrupted',
    'timeout',
  ] as const) {
    service.execute = async () => ({ status, error: 'failure', logs: [] });
    assert.deepEqual(await tools.execute('execute_javascript', args, context), {
      status: 'error',
      task_status: status,
      error: 'failure',
      logs: [],
    });
  }
  assert.equal(
    (await tools.execute('query_javascript_jobs', {}, context)).status,
    'ok',
  );
  const job = { job_id: 'js_1', status: 'cancelled' };
  service.cancel = (() => job) as SandboxService['cancel'];
  assert.deepEqual(
    await tools.execute('cancel_javascript_job', { job_id: 'js_1' }, context),
    { status: 'ok', job },
  );
  service.query = (() => job) as SandboxService['query'];
  assert.deepEqual(
    await tools.execute('query_javascript_jobs', { job_id: 'js_1' }, context),
    { status: 'ok', job },
  );
});

test('sandbox registration is pure, direct by default, disabled off and rejects confirmation', async () => {
  for (const name of SANDBOX_TOOL_NAMES) {
    assert.equal(TOOL_CAPABILITIES[name].defaultMode, 'direct');
    assert.equal(TOOL_CAPABILITIES[name].confirm, false);
    assert.deepEqual(
      buildExtendedToolDefinitions('2', { [name]: 'direct' }).map(
        (d) => d.function.name,
      ),
      [name],
    );
    assert.deepEqual(buildExtendedToolDefinitions('2', { [name]: 'off' }), []);
    assert.throws(() =>
      buildExtendedToolDefinitions('2', { [name]: 'confirm' }),
    );
    const r = createExtendedTools(api, memory, '2', { [name]: 'off' });
    assert.equal((await r.execute(name, {}, context)).error, 'tool_disabled');
  }
  const { service } = fixture();
  const r = createExtendedTools(
    api,
    memory,
    '2',
    { execute_javascript: 'direct' },
    { sandbox: service },
  );
  assert.equal(
    (
      await r.execute(
        'execute_javascript',
        { description: 'x', code: 'return "x";', mode: 'auto' },
        { ...context, groupId: '9' },
      )
    ).error,
    'invalid_scope',
  );
});
