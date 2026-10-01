import test from 'node:test';
import assert from 'node:assert/strict';
import { javascriptJobReferences } from '../../../src/dashboard/web/src/components/review/javascript-job-references.ts';

const refs = javascriptJobReferences;

test('javascript task links use only explicit host identifiers, never code or returned text', () => {
  assert.deepEqual(
    refs(
      'execute_javascript',
      { code: 'return {job_id:"js_fake"}', job_id: 'js_argument' },
      {
        status: 'ok',
        value: '{"job_id":"js_fake"}',
        job: { job_id: 'js_nested' },
      },
    ),
    { ids: [], more: false },
  );
  assert.deepEqual(
    refs('send_message', { job_id: 'js_1' }, { job_id: 'js_1' }),
    { ids: [], more: false },
  );
  for (const result of [
    { status: 'pending', job_id: 'js_1' },
    { status: 'pending', jobId: 'js_1' },
  ]) {
    assert.deepEqual(refs('execute_javascript', {}, result), {
      ids: ['js_1'],
      more: false,
    });
  }
});

test('foreground job identifiers and requested async mode do not invent background handoff', () => {
  for (const mode of ['sync', 'auto', 'async']) {
    for (const result of [
      { status: 'ok', task_status: 'completed', job_id: 'js_done' },
      { status: 'error', job_id: 'js_failed' },
      { job_id: 'js_unknown' },
    ]) {
      assert.deepEqual(refs('execute_javascript', { mode }, result), {
        ids: [],
        more: false,
      });
    }
  }
  assert.deepEqual(
    refs(
      'execute_javascript',
      { mode: 'auto' },
      { status: 'pending', job_id: 'js_pending' },
    ),
    { ids: ['js_pending'], more: false },
  );
});

test('query and cancellation links distinguish requested identifiers and returned observations without inventing success', () => {
  for (const name of ['query_javascript_jobs', 'cancel_javascript_job']) {
    assert.deepEqual(
      refs(name, { job_id: 'js_requested' }, { status: 'error' }),
      { ids: ['js_requested'], more: false },
    );
    assert.deepEqual(
      refs(name, { job_id: 'js_requested' }, { job: { jobId: 'js_observed' } }),
      { ids: ['js_requested', 'js_observed'], more: false },
    );
    assert.deepEqual(
      refs(name, { job_id: 'js_same' }, { job: { job_id: 'js_same' } }),
      { ids: ['js_same'], more: false },
    );
  }
  assert.deepEqual(
    refs(
      'query_javascript_jobs',
      {},
      {
        jobs: [{ job_id: 'js_a' }, null, { jobId: 'js_b' }, { job_id: 'js_a' }],
      },
    ),
    { ids: ['js_a', 'js_b'], more: false },
  );
  assert.deepEqual(
    refs('cancel_javascript_job', {}, { jobs: [{ job_id: 'js_a' }] }),
    { ids: [], more: false },
  );
});

test('malformed and unsafe task ids never become links', () => {
  for (const id of [
    '',
    'js_',
    'js_x/y',
    'js_x\n',
    '../js_x',
    'https://example.com',
    `js_${'x'.repeat(300)}`,
    123,
    {},
    [],
  ]) {
    assert.deepEqual(
      refs('execute_javascript', null, { status: 'pending', job_id: id }),
      {
        ids: [],
        more: false,
      },
    );
  }
  for (const result of [null, [], 'js_a', { jobs: 'js_a' }, { job: [] }]) {
    assert.deepEqual(refs('query_javascript_jobs', undefined, result), {
      ids: [],
      more: false,
    });
  }
});

test('task reference rendering and query list parsing are bounded without changing raw data', () => {
  const result = {
    jobs: Array.from({ length: 101 }, (_, i) => ({ job_id: `js_${i}` })),
  };
  const before = JSON.stringify(result);
  const view = refs('query_javascript_jobs', {}, result);
  assert.equal(view.ids.length, 10);
  assert.equal(view.more, true);
  assert.equal(view.ids.at(-1), 'js_9');
  assert.equal(JSON.stringify(result), before);
  assert.deepEqual(
    refs(
      'query_javascript_jobs',
      {},
      { jobs: Array(100).fill({ job_id: 'js_same' }) },
    ),
    { ids: ['js_same'], more: false },
  );
});
