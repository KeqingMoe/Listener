import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactToolView } from '../../../src/dashboard/web/src/components/review/artifact-tool-view.ts';
import type { ReviewTool } from '../../../src/dashboard/contracts/review.ts';

type Input = Parameters<typeof artifactToolView>[0];

const info = {
  artifact_id: 'art_123',
  name: 'zero.txt',
  description: 'empty',
  media_type: 'text/plain',
  size: 0,
  sha256: 'a'.repeat(64),
  created_at: '2000-01-01T00:00:00.000Z',
  expires_at: '2000-01-02T00:00:00+08:00',
};

function run(
  name: string,
  result: unknown = null,
  args: unknown = {},
  extra: Partial<Input> = {},
) {
  return artifactToolView({
    name,
    arguments: args,
    result,
    state: 'finished',
    outcome: 'handled',
    ...extra,
  })!;
}

test('recognizes only six names, never nested code/value artifacts', () => {
  for (const name of [
    'execute_javascript',
    'query_javascript_jobs',
    'constructor',
    '__proto__',
    'other',
  ]) {
    assert.equal(run(name, { status: 'ok', ...info }), null);
  }
  const view = run('create_artifact', {
    status: 'error',
    value: info,
    artifactInfo: info,
    code: JSON.stringify(info),
  });
  assert.deepEqual(view.artifacts, []);
  assert.equal(view.resultNote, null);
  assert.deepEqual(view.notices, []);
});

test('create preserves 0 bytes and ISO snapshots without request backfill', () => {
  const view = run(
    'create_artifact',
    { status: 'ok', ...info },
    { name: 'request', description: 'requested', ttl_ms: 50 },
  );
  assert.equal(view.artifacts[0]!.size, 0);
  assert.equal(view.artifacts[0]!.name, 'zero.txt');
  assert.equal(view.artifacts[0]!.expiresAt, info.expires_at);
  assert.equal(view.resultNote, '返回记录报告已生成产物，不代表已上传或发送');
  assert.ok(view.requested.some((v) => v.value.includes('请求默认')));
  assert.ok(view.notices.some((v) => v.includes('快照')));
  const failed = run(
    'create_artifact',
    { status: 'error' },
    { name: 'requested' },
  );
  assert.deepEqual(failed.artifacts, []);
  assert.deepEqual(failed.notices, []);
  const missing = run(
    'create_artifact',
    { status: 'ok', artifact_id: 'a' },
    { name: 'requested' },
  );
  assert.equal(missing.artifacts[0]!.name, '');
  assert.equal(missing.artifacts[0]!.mediaType, '');
  assert.ok(missing.notices.some((v) => v.includes('sha256')));
  assert.deepEqual(run('create_artifact', null, null).requested, []);
});

test('create confirmation respects ledger and contradictory flags', () => {
  for (const extra of [
    { state: 'unknown' },
    { state: 'pending' },
    { outcome: 'cancelled' as ReviewTool['outcome'] },
  ]) {
    const view = run(
      'create_image',
      { status: 'ok', ...info, width: 1, height: 2 },
      {},
      extra,
    );
    assert.equal(view.artifacts[0]!.width, 1);
    assert.match(view.resultNote!, /不足以确认生成成功/);
  }
  for (const flag of [
    'submitted',
    'effect_unknown',
    'duplicate',
    'cancelled_after_dispatch',
  ]) {
    assert.match(
      run('create_artifact', { status: 'ok', ...info, [flag]: true })
        .resultNote!,
      /不足以确认生成成功/,
    );
  }
  for (const status of [
    'error',
    'unknown',
    'confirmation_required',
    'staged',
    'submitted',
  ]) {
    assert.equal(run('create_artifact', { status, ...info }).resultNote, null);
  }
});

test('malformed control flags fail closed despite otherwise successful evidence', () => {
  const cases = [
    {
      name: 'create_artifact',
      result: { status: 'ok', ...info },
      positive: '返回记录报告已生成产物，不代表已上传或发送',
    },
    {
      name: 'upload_group_file',
      result: {
        status: 'ok',
        uploaded: true,
        effect_confirmed: true,
        resource_id_available: true,
      },
      positive: '工具明确回报上传成功',
    },
    {
      name: 'send_group_image',
      result: { status: 'executed', message_id: 'm' },
      positive: '工具回报发送已执行，不代表已读。',
    },
  ];
  for (const { name, result, positive } of cases) {
    assert.equal(run(name, result).resultNote, positive);
    for (const flag of [
      'effect_unknown',
      'submitted',
      'cancelled_after_dispatch',
      'duplicate',
      'effect_confirmed',
    ]) {
      for (const value of ['false', 'true', 0, 1, null, undefined, {}, []]) {
        const view = run(name, { ...result, [flag]: value });
        assert.notEqual(view.resultNote, positive, `${name}: ${flag}`);
        assert.ok(view.notices.some((n) => n.includes(flag)));
      }
    }
    assert.notEqual(
      run(name, { ...result, effect_confirmed: false }).resultNote,
      positive,
    );
    assert.equal(
      run(name, { ...result, confirmation: 'irrelevant' }).resultNote,
      positive,
    );
    for (const flag of [
      'effect_unknown',
      'submitted',
      'cancelled_after_dispatch',
      'duplicate',
    ]) {
      assert.equal(
        run(name, { ...result, [flag]: false }).resultNote,
        positive,
      );
    }
  }
});

test('known non-success ledger outcomes are not mislabeled as unknown', () => {
  for (const outcome of [
    'failed',
    'rejected',
    'cancelled',
  ] as ReviewTool['outcome'][]) {
    const view = run(
      'create_artifact',
      { status: 'ok', ...info },
      {},
      { outcome },
    );
    assert.equal(
      view.resultNote,
      '返回记录包含产物字段，但不足以确认生成成功。',
    );
    assert.ok(
      view.notices.includes('未获得成功执行的确认；以下仅保留已有返回字段。'),
    );
    assert.ok(!view.notices.some((n) => n.includes('调用未确认')));
  }
});

test('metadata bounds count code points and never split emoji pairs', () => {
  const name = 'a'.repeat(127) + '😀';
  const description = 'a'.repeat(499) + '😀';
  const view = run('create_artifact', {
    status: 'ok',
    ...info,
    name,
    description,
  });
  assert.equal(view.artifacts[0]!.name, name);
  assert.equal(view.artifacts[0]!.description, description);
  assert.ok(!view.notices.some((n) => n.includes('截短')));
  const truncated = run('create_artifact', {
    status: 'ok',
    ...info,
    name: name + 'x',
    description: description + 'x',
  });
  assert.equal(truncated.artifacts[0]!.name, name + '…（已截短）');
  assert.equal(
    truncated.artifacts[0]!.description,
    description + '…（已截短）',
  );
  assert.ok(truncated.notices.some((n) => n.includes('Unicode码点')));
});

test('validates hashes, safe integers, dimensions and strict calendar timestamps', () => {
  for (const size of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    assert.equal(
      run('create_artifact', { status: 'ok', ...info, size }).artifacts[0]!
        .size,
      null,
    );
  }
  for (const stamp of [
    'yesterday',
    '2024-02-30T00:00:00Z',
    '2023-02-29T00:00:00Z',
    '2024-01-01',
    '2024-01-01T24:00:00Z',
    123,
  ]) {
    const view = run('create_artifact', {
      status: 'ok',
      ...info,
      expires_at: stamp,
    });
    assert.equal(view.artifacts[0]!.expiresAt, null);
    assert.ok(view.notices.some((n) => n.includes('expires_at')));
  }
  assert.equal(
    run('create_artifact', {
      status: 'ok',
      ...info,
      created_at: '2024-02-29T12:34:56.123Z',
    }).artifacts[0]!.createdAt,
    '2024-02-29T12:34:56.123Z',
  );
  const view = run(
    'create_image',
    { status: 'ok', ...info, sha256: 'bad', width: 0, height: 1.5 },
    { width: 2, height: 3, format: 'png' },
  );
  assert.equal(view.artifacts[0]!.sha256, null);
  assert.equal(view.artifacts[0]!.width, null);
  assert.equal(view.artifacts[0]!.height, null);
  assert.equal(view.requested.find((r) => r.label === 'width')!.value, '2');
});

test('upload requires exact flags; absent resource ID is not failure', () => {
  const result = {
    status: 'ok',
    uploaded: true,
    effect_confirmed: true,
    resource_id_available: false,
  };
  const view = run('upload_group_file', result, {
    artifact_id: 'a',
    folder_handle: 'folder',
    image_id: 'ignore',
  });
  assert.equal(view.resultNote, '工具明确回报上传成功');
  assert.deepEqual(view.references, [
    { label: 'artifact_id', id: 'a' },
    { label: 'folder_handle', id: 'folder' },
  ]);
  assert.ok(view.notices.some((n) => n.includes('不表示上传失败')));
  for (const patch of [
    { uploaded: false },
    { effect_confirmed: false },
    { uploaded: undefined },
    { submitted: true },
    { effect_unknown: true },
  ]) {
    assert.notEqual(
      run('upload_group_file', { ...result, ...patch }).resultNote,
      '工具明确回报上传成功',
    );
  }
  assert.notEqual(
    run('upload_group_file', result, {}, { state: 'unknown' }).resultNote,
    '工具明确回报上传成功',
  );
  assert.deepEqual(run('upload_group_file', { status: 'error' }).notices, []);
  assert.ok(
    run('upload_group_file', { status: 'error', uploaded: 'yes' }).notices
      .length,
  );
});

test('send preserves message ID only from result, flags conflicting requests', () => {
  const view = run(
    'send_group_image',
    { status: 'executed', message_id: 'm', local_projection_failed: true },
    { artifact_id: 'a', image_id: 'b' },
  );
  assert.equal(view.messageId, 'm');
  assert.match(view.resultNote!, /发送已执行，不代表已读/);
  assert.ok(view.notices.some((n) => n.includes('冲突')));
  assert.ok(view.notices.some((n) => n.includes('本地记录同步失败')));
  assert.equal(
    run(
      'send_group_image',
      { status: 'executed' },
      { message_id: 'fake', artifact_id: 'a' },
    ).messageId,
    null,
  );
  for (const status of [
    'ok',
    'unknown',
    'error',
    'confirmation_required',
    'submitted',
    'staged',
  ]) {
    assert.equal(
      run('send_group_image', { status, message_id: 'm' }).resultNote,
      null,
    );
  }
  assert.equal(
    run(
      'send_group_image',
      { status: 'executed', message_id: 'm' },
      {},
      { state: 'started' },
    ).resultNote,
    null,
  );
});

test('list empty requires settled ok, a real empty array and false has_more', () => {
  assert.equal(
    run('list_artifacts', { status: 'ok', artifacts: [], has_more: false })
      .empty,
    true,
  );
  for (const result of [
    null,
    { status: 'error' },
    { status: 'ok', artifacts: [] },
    { status: 'ok', artifacts: [], has_more: true },
    { status: 'ok', artifacts: [], has_more: 'false' },
    { status: 'ok', has_more: false },
    { status: 'error', artifacts: [], has_more: false },
  ]) {
    assert.equal(run('list_artifacts', result).empty, false);
  }
  assert.equal(
    run(
      'list_artifacts',
      { status: 'ok', artifacts: [], has_more: false },
      {},
      { state: 'unknown' },
    ).empty,
    false,
  );
  const view = run('list_artifacts', {
    status: 'ok',
    artifacts: [info],
    has_more: false,
  });
  assert.equal(view.artifacts[0]!.id, info.artifact_id);
  assert.equal(view.empty, false);
});

test('list requests preserve tail-page scope, validated range and explicit defaults', () => {
  for (const artifacts of [[info], []]) {
    const view = run(
      'list_artifacts',
      { status: 'ok', artifacts, has_more: false },
      { offset: 40, limit: 10 },
    );
    assert.deepEqual(view.requested, [
      { label: 'offset', value: '40' },
      { label: 'limit', value: '10' },
    ]);
    assert.ok(
      view.notices.includes('请求从该偏移开始，本页结果不能代表偏移前的内容。'),
    );
    assert.equal(view.empty, artifacts.length === 0);
  }
  assert.deepEqual(run('list_artifacts', null, {}).requested, [
    { label: 'offset', value: '0（请求默认）' },
    { label: 'limit', value: '20（请求默认）' },
  ]);
  for (const args of [null, 'bad', []]) {
    assert.deepEqual(run('list_artifacts', null, args).requested, []);
  }
  assert.deepEqual(
    artifactToolView({
      name: 'list_artifacts',
      state: 'pending',
      outcome: 'handled',
      arguments: undefined,
      result: null,
    })!.requested,
    [],
  );
  for (const key of ['offset', 'limit']) {
    for (const value of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '20',
      null,
      undefined,
    ]) {
      const view = run('list_artifacts', null, { [key]: value });
      assert.ok(!view.requested.some((r) => r.label === key));
      assert.ok(view.notices.some((n) => n.includes(key)));
    }
  }
  assert.ok(
    !run('list_artifacts', null, { limit: 0 }).requested.some(
      (r) => r.label === 'limit',
    ),
  );
  const first = run('list_artifacts', null, { offset: 0, limit: 1 });
  assert.deepEqual(first.requested, [
    { label: 'offset', value: '0' },
    { label: 'limit', value: '1' },
  ]);
  assert.ok(!first.notices.some((n) => n.includes('偏移前')));
});

test('view_images independently preserves loaded/failed and never reads images/pixels', () => {
  const result = {
    status: 'partial',
    loaded_ids: ['loaded'],
    failed_ids: ['failed'],
    get images(): never {
      throw new Error('images accessed');
    },
  };
  const view = run('view_images', result, { image_ids: ['request'] });
  assert.deepEqual(view.loadedIds, ['loaded']);
  assert.deepEqual(view.failedIds, ['failed']);
  assert.deepEqual(view.references, [{ label: 'image_ids', id: 'request' }]);
  assert.match(view.resultNote!, /工具报告已加载ID/);
  assert.equal(view.messageId, null);
  assert.deepEqual(run('view_images', { status: 'error' }).notices, []);
});

test('caps traversal at 100 artifacts and 20 IDs, including sparse huge arrays', () => {
  const artifacts = Array(1000000).fill(null, 0, 100);
  for (let i = 0; i < 100; i++) {
    artifacts[i] = info;
  }
  Object.defineProperty(artifacts, 100, {
    get() {
      throw new Error('traversed beyond cap');
    },
  });
  const list = run('list_artifacts', {
    status: 'ok',
    artifacts,
    has_more: false,
  });
  assert.equal(list.artifacts.length, 100);
  assert.ok(list.notices.some((n) => n.includes('前 100')));
  const ids = Array(1000000).fill('id', 0, 20);
  Object.defineProperty(ids, 20, {
    get() {
      throw new Error('traversed beyond cap');
    },
  });
  const view = run(
    'view_images',
    { status: 'ok', loaded_ids: ids, failed_ids: ids },
    { image_ids: ids },
  );
  assert.equal(view.loadedIds.length, 20);
  assert.equal(view.failedIds.length, 20);
  assert.equal(view.references.length, 20);
  assert.equal(view.notices.filter((n) => n.includes('前 20')).length, 3);
});

test('rejects malformed IDs without truncating; metadata is bounded plain text', () => {
  for (const value of [
    '',
    ' ',
    'a'.repeat(257),
    'a\nb',
    'a\u007fb',
    'a\u0085b',
    12,
    {},
  ]) {
    const view = run(
      'send_group_image',
      { status: 'executed', message_id: value },
      { artifact_id: value },
    );
    assert.equal(view.messageId, null);
    assert.deepEqual(view.references, []);
    assert.ok(view.notices.length);
  }
  const malicious = '<img src=x onerror=alert(1)>';
  const view = run('create_artifact', {
    status: 'ok',
    ...info,
    name: malicious,
    description: 'a'.repeat(10000),
  });
  assert.equal(view.artifacts[0]!.name, malicious);
  assert.ok(view.artifacts[0]!.description.length < 520);
  assert.match(view.artifacts[0]!.description, /已截短/);
  assert.equal('src' in view.artifacts[0]!, false);
  assert.equal('href' in view.artifacts[0]!, false);
});

test('does not mutate frozen data or read content/pixels/nested pseudo artifacts', () => {
  const bomb = {
    get content(): never {
      throw new Error('content accessed');
    },
    get pixels(): never {
      throw new Error('pixels accessed');
    },
    get code(): never {
      throw new Error('code accessed');
    },
    get value(): never {
      throw new Error('value accessed');
    },
  };
  // Define throwing getters without spreading (which would invoke them).
  const guarded = Object.freeze(
    Object.defineProperties(
      { name: 'request' },
      Object.getOwnPropertyDescriptors(bomb),
    ),
  );
  const result = Object.freeze({ status: 'ok', ...info });
  const before = JSON.stringify(result);
  run('create_artifact', result, guarded);
  assert.equal(JSON.stringify(result), before);
  assert.equal(guarded.name, 'request');
});
