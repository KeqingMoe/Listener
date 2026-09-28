import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, parseCommand } from '../src/bot.js';
import type { Config } from '../src/config/onebot.js';

// Legacy command-handler regressions use typed fixtures; runtime configuration is TOML only.
const config = (extra: Partial<Config> = {}): Config => ({
  url: 'ws://127.0.0.1:3001', token: 'test', allowedGroups: new Set(), allowedUsers: new Set(), adminUsers: new Set(),
  allowPrivate: true, apiTimeoutMs: 10000, reconnectBaseMs: 1000, reconnectMaxMs: 30000, heartbeatMs: 30000,
  rateLimitMs: 2000, dedupTtlMs: 300000, dedupMax: 10000, conversationMax: 10000, ...extra,
});
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
  assert.ok(new Bot(config({ allowedGroups: new Set(['3']) })).handle(event({ message_type: 'group', group_id: 3 }), '1'));
  assert.equal(new Bot(config({ allowPrivate: false })).handle(event(), '1'), undefined);
  assert.equal(new Bot(config({ allowedUsers: new Set(['9']) })).handle(event(), '1'), undefined);
  assert.ok(new Bot(config({ allowedUsers: new Set(['2']) })).handle(event(), '1'));
  assert.equal(new Bot(config()).handle(event({ user_id: Number.MAX_SAFE_INTEGER + 1 }), '1'), undefined);
});
test('bounded dedup uses conversation context and rate limit expires', () => {
  let now = 1000;
  const bot = new Bot(config({ rateLimitMs: 10, dedupTtlMs: 100, dedupMax: 2 }), () => now);
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
  const bot = new Bot(config({ allowedGroups: new Set(['3']), conversationMax: 1 }));
  assert.ok(bot.handle(event({ message_type: 'group', group_id: 3 }), '1'));
  assert.equal(bot.handle(event({ message_type: 'group', group_id: 3, user_id: 4 }), '1'), undefined);
  assert.equal(bot.handle(event({ user_id: 5 }), '1'), undefined);
});
