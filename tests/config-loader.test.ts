import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigError, loadAppConfig } from '../src/config-loader.js';
import { LISTENER_GROUP, OWNER_ID } from '../src/contracts.js';

function fixture(t: { after(fn: () => void): void }, toml = '') {
  const dir = mkdtempSync(join(tmpdir(), 'listener-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts/listener.md'), '你是 Listener。\n');
  writeFileSync(join(dir, 'config.toml'), toml);
  const load = (env: NodeJS.ProcessEnv = { ONEBOT_ACCESS_TOKEN: 'test-token' }, envPath?: string) => loadAppConfig({ configPath: join(dir, 'config.toml'), env, envPath });
  return { dir, load, config: (value: string) => writeFileSync(join(dir, 'config.toml'), value), dotenv: (value: string) => writeFileSync(join(dir, '.env'), value) };
}

test('minimal config has fixed scope, disabled AI, complete defaults and relative paths', t => {
  const f = fixture(t);
  const c = f.load();
  assert.equal(c.listener.enabled, false);
  assert.equal(c.listener.botName, 'Listener');
  assert.equal(c.listener.ownerName, '時雨てる');
  assert.equal(c.listener.persona, '你是 Listener。\n');
  assert.deepEqual([...c.onebot.allowedGroups], [LISTENER_GROUP]);
  assert.deepEqual([...c.onebot.adminUsers], [OWNER_ID]);
  assert.equal(c.onebot.allowPrivate, false);
  assert.equal(c.onebot.rateLimitMs, 2000);
  assert.equal(c.listener.maxParts, 3);
  assert.equal(c.listener.tools?.moderation.maxMuteSeconds, 600);
  assert.equal(c.personaPath, join(f.dir, 'prompts/listener.md'));
  assert.equal(c.listener.memoryPath, join(f.dir, 'data/listener.sqlite'));
  assert.equal(c.configPath, join(f.dir, 'config.toml'));
});

test('example TOML parses and relative paths are anchored at config directory', t => {
  const example = readFileSync(new URL('../config.example.toml', import.meta.url), 'utf8');
  const f = fixture(t, example);
  assert.equal(f.load().listener.retentionDays, 7);
  f.config('[persona]\nfile="custom.md"\n[memory]\npath="elsewhere/store.sqlite"');
  writeFileSync(join(f.dir, 'custom.md'), 'custom persona');
  writeFileSync(join(f.dir, 'secrets.env'), 'ONEBOT_ACCESS_TOKEN=from-file');
  const c = f.load({}, 'secrets.env');
  assert.equal(c.onebot.token, 'from-file');
  assert.equal(c.personaPath, join(f.dir, 'custom.md'));
  assert.equal(c.listener.memoryPath, join(f.dir, 'elsewhere/store.sqlite'));
});

test('unknown fields and wrong table types fail at every nesting level', t => {
  const f = fixture(t);
  for (const scope of ['', 'bot', 'onebot', 'ai', 'persona', 'reply', 'reply.random', 'memory', 'tools', 'tools.moderation']) {
    f.config(`${scope ? `[${scope}]\n` : ''}SECRET_UNKNOWN_MARKER = 'sensitive'`);
    assert.throws(() => f.load(), e => e instanceof ConfigError && !e.message.includes('SECRET_UNKNOWN_MARKER') && !e.message.includes('sensitive'));
  }
  for (const value of ['true', '[]', '"str"', '123', '1979-05-27T07:32:00Z']) {
    f.config(`reply = ${value}`);
    assert.throws(() => f.load(), ConfigError);
  }
  f.config('[reply]\nrandom = 1');
  assert.throws(() => f.load(), ConfigError);
});

test('all numeric bounds are strict, finite and integers except probability', t => {
  const f = fixture(t);
  const ranges: [string, string, number, number][] = [
    ['onebot', 'api_timeout_ms', 1, 2147483647], ['onebot', 'heartbeat_ms', 1, 2147483647],
    ['onebot', 'reconnect_base_ms', 1, 2147483647], ['onebot', 'reconnect_max_ms', 1, 2147483647],
    ['ai', 'timeout_ms', 1000, 120000], ['ai', 'max_output_tokens', 128, 4096],
    ['reply', 'cooldown_ms', 1000, 60000], ['reply', 'max_parts', 1, 3],
    ['reply.random', 'cooldown_ms', 1000, 3600000], ['reply.random', 'max_per_minute', 1, 10],
    ['memory', 'retention_days', 1, 30], ['memory', 'context_chars', 8000, 100000],
    ['tools.moderation', 'confirmation_ttl_seconds', 1, 60], ['tools.moderation', 'max_mute_seconds', 1, 600],
  ];
  for (const [section, key, min, max] of ranges) {
    for (const value of [String(min - 1), String(max + 1), '1.5', 'nan', 'inf', 'true', '"123"', '[]']) {
      f.config(`[${section}]\n${key}=${value}`);
      assert.throws(() => f.load(), ConfigError, `${section}.${key}=${value}`);
    }
  }
  for (const value of ['-0.01', '1.01', 'nan', '+inf', '-inf', '""', '"0.5"', 'false']) {
    f.config(`[reply]\nrandom_probability=${value}`);
    assert.throws(() => f.load(), ConfigError);
  }
  for (const value of [0, 0.03, 0.5, 1]) {
    f.config(`[reply]\nrandom_probability=${value}`);
    assert.equal(f.load().listener.randomReplyProbability, value);
  }
});

test('delay array shape, bounds, types and ordering; reconnect ordering', t => {
  const f = fixture(t);
  for (const value of ['[]', '[1000]', '[1000,2000,3000]', '[3000,1000]', '[99,3000]', '[5001,6000]', '[1000,10001]', '[1000,99]', '[1000,"3000"]', '[1000,inf]', '[1000,2000.5]', '"1000,3000"']) {
    f.config(`[reply]\ndelay_ms=${value}`);
    assert.throws(() => f.load(), ConfigError, value);
  }
  f.config('[reply]\ndelay_ms=[100,100]');
  assert.equal(f.load().listener.debounceMs, 100);
  f.config('[reply]\ndelay_ms=[5000,10000]');
  assert.equal(f.load().listener.delayMaxMs, 10000);
  f.config('[onebot]\nreconnect_base_ms=2000\nreconnect_max_ms=1000');
  assert.throws(() => f.load(), ConfigError);
});

test('fixed identity cannot widen scope or accept numeric IDs', t => {
  const f = fixture(t);
  for (const [key, expected] of [['group_id', LISTENER_GROUP], ['owner_id', OWNER_ID]]) {
    for (const value of ['"123"', expected!, 'true', '["123"]']) {
      f.config(`[bot]\n${key}=${value}`);
      assert.throws(() => f.load(), ConfigError);
    }
    f.config(`[bot]\n${key}="${expected}"`);
    f.load();
  }
});

test('booleans and text are not coerced', t => {
  const f = fixture(t);
  for (const [section, key] of [['ai', 'enabled'], ['reply', 'mention'], ['reply', 'quote_bot'], ['tools', 'members'], ['tools', 'mention'], ['tools.moderation', 'mute'], ['tools.moderation', 'recall'], ['tools.moderation', 'member_card']]) {
    f.config(`[${section}]\n${key}="true"`);
    assert.throws(() => f.load(), ConfigError);
  }
  for (const key of ['name', 'owner_name']) {
    for (const value of ['123', '""', '"   "']) {
      f.config(`[bot]\n${key}=${value}`);
      assert.throws(() => f.load(), ConfigError);
    }
  }
});

test('URL protocol, credentials, query and fragment restrictions', t => {
  const f = fixture(t);
  for (const [section, key, values] of [
    ['onebot', 'url', ['https://example.com', 'ws://user:secret@example.com', 'ws://example.com/?', 'wss://example.com/#x', 'bad']],
    ['ai', 'base_url', ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?secret', 'https://example.com/#', 'ftp://localhost']],
  ] as const) for (const value of values) {
    f.config(`[${section}]\n${key}="${value}"`);
    assert.throws(() => f.load(), e => e instanceof ConfigError && !e.message.includes(value) && !e.message.includes('secret'));
  }
  for (const value of ['https://example.com/v1', 'http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1']) {
    f.config(`[ai]\nbase_url="${value}"`);
    assert.equal(f.load().listener.baseUrl, value);
  }
});

test('selected secret references and environment precedence, never mutating process env', t => {
  const f = fixture(t, '[onebot]\ntoken_env="CUSTOM_TOKEN"\n[ai]\nenabled=true\nmodel="test-model"\napi_key_env="CUSTOM_KEY"');
  f.dotenv('CUSTOM_TOKEN=file-token\nCUSTOM_KEY=file-key\n');
  assert.equal(f.load({}).onebot.token, 'file-token');
  const env = { CUSTOM_TOKEN: ' env-token ', CUSTOM_KEY: 'env-key', AI_ENABLED: 'false', OPENAI_MODEL: 'ignored', ONEBOT_WS_URL: 'bad' };
  const c = f.load(env);
  assert.equal(c.onebot.token, 'env-token');
  assert.equal(c.listener.apiKey, 'env-key');
  assert.equal(c.listener.enabled, true);
  assert.equal(c.listener.model, 'test-model');
  assert.equal(env.CUSTOM_TOKEN, ' env-token ');
  assert.equal(c.onebot.url, 'ws://127.0.0.1:3001');
  for (const name of ['lower', 'A-B', '1KEY', '秘密']) {
    f.config(`[onebot]\ntoken_env="${name}"`);
    assert.throws(() => f.load(), ConfigError);
  }
});

test('missing, empty and multiline secrets fail safely even when AI disabled', t => {
  const f = fixture(t);
  assert.throws(() => f.load({}), ConfigError);
  for (const value of ['', ' ', '\nsecret', 'secret\r', 'x\ny']) {
    assert.throws(() => f.load({ ONEBOT_ACCESS_TOKEN: value }), ConfigError);
    assert.throws(() => f.load({ ONEBOT_ACCESS_TOKEN: 'token', OPENAI_API_KEY: value }), ConfigError);
  }
  f.dotenv('ONEBOT_ACCESS_TOKEN="line\\nbreak"');
  assert.throws(() => f.load({ ONEBOT_ACCESS_TOKEN: 'override' }), ConfigError);
  f.dotenv('ONEBOT_ACCESS_TOKEN=token');
  f.config('[ai]\nenabled=true\nmodel="test"');
  assert.throws(() => f.load({}), ConfigError);
  f.config('[ai]\nenabled=true');
  assert.throws(() => f.load({ OPENAI_API_KEY: 'key' }), ConfigError);
});

test('nonsecret and unknown .env entries rejected; unrelated process variables ignored', t => {
  const f = fixture(t);
  for (const key of ['AI_ENABLED', 'OPENAI_MODEL', 'ONEBOT_WS_URL', 'UNRELATED', 'OPENAI_API_KEY_OLD']) {
    f.dotenv(`ONEBOT_ACCESS_TOKEN=token\n${key}=SENSITIVE_VALUE`);
    assert.throws(() => f.load(), e => e instanceof ConfigError && !e.message.includes('SENSITIVE_VALUE') && !e.message.includes(key));
  }
  f.dotenv('ONEBOT_ACCESS_TOKEN=token');
  const c = f.load({ PATH: '/bin', AI_ENABLED: 'true', AI_MEMORY_PATH: ':memory:', ALLOWED_GROUP_IDS: '1' });
  assert.equal(c.listener.enabled, false);
  assert.equal(c.listener.memoryPath, join(f.dir, 'data/listener.sqlite'));
});

test('syntax errors never expose TOML snippets or secret-shaped unknown keys', t => {
  const f = fixture(t, '[ai]\nmodel = "SENSITIVE_PARSE_MARKER');
  assert.throws(() => f.load(), e => e instanceof ConfigError && e.message === '配置错误：TOML 格式无效');
  f.config('SENSITIVE_KEY = "SENSITIVE_VALUE"');
  assert.throws(() => f.load(), e => e instanceof ConfigError && !e.message.includes('SENSITIVE'));
});

test('persona must exist, be valid UTF-8, nonempty, and no larger than 16KiB', t => {
  const f = fixture(t);
  const path = join(f.dir, 'prompts/listener.md');
  rmSync(path);
  assert.throws(() => f.load(), ConfigError);
  for (const value of [' \n\t', Buffer.alloc(16385, 65), Buffer.from([0xff, 0xfe])]) {
    writeFileSync(path, value);
    assert.throws(() => f.load(), ConfigError);
  }
  writeFileSync(path, Buffer.alloc(16384, 65));
  assert.equal(f.load().listener.persona?.length, 16384);
});

test('memory paths reject empty and special database URI paths', t => {
  const f = fixture(t);
  for (const path of ['', ' ', ':memory:', 'file:db.sqlite?mode=memory']) {
    f.config(`[memory]\npath="${path}"`);
    assert.throws(() => f.load(), ConfigError);
  }
});

test('check CLI performs config validation only and emits safe diagnostics', t => {
  const f = fixture(t);
  const cli = resolve('src/config-check.ts');
  const tsx = resolve('node_modules/tsx/dist/loader.mjs');
  const env = { PATH: process.env.PATH, ONEBOT_ACCESS_TOKEN: 'SENSITIVE_CLI_TOKEN' };
  const ok = spawnSync(process.execPath, ['--import', tsx, cli], { cwd: f.dir, env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /config valid/);
  assert.ok(!ok.stdout.includes('SENSITIVE') && !ok.stderr.includes('SENSITIVE'));
  f.config('x="SENSITIVE_BROKEN');
  const bad = spawnSync(process.execPath, ['--import', tsx, cli], { cwd: f.dir, env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /TOML 格式无效/);
  assert.ok(!bad.stderr.includes('SENSITIVE'));
});
