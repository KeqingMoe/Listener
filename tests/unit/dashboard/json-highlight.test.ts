import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightJson } from '../../../src/dashboard/web/src/components/review/json-highlight.ts';

const render = (value: unknown) =>
  highlightJson(value)
    .map((token) => token.text)
    .join('');

test('single-line values render exactly as indented JSON', () => {
  const value = {
    a: 1,
    b: [true, null, 'x'],
    c: {},
    d: [],
    e: 'quote " and \\ slash',
  };
  assert.equal(render(value), JSON.stringify(value, null, 2));
});

test('multi-line strings use real line breaks aligned under the opening quote', () => {
  assert.equal(
    render({ text: 'first\nsecond' }),
    '{\n  "text": "first\n    second"\n}',
  );
  const tokens = highlightJson({ text: 'a\nb' });
  assert.deepEqual(
    tokens.find((token) => token.kind === 'text'),
    { kind: 'text', text: 'a\n    b' },
  );
});

test('tokens are classified and adjacent same-kind tokens merge', () => {
  const tokens = highlightJson({ k: 2 });
  assert.deepEqual(tokens, [
    { kind: 'punct', text: '{\n  ' },
    { kind: 'key', text: '"k"' },
    { kind: 'punct', text: ': ' },
    { kind: 'number', text: '2' },
    { kind: 'punct', text: '\n}' },
  ]);
});

test('deep nesting stops at the limit instead of recursing forever', () => {
  let value: unknown = 'leaf';
  for (let i = 0; i < 10; i++) {
    value = { n: value };
  }
  assert.match(
    highlightJson(value, 3)
      .map((t) => t.text)
      .join(''),
    /\[嵌套过深\]/,
  );
});
