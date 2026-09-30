import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalMessageId, id } from '../../../src/onebot/identity.ts';

test('canonical message IDs accept only safe integers in canonical decimal form', () => {
  for (const [value, expected] of [
    [0, '0'],
    ['0', '0'],
    [42, '42'],
    ['-42', '-42'],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    [String(Number.MIN_SAFE_INTEGER), String(Number.MIN_SAFE_INTEGER)],
  ] as const) {
    assert.equal(canonicalMessageId(value), expected);
  }
  for (const value of [
    -0,
    '-0',
    '042',
    '+42',
    ' 42',
    '42 ',
    '1e2',
    '4.2',
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '9007199254740992',
    '1'.repeat(32),
    '',
    null,
    undefined,
    {},
  ]) {
    assert.equal(canonicalMessageId(value), undefined, String(value));
  }
});

test('QQ identities are positive canonical integers', () => {
  assert.equal(id(10001), '10001');
  assert.equal(id('10001'), '10001');
  for (const value of [0, -1, '0', '010', '-1', 1.5, '']) {
    assert.equal(id(value), undefined);
  }
});
