import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseDotenv } from 'dotenv';
import type { Config } from './config.js';
import type { ListenerConfig } from './listener-config.js';
import { LISTENER_GROUP, OWNER_ID } from './contracts.js';

/** Messages contain only trusted schema paths, never configuration values. */
export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}
const fail = (path: string, reason = '值无效'): never => { throw new ConfigError(`配置错误：${path}：${reason}`); };
type Table = Record<string, unknown>;
function table(value: unknown, path: string, keys: string[]): Table {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return fail(path, '必须是表');
  const result = value as Table;
  if (Object.keys(result).some(key => !keys.includes(key))) fail(path, '包含未知字段');
  return result;
}
function text(t: Table, key: string, path: string, fallback: string, empty = false): string {
  const value = t[key] ?? fallback;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || (!empty && !value.trim())) return fail(`${path}.${key}`, '必须是非空单行文本');
  return value.trim();
}
function bool(t: Table, key: string, path: string, fallback: boolean): boolean {
  const value = t[key] ?? fallback;
  if (typeof value !== 'boolean') return fail(`${path}.${key}`, '必须是布尔值');
  return value;
}
function num(t: Table, key: string, path: string, fallback: number, min: number, max: number, integer = true): number {
  const value = t[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) return fail(`${path}.${key}`, '数值超出允许范围或类型错误');
  return value;
}
function url(value: string, path: string, ai = false): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail(path, '网址无效'); }
  if (parsed.username || parsed.password || value.includes('?') || value.includes('#') ||
    (ai ? !['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) : !['ws:', 'wss:'].includes(parsed.protocol))) fail(path, '网址协议或安全选项无效');
  return value;
}
function filePath(value: string, base: string, field: string): string {
  if (!value || value.includes(':') || /[\u0000-\u001f\u007f]/.test(value)) return fail(field, '必须是普通文件路径');
  return resolve(base, value);
}
function persona(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > 16 * 1024) return fail('persona.file', '文件不得超过 16KiB');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
    if (!content.trim()) return fail('persona.file', '文件不能为空');
    return content;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return fail('persona.file', '无法读取 UTF-8 文件');
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function loadAppConfig(options: { configPath?: string; envPath?: string; env?: NodeJS.ProcessEnv } = {}): {
  onebot: Config; listener: ListenerConfig; personaPath: string; configPath: string;
} {
  const configPath = resolve(options.configPath ?? 'config.toml');
  const base = dirname(configPath);
  let source: string;
  try { source = readFileSync(configPath, 'utf8'); } catch { return fail('config.toml', '无法读取配置文件'); }
  let parsed: unknown;
  try { parsed = parseToml(source); } catch { throw new ConfigError('配置错误：TOML 格式无效'); }
  const root = table(parsed, 'config', ['bot', 'onebot', 'ai', 'persona', 'reply', 'memory', 'tools']);
  const bot = table(root.bot, 'bot', ['name', 'owner_id', 'owner_name', 'group_id']);
  const one = table(root.onebot, 'onebot', ['url', 'token_env', 'api_timeout_ms', 'reconnect_base_ms', 'reconnect_max_ms', 'heartbeat_ms']);
  const ai = table(root.ai, 'ai', ['enabled', 'base_url', 'model', 'api_key_env', 'timeout_ms', 'max_output_tokens']);
  const p = table(root.persona, 'persona', ['file']);
  const reply = table(root.reply, 'reply', ['mention', 'quote_bot', 'random_probability', 'delay_ms', 'cooldown_ms', 'max_parts', 'random']);
  const random = table(reply.random, 'reply.random', ['cooldown_ms', 'max_per_minute']);
  const memory = table(root.memory, 'memory', ['path', 'retention_days', 'context_chars']);
  const tools = table(root.tools, 'tools', ['members', 'mention', 'moderation']);
  const moderation = table(tools.moderation, 'tools.moderation', ['mute', 'recall', 'member_card', 'confirmation_ttl_seconds', 'max_mute_seconds']);
  for (const [key, expected] of [['group_id', LISTENER_GROUP], ['owner_id', OWNER_ID]] as const) {
    const value = bot[key] ?? expected;
    if (typeof value !== 'string' || value !== expected) fail(`bot.${key}`, '必须使用本安装固定的身份字符串');
  }
  const tokenEnv = text(one, 'token_env', 'onebot', 'ONEBOT_ACCESS_TOKEN');
  const keyEnv = text(ai, 'api_key_env', 'ai', 'OPENAI_API_KEY');
  for (const [name, field] of [[tokenEnv, 'onebot.token_env'], [keyEnv, 'ai.api_key_env']]) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name!)) fail(field!, '必须是大写环境变量名称');
  }
  let secrets: Record<string, string> = {};
  try { secrets = parseDotenv(readFileSync(resolve(base, options.envPath ?? '.env'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('.env', '无法读取密钥文件'); }
  if (Object.keys(secrets).some(key => key !== tokenEnv && key !== keyEnv)) fail('.env', '只允许所选的密钥变量，请将其他配置迁移到 TOML');
  const env = options.env ?? process.env;
  function secret(name: string, field: string, required: boolean): string {
    // Validate both sources so a malformed secret file cannot be hidden by an override.
    for (const value of [secrets[name], env[name]]) {
      if (value !== undefined && (typeof value !== 'string' || /[\r\n]/.test(value) || !value.trim())) fail(field, '密钥必须是非空单行文本');
    }
    const value = (env[name] ?? secrets[name] ?? '').trim();
    if (required && !value) fail(field, '缺少所选密钥');
    return value;
  }
  const enabled = bool(ai, 'enabled', 'ai', false);
  const token = secret(tokenEnv, 'onebot.token_env', true);
  const apiKey = secret(keyEnv, 'ai.api_key_env', enabled);
  const model = text(ai, 'model', 'ai', '', !enabled);
  const delay = reply.delay_ms ?? [1200, 3000];
  if (!Array.isArray(delay) || delay.length !== 2) fail('reply.delay_ms', '必须是两个整数的数组');
  const pair = delay as unknown[];
  const debounceMs = num({ min: pair[0] }, 'min', 'reply.delay_ms', 1200, 100, 5000);
  const delayMaxMs = num({ max: pair[1] }, 'max', 'reply.delay_ms', 3000, 100, 10000);
  if (delayMaxMs < debounceMs) fail('reply.delay_ms', '最大延迟不得小于最小延迟');
  const onebot: Config = {
    url: url(text(one, 'url', 'onebot', 'ws://127.0.0.1:3001'), 'onebot.url'), token,
    allowedGroups: new Set([LISTENER_GROUP]), allowedUsers: new Set(), adminUsers: new Set([OWNER_ID]), allowPrivate: false,
    apiTimeoutMs: num(one, 'api_timeout_ms', 'onebot', 10000, 1, 2147483647),
    reconnectBaseMs: num(one, 'reconnect_base_ms', 'onebot', 1000, 1, 2147483647),
    reconnectMaxMs: num(one, 'reconnect_max_ms', 'onebot', 30000, 1, 2147483647),
    heartbeatMs: num(one, 'heartbeat_ms', 'onebot', 30000, 1, 2147483647),
    rateLimitMs: 2000, dedupTtlMs: 300000, dedupMax: 10000, conversationMax: 10000,
  };
  if (onebot.reconnectBaseMs > onebot.reconnectMaxMs) fail('onebot.reconnect_max_ms', '不得小于重连基础间隔');
  const personaPath = filePath(text(p, 'file', 'persona', 'prompts/listener.md'), base, 'persona.file');
  const listener: ListenerConfig = {
    enabled, apiKey, model, baseUrl: url(text(ai, 'base_url', 'ai', 'https://api.openai.com/v1'), 'ai.base_url', true),
    timeoutMs: num(ai, 'timeout_ms', 'ai', 45000, 1000, 120000), maxTokens: num(ai, 'max_output_tokens', 'ai', 1200, 128, 4096),
    debounceMs, delayMaxMs, cooldownMs: num(reply, 'cooldown_ms', 'reply', 5000, 1000, 60000),
    randomReplyProbability: num(reply, 'random_probability', 'reply', 0.03, 0, 1, false),
    randomCooldownMs: num(random, 'cooldown_ms', 'reply.random', 60000, 1000, 3600000),
    randomMaxPerMinute: num(random, 'max_per_minute', 'reply.random', 2, 1, 10),
    mentionEnabled: bool(reply, 'mention', 'reply', true), quoteBotEnabled: bool(reply, 'quote_bot', 'reply', true),
    maxParts: num(reply, 'max_parts', 'reply', 3, 1, 3),
    memoryPath: filePath(text(memory, 'path', 'memory', 'data/listener.sqlite'), base, 'memory.path'),
    retentionDays: num(memory, 'retention_days', 'memory', 7, 1, 30), maxContextChars: num(memory, 'context_chars', 'memory', 24000, 8000, 100000),
    botName: text(bot, 'name', 'bot', 'Listener'), ownerName: text(bot, 'owner_name', 'bot', '時雨てる'),
    tools: { members: bool(tools, 'members', 'tools', true), mention: bool(tools, 'mention', 'tools', true), moderation: {
      mute: bool(moderation, 'mute', 'tools.moderation', true), recall: bool(moderation, 'recall', 'tools.moderation', true),
      memberCard: bool(moderation, 'member_card', 'tools.moderation', true),
      confirmationTtlSeconds: num(moderation, 'confirmation_ttl_seconds', 'tools.moderation', 60, 1, 60),
      maxMuteSeconds: num(moderation, 'max_mute_seconds', 'tools.moderation', 600, 1, 600),
    } },
    persona: persona(personaPath),
  };
  return { onebot, listener, personaPath, configPath };
}
