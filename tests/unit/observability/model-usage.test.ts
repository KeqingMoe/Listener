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
