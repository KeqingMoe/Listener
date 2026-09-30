import test from 'node:test';
import assert from 'node:assert/strict';
import { applyResourceSync } from '../../../src/dashboard/web/src/composables/resourceSyncState.ts';

test('resource sync preserves unchanged identity and applies escaped array/object patches immutably', () => {
  const current = { items: ['a', 'b'], 'a/b': { '~key': 1 } };
  assert.equal(applyResourceSync(current, { mode: 'unchanged', cursor: '1' }), current);
  const next = applyResourceSync(current, { mode: 'patch', cursor: '2', patch: [
    { op: 'remove', path: '/items/0' }, { op: 'add', path: '/items/-', value: 'c' },
    { op: 'replace', path: '/a~1b/~0key', value: 2 },
  ] });
  assert.deepEqual(next, { items: ['b', 'c'], 'a/b': { '~key': 2 } });
  assert.deepEqual(current.items, ['a', 'b']);
  assert.equal(current['a/b']['~key'], 1);
});

test('resource snapshots and root replacements work; patches require a snapshot', () => {
  assert.deepEqual(applyResourceSync(null, { mode: 'snapshot', cursor: '1', data: { value: 1 } }), { value: 1 });
  assert.deepEqual(applyResourceSync({ value: 1 }, { mode: 'patch', cursor: '2', patch: [{ op: 'replace', path: '', value: { value: 2 } }] }), { value: 2 });
  assert.throws(() => applyResourceSync(null, { mode: 'unchanged', cursor: '1' }));
});

test('JSON body reserved keys are ordinary own properties, never prototype setters', () => {
  const next = applyResourceSync<Record<string, unknown>>({}, { mode: 'patch', cursor: '2', patch: [
    { op: 'add', path: '/__proto__', value: { safe: true } },
    { op: 'add', path: '/constructor', value: { prototype: 'body text' } },
    { op: 'replace', path: '/__proto__/safe', value: false },
  ] });
  assert.equal(Object.getPrototypeOf(next), Object.prototype);
  assert.deepEqual(next['__proto__'], { safe: false });
  assert.deepEqual(next['constructor'], { prototype: 'body text' });
  assert.throws(() => applyResourceSync({}, { mode: 'patch', cursor: '3', patch: [{ op: 'add', path: '/__proto__/polluted', value: true }] }));
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});
