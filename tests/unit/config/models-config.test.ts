import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppConfig } from '../../../src/config/loader.ts';
import { ConfigError } from '../../../src/config/errors.ts';

const TWO_MODELS = `
[models.opencode_go]
api_key_env = "MAIN_KEY"
model = "deepseek-v4.1-flash"
transport = "responses"
[models."群友 的模型"]
api_key_env = "FRIEND_KEY"
base_url = "https://friend.example/v1"
model = "deepseek-v4.1-flash"
opencode_headers = true
`;

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'models-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts/listener.md'), 'persona');
  return (
    source: string,
    env: NodeJS.ProcessEnv = {
      ONEBOT_ACCESS_TOKEN: 'fixture',
      MAIN_KEY: 'main-key',
      FRIEND_KEY: 'friend-key',
    },
    dotenv?: string,
  ) => {
    writeFileSync(
      join(dir, 'config.toml'),
      `[bot]\nowner_id = "100000001"\n${source}`,
    );
    if (dotenv !== undefined) {
      writeFileSync(join(dir, '.env'), dotenv);
    }
    return loadAppConfig({ configPath: join(dir, 'config.toml'), env });
  };
}

test('named models are parsed independently and groups select them by name', (t) => {
  const load = fixture(t);
  const app = load(
    `${TWO_MODELS}[defaults]\nmodel = "opencode_go"\n[groups."11"]\nenabled = true\nmodel = "群友 的模型"\n[groups."22"]\nenabled = true\n`,
  );
  assert.deepEqual([...app.models.keys()], ['opencode_go', '群友 的模型']);
  const main = app.models.get('opencode_go')!;
  const friend = app.models.get('群友 的模型')!;
  assert.equal(main.name, 'opencode_go');
  assert.equal(main.apiKey, 'main-key');
  assert.equal(main.transport, 'responses');
  assert.equal(main.baseUrl, 'https://api.openai.com/v1');
  assert.equal(main.opencodeHeaders, false);
  assert.equal(friend.apiKey, 'friend-key');
  assert.equal(friend.transport, 'chat');
  assert.equal(friend.baseUrl, 'https://friend.example/v1');
  assert.equal(friend.opencodeHeaders, true);
  assert.equal(app.resolveGroup('11').model, '群友 的模型');
  assert.equal(app.resolveGroup('22').model, 'opencode_go');
  // 未配置的动态群继承defaults。
  assert.equal(app.resolveGroup('33').model, 'opencode_go');
});

test('a single model is the implicit default; several require an explicit default', (t) => {
  const load = fixture(t);
  const single = load(
    '[models.only]\napi_key_env = "MAIN_KEY"\nmodel = "m"\n[groups."11"]\nenabled = true\n',
  );
  assert.equal(single.resolveGroup('11').model, 'only');
  assert.equal(single.resolveGroup('99').model, 'only');
  assert.throws(
    () => load(`${TWO_MODELS}[groups."11"]\nmodel = "opencode_go"\n`),
    (e) => e instanceof ConfigError && e.message.includes('defaults.model'),
  );
});

test('selecting an undefined or malformed model name is rejected at either scope', (t) => {
  const load = fixture(t);
  for (const [source, field] of <[string, string][]>[
    ['[defaults]\nmodel = "missing"\n', 'defaults.model'],
    [
      '[defaults]\nmodel = "opencode_go"\n[groups."11"]\nmodel = "missing"\n',
      'groups.11.model',
    ],
    ['[defaults]\nmodel = ""\n', 'defaults.model'],
    ['[defaults]\nmodel = 1\n', 'defaults.model'],
  ]) {
    assert.throws(
      () => load(TWO_MODELS + source),
      (e) => e instanceof ConfigError && e.message.includes(field),
    );
  }
  assert.throws(
    () => load('[models]\n'),
    (e) => e instanceof ConfigError && e.message.includes('models'),
  );
  assert.throws(
    () => load('[models." "]\napi_key_env = "MAIN_KEY"\nmodel = "m"\n'),
    (e) => e instanceof ConfigError && e.message.includes('模型名不能为空'),
  );
  assert.throws(
    () =>
      load('[models.a]\napi_key_env = "MAIN_KEY"\nmodel = "m"\nunknown = 1\n'),
    (e) => e instanceof ConfigError && e.message.includes('models.a'),
  );
});

test('every model key is required, and dotenv accepts exactly the selected key variables', (t) => {
  const load = fixture(t);
  const source = `${TWO_MODELS}[defaults]\nmodel = "opencode_go"\n`;
  assert.throws(
    () => load(source, { ONEBOT_ACCESS_TOKEN: 'fixture', MAIN_KEY: 'main' }),
    (e) =>
      e instanceof ConfigError &&
      e.message.includes('models.群友 的模型.api_key_env'),
  );
  const app = load(
    source,
    {},
    'ONEBOT_ACCESS_TOKEN=fixture\nMAIN_KEY=main-dotenv\nFRIEND_KEY=friend-dotenv\n',
  );
  assert.equal(app.models.get('opencode_go')!.apiKey, 'main-dotenv');
  assert.equal(app.models.get('群友 的模型')!.apiKey, 'friend-dotenv');
  assert.throws(
    () =>
      load(
        source,
        {},
        'ONEBOT_ACCESS_TOKEN=fixture\nMAIN_KEY=a\nFRIEND_KEY=b\nOPENAI_API_KEY=c\n',
      ),
    (e) => e instanceof ConfigError && e.message.includes('.env'),
  );
});

test('the removed single [model] table is rejected rather than migrated', (t) => {
  const load = fixture(t);
  assert.throws(
    () =>
      load(
        '[model]\napi_key_env = "MAIN_KEY"\nmodel = "m"\n[models.a]\napi_key_env = "MAIN_KEY"\nmodel = "m"\n',
      ),
    (e) => e instanceof ConfigError && e.message.includes('config'),
  );
});
