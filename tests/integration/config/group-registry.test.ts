import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
  chmodSync,
  unlinkSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppConfig } from '../../../src/config/loader.ts';
import {
  GroupRegistry,
  readGroupRegistry,
} from '../../../src/config/group-registry.ts';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'group-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'persona.md'), 'test persona');
  writeFileSync(
    join(dir, 'config.toml'),
    '[bot]\nowner_id="7001"\n[model]\nmodel="fixture-model"\n[storage]\ndirectory="data"\n[defaults]\nenabled=true\npersona="persona.md"\n[groups."2"]\nenabled=false\n',
  );
  const app = loadAppConfig({
    configPath: join(dir, 'config.toml'),
    env: { ONEBOT_ACCESS_TOKEN: 'test-token', OPENAI_API_KEY: 'fixture-key' },
  });
  return { dir, app, path: app.storage.registryPath };
}

test('atomic private registry lists only enabled membership and closes to an empty snapshot', (t) => {
  const f = fixture(t),
    registry = new GroupRegistry(f.app);
  t.after(() => registry.close());
  assert.deepEqual(readGroupRegistry(f.app), []);
  registry.update(['1', '2', '3']);
  assert.deepEqual(
    readGroupRegistry(f.app).map((row) => row.groupId),
    ['1', '3'],
  );
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['groups', 'updatedAt']);
  assert.deepEqual(Object.keys(raw.groups[0]).sort(), [
    'databasePath',
    'groupId',
  ]);
  registry.close();
  assert.deepEqual(readGroupRegistry(f.app), []);
});

test('registry cannot authorize arbitrary paths, duplicate/missing identity or expired metadata', (t) => {
  const f = fixture(t),
    registry = new GroupRegistry(f.app);
  t.after(() => registry.close());
  registry.update(['1']);
  const valid = {
    groupId: '1',
    databasePath: f.app.resolveGroup('1').storage.databasePath,
  };
  for (const value of [
    {
      updatedAt: Date.now(),
      groups: [{ ...valid, databasePath: '/etc/passwd' }],
    },
    { updatedAt: Date.now(), groups: [{ databasePath: valid.databasePath }] },
    { updatedAt: Date.now(), groups: [valid, valid] },
    { updatedAt: Date.now() - 180000, groups: [valid] },
    { updatedAt: Date.now() + 60000, groups: [valid] },
  ]) {
    writeFileSync(f.path, JSON.stringify(value));
    assert.deepEqual(readGroupRegistry(f.app), []);
  }
  registry.close();
});

test('registry rejects writable metadata and symlink substitution without following the target', (t) => {
  const f = fixture(t),
    registry = new GroupRegistry(f.app);
  t.after(() => registry.close());
  registry.update(['1']);
  chmodSync(f.path, 0o666);
  assert.deepEqual(readGroupRegistry(f.app), []);
  chmodSync(f.path, 0o600);
  const other = join(f.dir, 'foreign.json');
  writeFileSync(other, readFileSync(f.path), { mode: 0o600 });
  unlinkSync(f.path);
  symlinkSync(other, f.path);
  assert.deepEqual(readGroupRegistry(f.app), []);
  registry.close();
  assert.equal(statSync(other).size > 0, true);
});
