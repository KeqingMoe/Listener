export interface ListenerConfig {
  enabled: boolean; baseUrl: string; apiKey: string; model: string;
  timeoutMs: number; maxTokens: number; debounceMs: number; cooldownMs: number;
  memoryPath: string; maxContextChars: number; retentionDays: number;
  randomReplyProbability?: number; randomCooldownMs?: number; randomMaxPerMinute?: number; delayMaxMs?: number;
}
export function loadListenerConfig(env: NodeJS.ProcessEnv = process.env): ListenerConfig {
  const enabled = env.AI_ENABLED === 'true';
  if (env.AI_ENABLED !== undefined && !['true', 'false'].includes(env.AI_ENABLED)) throw new Error('Invalid AI_ENABLED');
  const n = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const baseUrl = env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const apiKey = env.OPENAI_API_KEY?.trim() || '';
  const model = env.OPENAI_MODEL?.trim() || '';
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid AI URL');
  if (enabled && (!apiKey || !model || /[\r\n]/.test(apiKey))) throw new Error('AI credentials missing or invalid');
  const probability = env.AI_RANDOM_REPLY_PROBABILITY === undefined ? 0.03 : Number(env.AI_RANDOM_REPLY_PROBABILITY);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1 || env.AI_RANDOM_REPLY_PROBABILITY?.trim() === '') throw new Error('Invalid AI_RANDOM_REPLY_PROBABILITY');
  const debounceMs = n('AI_DEBOUNCE_MS', 1200, 100, 5000);
  const delayMaxMs = n('AI_DELAY_MAX_MS', Math.max(3000, debounceMs), 100, 10000);
  if (delayMaxMs < debounceMs) throw new Error('AI delay maximum below minimum');
  return { enabled, baseUrl, apiKey, model,
    randomReplyProbability: probability, randomCooldownMs: n('AI_RANDOM_COOLDOWN_MS', 60000, 1000, 3600000),
    randomMaxPerMinute: n('AI_RANDOM_MAX_PER_MINUTE', 2, 1, 10), delayMaxMs,
    timeoutMs: n('AI_TIMEOUT_MS', 45000, 1000, 120000), maxTokens: n('AI_MAX_TOKENS', 1200, 128, 4096),
    debounceMs, cooldownMs: n('AI_COOLDOWN_MS', 5000, 1000, 60000),
    memoryPath: env.AI_MEMORY_PATH || 'data/listener.sqlite',
    maxContextChars: n('AI_CONTEXT_CHARS', 24000, 8000, 100000), retentionDays: n('AI_RETENTION_DAYS', 7, 1, 30),
  };
}
