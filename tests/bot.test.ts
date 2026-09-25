import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, parseCommand } from '../src/bot.js';
import { loadConfig } from '../src/config.js';

const config = (extra: NodeJS.ProcessEnv = {}) => loadConfig({ ONEBOT_ACCESS_TOKEN: 'test', ...extra });
const text = (text: string) => ({ type: 'text', data: { text } });
const event = (extra = {}) => ({ post_type: 'message', self_id: 1, user_id: 2, message_type: 'private', message_id: 10, message: [text('/ping')], ...extra });

test('exact commands and optional leading self mention only', () => {
  assert.equal(parseCommand([text('/ping')], '1'), '/ping');
  assert.equal(parseCommand([{ type: 'at', data: { qq: '1' } }, text(' /help ')], '1'), '/help');
  for (const value of ['hi /ping', '/ping more', '/PING', '[CQ:at,qq=1]/ping']) assert.equal(parseCommand([text(value)], '1'), undefined);
  for (const value of ['all', '2']) assert.equal(parseCommand([{ type: 'at', data: { qq: value } }, text('/ping')], '1'), undefined);
  assert.equal(parseCommand('/ping', '1'), undefined);
  assert.equal(parseCommand([text('/ping'), { type: 'image', data: {} }], '1'), undefined);
  assert.equal(parseCommand([text('/ping'), { type: 'at', data: { qq: '1' } }], '1'), undefined);
});

test('fail-closed self, identity, groups, and private filters', () => {
  assert.ok(new Bot(config()).handle(event(), '1'));
  assert.equal(new Bot(config()).handle(event({ user_id: 1 }), '1'), undefined);
  assert.equal(new Bot(config()).handle(event({ self_id: 99 }), '1'), undefined);
  assert.equal(new Bot(config()).handle(event({ message_type: 'group', group_id: 3 }), '1'), undefined);
  assert.ok(new Bot(config({ ALLOWED_GROUP_IDS: '3' })).handle(event({ message_type: 'group', group_id: 3 }), '1'));
  assert.equal(new Bot(config({ ALLOW_PRIVATE: 'false' })).handle(event(), '1'), undefined);
  assert.equal(new Bot(config({ ALLOWED_USER_IDS: '9' })).handle(event(), '1'), undefined);
  assert.ok(new Bot(config({ ALLOWED_USER_IDS: '2' })).handle(event(), '1'));
  assert.equal(new Bot(config()).handle(event({ user_id: Number.MAX_SAFE_INTEGER + 1 }), '1'), undefined);
});

test('bounded dedup uses conversation context and rate limit expires', () => {
  let now = 1000;
  const bot = new Bot(config({ RATE_LIMIT_MS: '10', DEDUP_TTL_MS: '100', DEDUP_MAX: '2' }), () => now);
  assert.ok(bot.handle(event(), '1'));
  assert.equal(bot.handle(event({ message_id: 11 }), '1'), undefined);
  now += 11;
  assert.equal(bot.handle(event(), '1'), undefined);
  assert.ok(bot.handle(event({ user_id: 3 }), '1'));
  assert.ok(bot.handle(event({ message_id: 12 }), '1'));
  now += 101;
  assert.ok(bot.handle(event(), '1'));
});

test('conversation capacity fails closed and group rate is shared', () => {
  const bot = new Bot(config({ ALLOWED_GROUP_IDS: '3', CONVERSATION_MAX: '1' }));
  assert.ok(bot.handle(event({ message_type: 'group', group_id: 3 }), '1'));
  assert.equal(bot.handle(event({ message_type: 'group', group_id: 3, user_id: 4 }), '1'), undefined);
  assert.equal(bot.handle(event({ user_id: 5 }), '1'), undefined);
});

test('configuration validates security settings', () => {
  assert.throws(() => config({ ALLOW_PRIVATE: 'yes' }));
  for (const key of ['ALLOWED_GROUP_IDS', 'ALLOWED_USER_IDS']) {
    for (const value of ['*', '0', '-1', '1.5', '01', '1,invalid']) assert.throws(() => config({ [key]: value }));
  }
  for (const value of ['not a URL', 'http://localhost', 'ws://user:pass@localhost', 'ws://localhost?token=secret', 'ws://localhost/#secret']) {
    assert.throws(() => config({ ONEBOT_WS_URL: value }));
  }
  for (const value of ['', '   ', 'token\r\nInjected: header']) assert.throws(() => config({ ONEBOT_ACCESS_TOKEN: value }));
  assert.throws(() => loadConfig({}));
});

test('all numeric settings reject invalid ranges and reconnect bounds', () => {
  for (const key of ['API_TIMEOUT_MS', 'RECONNECT_BASE_MS', 'RECONNECT_MAX_MS', 'HEARTBEAT_MS', 'RATE_LIMIT_MS', 'DEDUP_TTL_MS', 'DEDUP_MAX', 'CONVERSATION_MAX']) {
    for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '2147483648']) assert.throws(() => config({ [key]: value }), `${key}=${value}`);
  }
  assert.throws(() => config({ RECONNECT_BASE_MS: '2000', RECONNECT_MAX_MS: '1000' }));
});

test('configuration defaults and valid ID allowlists are explicit', () => {
  const defaults = config();
  assert.equal(defaults.url, 'ws://127.0.0.1:3001');
  assert.equal(defaults.allowPrivate, true);
  assert.equal(defaults.allowedGroups.size, 0);
  assert.equal(defaults.allowedUsers.size, 0);
  const parsed = config({ ONEBOT_WS_URL: 'wss://example.com/onebot', ALLOW_PRIVATE: 'false', ALLOWED_GROUP_IDS: ' 123,456,123 ', ALLOWED_USER_IDS: '789' });
  assert.equal(parsed.allowPrivate, false);
  assert.deepEqual([...parsed.allowedGroups], ['123', '456']);
  assert.deepEqual([...parsed.allowedUsers], ['789']);
});
