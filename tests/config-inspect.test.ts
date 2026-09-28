import test from 'node:test';
import {withFixtureModel} from './config-fixture.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAppConfig } from '../src/config/loader.js';
import { inspectGroupConfig } from '../src/config/inspect.js';

function fixture(t: { after(fn: () => void): void }, text: string) {
  const directory = mkdtempSync(join(tmpdir(), 'config-inspect-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'prompts'));
  writeFileSync(join(directory, 'prompts/listener.md'), 'PRIVATE_PERSONA_BODY');
  writeFileSync(join(directory, '.env'), 'ONEBOT_ACCESS_TOKEN=PRIVATE_BOT_TOKEN\nOPENAI_API_KEY=PRIVATE_MODEL_KEY\n');
  writeFileSync(join(directory, 'config.toml'), withFixtureModel(text));
  const app = loadAppConfig({ configPath: join(directory, 'config.toml'), env: {} });
  return { directory, app };
}

test('inspection explains field inheritance and atomic branch defaults without credentials or persona text', t => {
  const { directory, app } = fixture(t, `
[bot]
owner_id = "100000001"
[defaults]
enabled = false
reply = { cooldown_ms = 9000, random = { probability = 0.2, cooldown_ms = 15000, max_per_minute = 6 } }
session.transport = "responses"
session.compaction.threshold_tokens = 65536
[defaults.tools]
mute_member = { mode = "direct", max_seconds = 120 }
[groups."22"]
enabled = true
reply.random = { probability = 0.1 }
session.compaction = false
tools.mute_member = "confirm"
`);
  const result = inspectGroupConfig(app, '22') as any;
  assert.equal(result.membership, 'not_checked');
  assert.equal(result.values.reply.cooldown_ms, 9000);
  assert.equal(result.values.reply.random.probability, 0.1);
  assert.equal(result.values.reply.random.cooldown_ms, 60000);
  assert.equal(result.values.reply.random.max_per_minute, 2);
  assert.equal(result.sources['reply.cooldown_ms'], 'defaults');
  assert.equal(result.sources['reply.random.probability'], 'group');
  assert.equal(result.sources['reply.random.cooldown_ms'], 'program_default');
  assert.deepEqual(result.values.tools.mute_member, { mode: 'confirm', max_seconds: 600 });
  assert.equal(result.sources['tools.mute_member.mode'], 'group');
  assert.equal(result.sources['tools.mute_member.max_seconds'], 'program_default');
  assert.equal(result.values.session.compaction, false);
  assert.equal(result.sources['session.compaction'], 'group');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PERSONA_BODY|PRIVATE_BOT_TOKEN|PRIVATE_MODEL_KEY/);
  assert.equal(existsSync(join(directory, 'data')), false);
});

test('inspection refuses to mix a loaded policy snapshot with edited source attribution', t => {
  const { directory, app } = fixture(t, '[bot]\nowner_id="100000001"\n[defaults]\nenabled=true\n[groups."22"]\nenabled=false\n');
  writeFileSync(join(directory, 'config.toml'), withFixtureModel('[bot]\nowner_id="100000001"\n[defaults]\nenabled=true\n'));
  assert.equal(app.resolveGroup('22').enabled, false);
  assert.throws(() => inspectGroupConfig(app, '22'), /文件已变化/);
  const fresh = loadAppConfig({ configPath: join(directory, 'config.toml'), env: {} });
  const result = inspectGroupConfig(fresh, '22') as any;
  assert.equal(result.values.enabled, true);
  assert.equal(result.sources.enabled, 'defaults');
});

test('inspection identifies all-group policy but does not assert membership or create storage', t => {
  const { directory, app } = fixture(t, '[bot]\nowner_id="100000001"\n[defaults]\nenabled=true\n[groups."22"]\nenabled=false\n');
  const excluded = inspectGroupConfig(app, '22') as any;
  const dynamic = inspectGroupConfig(app, '33') as any;
  assert.equal(excluded.values.enabled, false);
  assert.equal(excluded.sources.enabled, 'group');
  assert.equal(dynamic.values.enabled, true);
  assert.equal(dynamic.sources.enabled, 'defaults');
  assert.equal(dynamic.membership, 'not_checked');
  assert.equal(existsSync(join(directory, 'data')), false);
});

test('CLI supports explicit group inspection, ordinary checking, and rejects malformed arguments safely', t => {
  const { directory } = fixture(t, '[bot]\nowner_id="100000001"\n[groups."22"]\nenabled=true\n');
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli/config-check.ts'), ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, ONEBOT_ACCESS_TOKEN: 'PRIVATE_ENV_TOKEN', OPENAI_API_KEY: 'PRIVATE_ENV_MODEL_KEY' },
  });
  const normal = run();
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /config valid/);
  const detailed = run('--group', '22');
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(JSON.parse(detailed.stdout).group_id, '22');
  assert.doesNotMatch(detailed.stdout + detailed.stderr, /PRIVATE_/);
  for (const args of [['--group'], ['--group', '01'], ['--group', 'PRIVATE_ARGUMENT'], ['--unexpected'], ['--group', '22', '--extra']]) {
    const invalid = run(...args);
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /PRIVATE_ARGUMENT|PRIVATE_ENV_TOKEN|PRIVATE_MODEL_KEY/);
  }
  assert.equal(existsSync(join(directory, 'data')), false);
});
