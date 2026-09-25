export interface Config {
  url: string;
  token: string;
  allowedGroups: Set<string>;
  allowedUsers: Set<string>;
  adminUsers: Set<string>;
  allowPrivate: boolean;
  apiTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  heartbeatMs: number;
  rateLimitMs: number;
  dedupTtlMs: number;
  dedupMax: number;
  conversationMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.ONEBOT_WS_URL ?? 'ws://127.0.0.1:3001';
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid ONEBOT_WS_URL'); }
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('ONEBOT_WS_URL must use ws/wss without credentials, query, or fragment');
  }
  const token = env.ONEBOT_ACCESS_TOKEN?.trim() ?? '';
  if (!token || /[\r\n]/.test(token)) throw new Error('ONEBOT_ACCESS_TOKEN must be set');
  const ids = (key: string) => {
    const values = (env[key] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (values.some(s => !/^[1-9]\d*$/.test(s))) throw new Error(`Invalid ${key}`);
    return new Set(values);
  };
  const number = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid ${key}`);
    return value;
  };
  const privateFlag = env.ALLOW_PRIVATE ?? 'true';
  if (!['true', 'false'].includes(privateFlag)) throw new Error('ALLOW_PRIVATE must be true or false');
  const config: Config = {
    url, token, allowedGroups: ids('ALLOWED_GROUP_IDS'), allowedUsers: ids('ALLOWED_USER_IDS'),
    adminUsers: ids('ADMIN_USER_IDS'),
    allowPrivate: privateFlag === 'true', apiTimeoutMs: number('API_TIMEOUT_MS', 10000),
    reconnectBaseMs: number('RECONNECT_BASE_MS', 1000), reconnectMaxMs: number('RECONNECT_MAX_MS', 30000),
    heartbeatMs: number('HEARTBEAT_MS', 30000), rateLimitMs: number('RATE_LIMIT_MS', 2000),
    dedupTtlMs: number('DEDUP_TTL_MS', 300000), dedupMax: number('DEDUP_MAX', 10000),
    conversationMax: number('CONVERSATION_MAX', 10000),
  };
  if (config.reconnectBaseMs > config.reconnectMaxMs) throw new Error('Reconnect base exceeds maximum');
  return config;
}
