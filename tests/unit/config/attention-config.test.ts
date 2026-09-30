import test from 'node:test';
import { withFixtureModel } from '../../support/config-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppConfig } from '../../../src/config/loader.ts';
import { ConfigError } from '../../../src/config/errors.ts';
import type { AppConfig } from '../../../src/config/app.ts';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'attention-policy-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts/listener.md'), 'persona');
  return (source: string): AppConfig => {
    writeFileSync(join(dir, 'config.toml'), withFixtureModel(source));
    return loadAppConfig({
      configPath: join(dir, 'config.toml'),
      env: { ONEBOT_ACCESS_TOKEN: 'fixture', OPENAI_API_KEY: 'fixture-key' },
    });
  };
}

test('manage_attention defaults direct without enabling a group or random participation', (t) => {
  const load = fixture(t),
    base = load('');
  assert.deepEqual(base.resolveGroup('11').tools.manage_attention, {
    mode: 'direct',
    maxPlans: 16,
  });
  const app = load('[defaults.tools]\nmanage_attention="direct"');
  assert.deepEqual(app.resolveGroup('11').tools.manage_attention, {
    mode: 'direct',
    maxPlans: 16,
  });
  assert.equal(app.defaultsEnabled, false);
  assert.equal(app.resolveGroup('11').enabled, false);
  assert.equal(app.resolveGroup('11').reply.random, false);
});

test('attention union replacement resets options, absent policy inherits, and result copies are isolated', (t) => {
  const app = fixture(t)(
    '[defaults.tools]\nmanage_attention={mode="direct",max_plans=24}\n[groups."11".tools]\nmanage_attention="off"\n[groups."22".tools]\nmanage_attention="direct"\n[groups."33".tools]\nmanage_attention={mode="direct",max_plans=7}',
  );
  assert.equal(app.resolveGroup('11').tools.manage_attention.mode, 'off');
  assert.deepEqual(app.resolveGroup('22').tools.manage_attention, {
    mode: 'direct',
    maxPlans: 16,
  });
  assert.deepEqual(app.resolveGroup('33').tools.manage_attention, {
    mode: 'direct',
    maxPlans: 7,
  });
  const g = app.resolveGroup('99');
  assert.deepEqual(g.tools.manage_attention, { mode: 'direct', maxPlans: 24 });
  g.tools.manage_attention.maxPlans = 1;
  assert.equal(app.resolveGroup('99').tools.manage_attention.maxPlans, 24);
});

test('attention capacity endpoints are accepted in defaults and disabled group policy', (t) => {
  const load = fixture(t);
  for (const scope of ['defaults.tools', 'groups."11".tools']) {
    for (const value of [1, 16, 32]) {
      assert.equal(
        load(
          `[groups."11"]\nenabled=false\n[${scope}]\nmanage_attention={mode="direct",max_plans=${value}}`,
        ).resolveGroup('11').tools.manage_attention.maxPlans,
        value,
      );
    }
  }
});

test('attention rejects off objects, confirm, malformed capacity and unknown fields even when the group is disabled', (t) => {
  const load = fixture(t);
  for (const scope of ['defaults.tools', 'groups."11".tools']) {
    for (const value of [
      '0',
      '33',
      '-1',
      '1.5',
      'nan',
      'inf',
      '-inf',
      '9007199254740992',
      '"16"',
      'true',
      '[]',
      '{}',
    ]) {
      assert.throws(
        () =>
          load(
            `[groups."11"]\nenabled=false\n[${scope}]\nmanage_attention={mode="direct",max_plans=${value}}`,
          ),
        ConfigError,
      );
    }
    for (const value of [
      'true',
      'false',
      '[]',
      '16',
      '{}',
      '"confirm"',
      '{mode="confirm"}',
      '{mode="off"}',
      '{mode="off",max_plans=16}',
      '{mode="direct",maxPlans=16}',
      '{mode="direct",enabled=true}',
      '{mode="direct",unexpected="PRIVATE_VALUE"}',
    ]) {
      assert.throws(
        () =>
          load(
            `[groups."11"]\nenabled=false\n[${scope}]\nmanage_attention=${value}`,
          ),
        (e) => e instanceof ConfigError && !e.message.includes('PRIVATE_VALUE'),
      );
    }
  }
  for (const scope of ['', '[defaults]\n', '[groups."11"]\nenabled=false\n']) {
    assert.throws(
      () => load(scope + 'attention={enabled=true,max_plans=16}'),
      ConfigError,
    );
  }
});

test('attention and random participation are independent unions rather than inherited product flags', (t) => {
  const app = fixture(t)(
    '[defaults.reply]\nrandom={probability=0.42,cooldown_ms=1000,max_per_minute=6}\n[defaults.tools]\nmanage_attention="direct"\n[groups."11".reply]\nrandom=false\n[groups."22".reply]\nrandom={probability=0}\n[groups."33".tools]\nmanage_attention="off"',
  );
  assert.equal(app.resolveGroup('11').reply.random, false);
  assert.equal(app.resolveGroup('11').tools.manage_attention.mode, 'direct');
  assert.deepEqual(app.resolveGroup('22').reply.random, {
    probability: 0,
    cooldownMs: 60000,
    maxPerMinute: 2,
  });
  assert.deepEqual(app.resolveGroup('33').reply.random, {
    probability: 0.42,
    cooldownMs: 1000,
    maxPerMinute: 6,
  });
  assert.equal(app.resolveGroup('33').tools.manage_attention.mode, 'off');
});
