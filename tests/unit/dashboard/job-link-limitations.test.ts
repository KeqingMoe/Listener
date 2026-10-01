import test from 'node:test';
import assert from 'node:assert/strict';
import { jobLinkLimitations } from '../../../src/dashboard/web/src/components/review/job-link-limitations.ts';

test('job link coverage limits distinguish old inbox history from matched missing records', () => {
  const coverage = jobLinkLimitations(
    ['inbox_limit', 'tool_result_limit'],
    true,
  );
  assert.equal(coverage.length, 2);
  assert.ok(coverage[0]?.includes('不表示本任务的记录缺失'));
  assert.ok(coverage[1]?.includes('最近 2000'));
  assert.ok(!coverage.join('').includes('已匹配到本任务'));
  assert.ok(
    jobLinkLimitations(['linked_record_missing'], true)[0]?.includes(
      '已匹配到本任务',
    ),
  );
});

test('job link limit diagnostics deduplicate and preserve unknown legacy coverage without inventing a reason', () => {
  assert.deepEqual(jobLinkLimitations(undefined, false), []);
  assert.equal(
    jobLinkLimitations(['byte_limit', 'byte_limit'], true).length,
    1,
  );
  assert.ok(
    jobLinkLimitations(undefined, true)[0]?.includes('未提供具体限制原因'),
  );
  for (const code of [
    'future_limit',
    '__proto__',
    '<img src=x onerror=alert(1)>',
  ]) {
    assert.deepEqual(jobLinkLimitations([code], true), [
      '检索遇到未识别的覆盖限制，不能保证已查遍关联记录。',
    ]);
  }
});
