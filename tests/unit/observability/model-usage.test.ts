import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsage,
  parseChatUsage,
  parseResponsesUsage,
} from '../../../src/observability/model-usage.ts';

test('normalizes canonical chat and vendor cache fields', () => {
  assert.deepEqual(
    parseChatUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 60 },
      prompt_cache_hit_tokens: 2,
    }),
    {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 60,
      reasoningTokens: null,
    },
  );
  assert.equal(
    parseChatUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 4 })
      .cachedInputTokens,
    4,
  );
});

test('normalizes responses usage', () =>
  assert.deepEqual(
    parseResponsesUsage({
      input_tokens: 50,
      output_tokens: 10,
      total_tokens: 60,
      input_tokens_details: { cached_tokens: 25 },
      output_tokens_details: { reasoning_tokens: 3 },
    }),
    {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      cachedInputTokens: 25,
      reasoningTokens: 3,
    },
  ));

const protocols = [
  [parseChatUsage, 'prompt_tokens', 'prompt_tokens_details'],
  [parseResponsesUsage, 'input_tokens', 'input_tokens_details'],
] as const;

test('missing cache fields default to zero when input usage is valid', () => {
  for (const [parse, input, details] of protocols) {
    for (const tokens of [0, 100]) {
      assert.equal(parse({ [input]: tokens }).cachedInputTokens, 0);
      for (const detail of [undefined, null, {}, { audio_tokens: 5 }]) {
        const usage = parse({ [input]: tokens, [details]: detail });
        assert.equal(usage.inputTokens, tokens);
        assert.equal(usage.cachedInputTokens, 0);
        assert.equal(usage.outputTokens, null);
        assert.equal(usage.reasoningTokens, null);
      }
    }
  }
});

test('missing cache fields do not fabricate usage without valid input counts', () => {
  for (const [parse, input] of protocols) {
    for (const value of [undefined, null, {}, [], true]) {
      assert.equal(parse(value).cachedInputTokens, null);
    }
    for (const tokens of [undefined, null, -1, 0.5, '100', NaN, Infinity]) {
      const usage = parse({ [input]: tokens });
      assert.equal(usage.inputTokens, null);
      assert.equal(usage.cachedInputTokens, null);
    }
  }
});

test('explicit invalid cache counts remain unknown instead of becoming zero', () => {
  for (const cached of [undefined, null, -1, 0.5, '0', NaN, Infinity, 101]) {
    for (const [parse, input, details] of protocols) {
      assert.equal(
        parse({
          [input]: 100,
          [details]: { cached_tokens: cached },
          prompt_cache_hit_tokens: 40,
        }).cachedInputTokens,
        null,
      );
    }
    assert.equal(
      parseChatUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: cached })
        .cachedInputTokens,
      null,
    );
  }
  for (const [parse, input, details] of protocols) {
    assert.equal(
      parse({ [input]: 100, [details]: { cached_tokens: 0 } })
        .cachedInputTokens,
      0,
    );
  }
});

test('invalid and inconsistent counts remain unknown', () => {
  assert.deepEqual(
    normalizeUsage({
      inputTokens: -1,
      outputTokens: 2,
      cachedInputTokens: 3,
      reasoningTokens: 4,
    }),
    {
      inputTokens: null,
      outputTokens: 2,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  );
  assert.equal(
    parseChatUsage({
      prompt_tokens: 10,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 11 },
    }).cachedInputTokens,
    null,
  );
});
