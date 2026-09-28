import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { discoverTests } from '../../../scripts/test.mjs';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'test discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name: string) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'throw new Error("Discovery must not execute fixtures");');
    return path;
  };
  return { root, put };
}

test('recursive discovery partitions core and dashboard without omissions or duplicates in stable order', async t => {
  const { root, put } = fixture(t);
  const core = ['protocol/z.test.ts', 'integration/nested/a.test.ts', 'unit/b.test.ts', 'unit/dashboard-like/c.test.ts'].map(put).sort();
  const dashboard = ['unit/dashboard/z.test.ts', 'protocol/dashboard/a.test.ts', 'integration/dashboard/nested/b.test.ts'].map(put).sort();
  assert.deepEqual(await discoverTests(root), core);
  assert.deepEqual(await discoverTests(root, 'core'), core);
  assert.deepEqual(await discoverTests(root, 'dashboard'), dashboard);
  assert.deepEqual(await discoverTests(root, 'all'), [...core, ...dashboard].sort());
  assert.equal(new Set([...core, ...dashboard]).size, core.length + dashboard.length);
});

test('discovery excludes browser, support and fixtures at every depth and only includes test.ts files', async t => {
  const { root, put } = fixture(t);
  const expected = put('unit/real.test.ts');
  for (const path of ['browser/a.spec.ts', 'browser/a.test.ts', 'support/a.test.ts', 'fixtures/a.test.ts',
    'unit/support/a.test.ts', 'integration/dashboard/fixtures/a.test.ts', 'protocol/browser/a.test.ts',
    'unit/a.spec.ts', 'unit/a.test.js', 'unit/a.test.ts.map']) put(path);
  assert.deepEqual(await discoverTests(root, 'all'), [expected]);
});

test('discovery never follows directory or file symlinks, including loops', async t => {
  const { root, put } = fixture(t);
  const expected = put('unit/real.test.ts');
  symlinkSync(join(root, 'unit'), join(root, 'alias'), 'dir');
  symlinkSync(root, join(root, 'unit/loop'), 'dir');
  symlinkSync(expected, join(root, 'linked.test.ts'), 'file');
  assert.deepEqual(await discoverTests(root, 'all'), [expected]);
});

test('discovery rejects invalid scopes and missing roots but returns an empty list for an empty tree', async t => {
  const { root } = fixture(t);
  for (const scope of ['', 'unknown', '--all', null]) {
    await assert.rejects(discoverTests(root, scope), /Invalid test scope/);
  }
  await assert.rejects(discoverTests(join(root, 'absent')), /ENOENT/);
  assert.deepEqual(await discoverTests(root), []);
});

test('CLI rejects invalid scopes and zero discovered tests without invoking a test runner', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'tests'));
  const script = join(root, 'scripts/test.mjs');
  copyFileSync(new URL('../../../scripts/test.mjs', import.meta.url), script);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(script).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  for (const [args, message] of [[['invalid'], /Invalid test scope/], [[], /No tests discovered/], [['dashboard'], /No tests discovered/]] as const) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
  }
});
