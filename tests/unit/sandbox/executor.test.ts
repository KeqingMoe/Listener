import test from 'node:test';
import assert from 'node:assert/strict';
import { startExecution } from '../../../src/sandbox/executor.ts';
import { isExecutionDiagnostic } from '../../../src/sandbox/protocol.ts';

test('guest diagnostics preserve compile, ReferenceError, promise rejection and thrown primitives', async () => {
  for (const [code, error, name, text] of [
    [
      'return Intl.DateTimeFormat();',
      'execution_error',
      'ReferenceError',
      'Intl',
    ],
    ['const = ;', 'syntax_error', 'SyntaxError', ''],
    [
      'await Promise.reject(new TypeError("broken"));',
      'execution_error',
      'TypeError',
      'broken',
    ],
    ['throw "literal";', 'execution_error', 'ThrownValue', 'literal'],
    ['throw null;', 'execution_error', 'ThrownValue', 'null'],
    ['throw {};', 'execution_error', undefined, 'without a readable'],
  ] as const) {
    const r = await startExecution({ code, timeoutMs: 3000 }).result;
    assert.equal(r.status, 'failed');
    if (r.status === 'failed') {
      assert.equal(r.error, error);
      assert.ok(isExecutionDiagnostic(r.diagnostic));
      assert.equal(
        r.diagnostic.phase,
        error === 'syntax_error' ? 'compile' : 'execute',
      );
      if (name) {
        assert.equal(r.diagnostic.name, name);
      }
      assert.ok(r.diagnostic.message.includes(text));
    }
  }
});

test('diagnostic extraction has a budget, captures pristine builtins and bounds multibyte output', async () => {
  for (const code of [
    'throw {get name(){while(true){}}};',
    'throw new Proxy({}, {get(){while(true){}}});',
  ]) {
    const r = await startExecution({ code, timeoutMs: 3000 }).result;
    assert.equal(r.status, 'failed');
    if (r.status === 'failed') {
      assert.equal(r.error, 'execution_error');
      assert.match(r.diagnostic!.message, /could not be safely extracted/);
    }
  }
  const mutated = await startExecution({
    code: 'JSON.stringify=()=>{while(true){}};String.prototype.slice=()=>{while(true){}};Object.create=()=>{while(true){}};Object.prototype.toJSON=()=>{while(true){}};throw new Error("kept");',
    timeoutMs: 3000,
  }).result;
  assert.equal(mutated.status, 'failed');
  if (mutated.status === 'failed') {
    assert.equal(mutated.diagnostic?.message, 'kept');
  }
  const huge = await startExecution({
    code: 'throw new Error("汉😀\\u0000".repeat(10000));',
    timeoutMs: 3000,
  }).result;
  assert.equal(huge.status, 'failed');
  if (huge.status === 'failed') {
    assert.ok(isExecutionDiagnostic(huge.diagnostic));
    assert.equal(huge.diagnostic.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(huge.diagnostic)) <= 8192);
  }
  const wrong = await startExecution({ code: 'return 5n;', timeoutMs: 3000 })
    .result;
  assert.equal(wrong.status, 'failed');
  if (wrong.status === 'failed') {
    assert.equal(wrong.error, 'invalid_return_type');
    assert.match(wrong.diagnostic!.message, /bigint/);
  }
});

test('diagnostic validator rejects malformed, inherited, accessor and oversized fields', () => {
  const good = {
    kind: 'guest_exception',
    phase: 'execute',
    message: 'ok',
    truncated: false,
  };
  assert.ok(isExecutionDiagnostic(good));
  for (const d of [
    { ...good, extra: 1 },
    { ...good, message: 'x'.repeat(8192) },
    { ...good, kind: {} },
    Object.create(good),
    {
      ...good,
      get message() {
        throw new Error('must not execute');
      },
    },
  ]) {
    assert.equal(isExecutionDiagnostic(d), false);
  }
});

test('isolated async function returns only primitive strings and supports BigInt', async () => {
  const r = await startExecution({
    code: 'let x=1n;for(let i=2n;i<=114n;i++)x*=i;return x.toString();',
    timeoutMs: 5000,
  }).result;
  assert.equal(r.status, 'completed');
  if (r.status === 'completed') {
    assert.equal(r.value.length, 187);
  }
  const a = await startExecution({
    code: 'return await Promise.resolve("42");',
    timeoutMs: 5000,
  }).result;
  assert.deepEqual(a, { status: 'completed', value: '42', logs: [] });
  for (const code of [
    'return 42;',
    'return {};',
    'return undefined;',
    'return new String("x");',
  ]) {
    assert.equal(
      (await startExecution({ code, timeoutMs: 5000 }).result).status,
      'failed',
    );
  }
});

test('no Node or network capabilities, fresh globals', async () => {
  assert.deepEqual(
    await startExecution({
      code: 'globalThis.secret=1;return [typeof process,typeof require,typeof fetch].join(",");',
      timeoutMs: 5000,
    }).result,
    { status: 'completed', value: 'undefined,undefined,undefined', logs: [] },
  );
  assert.deepEqual(
    await startExecution({ code: 'return typeof secret;', timeoutMs: 5000 })
      .result,
    { status: 'completed', value: 'undefined', logs: [] },
  );
});

test('external cancellation terminates unresolved promise and CPU loop', async () => {
  for (const code of [
    'await new Promise(()=>{});return "x";',
    'while(true){}',
  ]) {
    const handle = startExecution({ code });
    setTimeout(handle.cancel, 200);
    assert.equal((await handle.result).status, 'cancelled');
  }
});

test('OOM and infinite microtasks are contained and executor remains usable', async () => {
  const oom = await startExecution({
    code: 'const xs=[];while(true)xs.push(new Array(10000).fill("x"));',
    memoryBytes: 2 * 1024 * 1024,
    timeoutMs: 5000,
  }).result;
  assert.equal(oom.status, 'failed');
  const handle = startExecution({
    code: 'await new Promise(()=>{function loop(){Promise.resolve().then(loop)}loop()});return "never";',
  });
  setTimeout(handle.cancel, 500);
  assert.equal((await handle.result).status, 'cancelled');
  assert.deepEqual(
    await startExecution({ code: 'return "still alive";', timeoutMs: 5000 })
      .result,
    { status: 'completed', value: 'still alive', logs: [] },
  );
});

test('return and log boundaries never invoke guest object conversions', async () => {
  for (const expression of [
    '({toString(){while(true){}}})',
    'new Proxy({}, {get(){while(true){}}})',
  ]) {
    const r = await startExecution({
      code: `return ${expression};`,
      timeoutMs: 3000,
    }).result;
    assert.equal(r.status, 'failed');
    if (r.status === 'failed') {
      assert.ok(['invalid_return_type', 'execution_timeout'].includes(r.error));
    }
    const log = await startExecution({
      code: `console.log(${expression});return "bad";`,
      timeoutMs: 3000,
    }).result;
    assert.equal(log.status, 'failed');
    if (log.status === 'failed') {
      assert.ok(['invalid_log_type', 'execution_timeout'].includes(log.error));
    }
  }
  const value = await startExecution({
    code: 'String.prototype.toString=function(){while(true){}};Object.defineProperty(String.prototype,"length",{get(){while(true){}}});return "safe";',
    timeoutMs: 3000,
  }).result;
  // String.prototype.length不可配置；拒绝这一修改同样安全。
  assert.ok(
    value.status === 'completed' ||
      (value.status === 'failed' && value.error === 'execution_error'),
  );
  const multi = await startExecution({
    code: 'console.log("12345","12345");return "x";',
    logBytes: 10,
    timeoutMs: 3000,
  }).result;
  assert.equal(multi.status, 'failed');
  if (multi.status === 'failed') {
    assert.equal(multi.error, 'logs_too_large');
    assert.equal(multi.diagnostic?.kind, 'contract_error');
  }
});

test('watchdog terminates runaway work and bounds strings', async () => {
  const timed = await startExecution({ code: 'while(true){}', timeoutMs: 100 })
    .result;
  assert.equal(timed.status, 'failed');
  const large = await startExecution({
    code: 'return "x".repeat(1000);',
    resultBytes: 10,
    timeoutMs: 5000,
  }).result;
  assert.equal(large.status, 'failed');
  if (large.status === 'failed') {
    assert.equal(large.error, 'output_too_large');
    assert.equal(large.diagnostic?.kind, 'contract_error');
  }
  const log = await startExecution({
    code: 'console.log("ok");return "done";',
    timeoutMs: 5000,
  }).result;
  assert.deepEqual(log, { status: 'completed', value: 'done', logs: ['ok'] });
  assert.throws(
    () => startExecution({ code: 'x'.repeat(10), codeBytes: 2 }),
    /code_too_large/,
  );
});
