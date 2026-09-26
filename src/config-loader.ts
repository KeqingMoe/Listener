import { readFileSync, openSync, readSync, closeSync, realpathSync, statSync, constants, fstatSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseDotenv } from 'dotenv';
import type { Config } from './config.js';
import type { ListenerConfig, ModerationMode } from './listener-config.js';
import type { LoggingConfig, LogLevel } from './logger.js';
import { OWNER_ID } from './contracts.js';
import { EXTENDED_TOOL_NAMES, EXTENDED_READ_ONLY_TOOLS, type ExtendedToolsConfig } from './extended-tool-config.js';

/** Messages contain only trusted schema paths, never configuration values. */
export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}
const fail = (path: string, reason = '值无效'): never => { throw new ConfigError(`配置错误：${path}：${reason}`); };
type Table = Record<string, unknown>;
function table(value: unknown, path: string, keys: string[]): Table {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(path, '必须是表');
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
function moderationMode(t: Table, key: string, path: string, fallback: ModerationMode): ModerationMode {
  const value = Object.hasOwn(t, key) ? t[key] : fallback;
  if (value !== 'off' && value !== 'confirm' && value !== 'direct') return fail(`${path}.${key}`, '必须是 off、confirm 或 direct 字符串，不接受布尔值');
  return value;
}
function extendedSettings(value: unknown, path: string, defaults?: ExtendedToolsConfig): { extended?: ExtendedToolsConfig } {
  if (value === undefined && defaults === undefined) return {};
  const raw = table(value, path, [...EXTENDED_TOOL_NAMES]);
  const result: ExtendedToolsConfig = {...defaults};
  for (const name of EXTENDED_TOOL_NAMES) if (Object.hasOwn(raw, name)) {
    const mode = raw[name];
    if (mode !== 'off' && mode !== 'confirm' && mode !== 'direct') fail(`${path}.${name}`, '必须是 off、confirm 或 direct；新增能力默认 off');
    if(mode==='confirm'&&EXTENDED_READ_ONLY_TOOLS.includes(name))fail(`${path}.${name}`,'只读工具无需写操作确认，请使用 off 或 direct');
    result[name] = mode as 'off' | 'confirm' | 'direct';
  }
  return {extended: result};
}
function num(t: Table, key: string, path: string, fallback: number, min: number, max: number, integer = true): number {
  const value = t[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) return fail(`${path}.${key}`, '数值超出允许范围或类型错误');
  return value;
}
function wakeNumber(t: Table, key: string, path: string, fallback: number, min: number, max: number): number {
  const value = Object.hasOwn(t, key) ? t[key] : fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(`${path}.${key}`, '必须是允许范围内的正整数');
  return value;
}
function sessionSettings(t: Table, path: string, defaults?: ListenerConfig): Pick<ListenerConfig, 'transport' | 'sessionMaxContextBytes' | 'serverCompaction' | 'compactThreshold'> {
  const transport = Object.hasOwn(t,'transport') ? t.transport : defaults?.transport ?? 'chat';
  if (transport !== 'chat' && transport !== 'responses') return fail(`${path}.transport`,'必须是 chat 或 responses 字符串');
  const serverCompaction = Object.hasOwn(t,'server_compaction') ? t.server_compaction : defaults?.serverCompaction ?? 'off';
  if (serverCompaction !== 'off' && serverCompaction !== 'auto') return fail(`${path}.server_compaction`,'必须是 off 或 auto 字符串');
  // An explicit off override discards the inherited threshold. An explicit
  // threshold with off is still an error, rather than an ignored setting.
  const compactThreshold = Object.hasOwn(t,'compact_threshold')
    ? wakeNumber(t,'compact_threshold',path,1024,1024,1000000)
    : serverCompaction === 'off' ? undefined : defaults?.compactThreshold;
  if (serverCompaction === 'off' && compactThreshold !== undefined) return fail(`${path}.compact_threshold`,'仅可与 server_compaction=auto 一起配置');
  if (serverCompaction === 'auto' && transport !== 'responses') return fail(`${path}.server_compaction`,'auto 需要 responses 传输');
  if (serverCompaction === 'auto' && compactThreshold === undefined) return fail(`${path}.compact_threshold`,'auto 模式必须配置阈值');
  return {transport,serverCompaction,compactThreshold,sessionMaxContextBytes:wakeNumber(t,'session_max_context_bytes',path,defaults?.sessionMaxContextBytes ?? 524288,65536,8388608)};
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
function persona(file: string, field = 'persona.file'): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return fail(field, '必须是普通 UTF-8 文件');
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > 16 * 1024) return fail(field, '文件不得超过 16KiB');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
    if (!content.trim()) return fail(field, '文件不能为空');
    return content;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return fail(field, '无法读取 UTF-8 文件');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function groupId(value: unknown, field: string, label = '群号'): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,31}$/.test(value) || value.trim() !== value) return fail(field, `必须是规范的${label}字符串`);
  return value;
}
function groupSettings(id: string, raw: unknown, defaults: ListenerConfig, base: string, legacyGroupId?: string): { enabled: boolean; config: ListenerConfig } {
  const path = `groups.${id}`;
  const group = table(raw,path,['enabled','ai','reply','tools','images','forward','attention','memory','persona']);
   const groupAi = table(group.ai,`${path}.ai`,['max_tool_calls_per_wake','wake_timeout_ms','transport','session_max_context_bytes','server_compaction','compact_threshold']);
  const enabled = bool(group,'enabled',path,true);
  const reply = table(group.reply,`${path}.reply`,['mention','quote_bot','random_probability','delay_ms','cooldown_ms','random']);
  const random = table(reply.random,`${path}.reply.random`,['cooldown_ms','max_per_minute']);
  const tools = table(group.tools,`${path}.tools`,['members','mention','reactions','moderation','extended']);
  const moderation = table(tools.moderation,`${path}.tools.moderation`,['mute','unmute','recall','member_card','confirmation_ttl_seconds','max_mute_seconds']);
  const images = table(group.images,`${path}.images`,['enabled','max_per_turn','max_download_mb']);
  const forward = table(group.forward,`${path}.forward`,['enabled']);
  const attention = table(group.attention,`${path}.attention`,['enabled','max_plans']);
  const memory = table(group.memory,`${path}.memory`,['path','retention_days','context_chars']);
  const extra = table(group.persona,`${path}.persona`,['append_file']);
  const delay = reply.delay_ms ?? [defaults.debounceMs,defaults.delayMaxMs];
  if (!Array.isArray(delay) || delay.length !== 2) fail(`${path}.reply.delay_ms`,'必须是两个整数的数组');
  const pair=delay as unknown[];
  const debounceMs=num({min:pair[0]},'min',`${path}.reply.delay_ms`,defaults.debounceMs,0,5000);
  const delayMaxMs=num({max:pair[1]},'max',`${path}.reply.delay_ms`,defaults.delayMaxMs!,0,10000);
  if(delayMaxMs<debounceMs)fail(`${path}.reply.delay_ms`,'最大延迟不得小于最小延迟');
  const dTools=defaults.tools!, dModeration=dTools.moderation, dImages=defaults.images!, dForward=defaults.forward!;
  const defaultMemory=id===legacyGroupId?defaults.memoryPath:resolve(dirname(defaults.memoryPath),'groups',id,'listener.sqlite');
  const memoryPath=Object.hasOwn(memory,'path')?filePath(text(memory,'path',`${path}.memory`,''),base,`${path}.memory.path`):defaultMemory;
  const append=Object.hasOwn(extra,'append_file')?persona(filePath(text(extra,'append_file',`${path}.persona`,''),base,`${path}.persona.append_file`),`${path}.persona.append_file`):undefined;
  return {enabled,config:{
    ...defaults,...sessionSettings(groupAi,`${path}.ai`,defaults),groupId:id,debounceMs,delayMaxMs,
     maxToolCallsPerWake:wakeNumber(groupAi,'max_tool_calls_per_wake',`${path}.ai`,defaults.maxToolCallsPerWake!,1,4096),
     wakeTimeoutMs:wakeNumber(groupAi,'wake_timeout_ms',`${path}.ai`,defaults.wakeTimeoutMs!,1000,600000),
    cooldownMs:num(reply,'cooldown_ms',`${path}.reply`,defaults.cooldownMs,1000,60000),
    randomReplyProbability:num(reply,'random_probability',`${path}.reply`,defaults.randomReplyProbability!,0,1,false),
    randomCooldownMs:num(random,'cooldown_ms',`${path}.reply.random`,defaults.randomCooldownMs!,1000,3600000),
    randomMaxPerMinute:num(random,'max_per_minute',`${path}.reply.random`,defaults.randomMaxPerMinute!,1,10),
    mentionEnabled:bool(reply,'mention',`${path}.reply`,defaults.mentionEnabled!),
    quoteBotEnabled:bool(reply,'quote_bot',`${path}.reply`,defaults.quoteBotEnabled!),
    memoryPath,retentionDays:num(memory,'retention_days',`${path}.memory`,defaults.retentionDays,1,30),
    maxContextChars:num(memory,'context_chars',`${path}.memory`,defaults.maxContextChars,8000,100000),
    tools:{...extendedSettings(tools.extended,`${path}.tools.extended`,dTools.extended),members:bool(tools,'members',`${path}.tools`,dTools.members),mention:bool(tools,'mention',`${path}.tools`,dTools.mention),reactions:bool(tools,'reactions',`${path}.tools`,dTools.reactions ?? false),moderation:{
      mute:moderationMode(moderation,'mute',`${path}.tools.moderation`,dModeration.mute),unmute:moderationMode(moderation,'unmute',`${path}.tools.moderation`,dModeration.unmute),
      recall:moderationMode(moderation,'recall',`${path}.tools.moderation`,dModeration.recall),memberCard:moderationMode(moderation,'member_card',`${path}.tools.moderation`,dModeration.memberCard),
      confirmationTtlSeconds:num(moderation,'confirmation_ttl_seconds',`${path}.tools.moderation`,dModeration.confirmationTtlSeconds,1,60),
      maxMuteSeconds:num(moderation,'max_mute_seconds',`${path}.tools.moderation`,dModeration.maxMuteSeconds,1,600),
    }},
    images:{enabled:bool(images,'enabled',`${path}.images`,dImages.enabled),maxPerTurn:num(images,'max_per_turn',`${path}.images`,dImages.maxPerTurn,1,3),maxDownloadMb:num(images,'max_download_mb',`${path}.images`,dImages.maxDownloadMb,1,10)},
    forward:{enabled:bool(forward,'enabled',`${path}.forward`,dForward.enabled)},
    attention:{enabled:bool(attention,'enabled',`${path}.attention`,defaults.attention!.enabled),maxPlans:num(attention,'max_plans',`${path}.attention`,defaults.attention!.maxPlans,1,32)},
    persona:append===undefined?defaults.persona:`${defaults.persona}\n\n--- 本群风格补充（不得覆盖程序权限规则） ---\n${append}`,
  }};
}
/** Detect lexical, existing symlink/hardlink, and symlinked ancestor aliases without creating files. */
function checkMemoryPaths(groups: ListenerConfig[]): void {
  const names=new Set<string>(),inodes=new Set<string>();
  for(const config of groups){
    const field=`groups.${config.groupId}.memory.path`;
    let current=config.memoryPath;const tail:string[]=[];
    let canonical:string;
    for(;;){
      try{canonical=resolve(realpathSync(current),...tail);break;}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')fail(field,'无法核验记忆文件路径');
        const parent=dirname(current);if(parent===current){canonical=config.memoryPath;break;}
        tail.unshift(basename(current));current=parent;
      }
    }
    if(names.has(canonical))fail(field,'启用群不能共用记忆文件');
    names.add(canonical);
    try{
      const stat=statSync(config.memoryPath,{bigint:true});const identity=`${stat.dev}:${stat.ino}`;
      if(inodes.has(identity))fail(field,'启用群不能共用记忆文件');inodes.add(identity);
    }catch(error){if(error instanceof ConfigError)throw error;if((error as NodeJS.ErrnoException).code!=='ENOENT')fail(field,'无法核验记忆文件路径');}
  }
}
export function loadAppConfig(options: { configPath?: string; envPath?: string; env?: NodeJS.ProcessEnv } = {}): {
  onebot: Config; listener: ListenerConfig; groups: ListenerConfig[]; maxConcurrentTurns: number; logging: LoggingConfig; personaPath: string; configPath: string;
} {
  const configPath = resolve(options.configPath ?? 'config.toml');
  const base = dirname(configPath);
  let source: string;
  try { source = readFileSync(configPath, 'utf8'); } catch { return fail('config.toml', '无法读取配置文件'); }
  let parsed: unknown;
  try { parsed = parseToml(source); } catch { throw new ConfigError('配置错误：TOML 格式无效'); }
  const root = table(parsed, 'config', ['bot', 'onebot', 'ai', 'persona', 'reply', 'memory', 'tools', 'images', 'logging', 'forward', 'attention', 'groups']);
  const bot = table(root.bot, 'bot', ['name', 'owner_id', 'owner_name']);
  const one = table(root.onebot, 'onebot', ['url', 'token_env', 'api_timeout_ms', 'reconnect_base_ms', 'reconnect_max_ms', 'heartbeat_ms']);
  const ai = table(root.ai, 'ai', ['enabled', 'base_url', 'model', 'api_key_env', 'timeout_ms', 'max_output_tokens', 'max_concurrent_turns', 'max_tool_calls_per_wake', 'wake_timeout_ms', 'transport', 'session_max_context_bytes', 'server_compaction', 'compact_threshold']);
  const p = table(root.persona, 'persona', ['file']);
  const reply = table(root.reply, 'reply', ['mention', 'quote_bot', 'random_probability', 'delay_ms', 'cooldown_ms', 'random']);
  const random = table(reply.random, 'reply.random', ['cooldown_ms', 'max_per_minute']);
  const memory = table(root.memory, 'memory', ['path', 'retention_days', 'context_chars', 'legacy_group_id']);
  const legacyGroupId = Object.hasOwn(memory,'legacy_group_id') ? groupId(memory.legacy_group_id,'memory.legacy_group_id') : undefined;
  const tools = table(root.tools, 'tools', ['members', 'mention', 'reactions', 'moderation', 'extended']);
  const images = table(root.images, 'images', ['enabled', 'max_per_turn', 'max_download_mb']);
  const forward = table(root.forward, 'forward', ['enabled']);
  const attention = table(root.attention, 'attention', ['enabled', 'max_plans']);
  const logs = table(root.logging, 'logging', ['level', 'console', 'file', 'directory', 'retention_days', 'max_file_mb', 'max_total_mb']);
  const moderation = table(tools.moderation, 'tools.moderation', ['mute', 'unmute', 'recall', 'member_card', 'confirmation_ttl_seconds', 'max_mute_seconds']);
  // No routed groups may inherit a public compatibility/test owner identity.
  const ownerConfigured=Object.hasOwn(bot,'owner_id');
  const ownerId=ownerConfigured ? groupId(bot.owner_id,'bot.owner_id','主人QQ号') : OWNER_ID;
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
  const maxConcurrentTurns=num(ai,'max_concurrent_turns','ai',2,1,8);
  const token = secret(tokenEnv, 'onebot.token_env', true);
  const apiKey = secret(keyEnv, 'ai.api_key_env', enabled);
  const model = text(ai, 'model', 'ai', '', !enabled);
  const delay = reply.delay_ms ?? [1200, 3000];
  if (!Array.isArray(delay) || delay.length !== 2) fail('reply.delay_ms', '必须是两个整数的数组');
  const pair = delay as unknown[];
  const debounceMs = num({ min: pair[0] }, 'min', 'reply.delay_ms', 1200, 0, 5000);
  const delayMaxMs = num({ max: pair[1] }, 'max', 'reply.delay_ms', 3000, 0, 10000);
  if (delayMaxMs < debounceMs) fail('reply.delay_ms', '最大延迟不得小于最小延迟');
  const onebot: Config = {
    url: url(text(one, 'url', 'onebot', 'ws://127.0.0.1:3001'), 'onebot.url'), token,
    allowedGroups: new Set<string>(), allowedUsers: new Set(), adminUsers: new Set([ownerId]), allowPrivate: false,
    apiTimeoutMs: num(one, 'api_timeout_ms', 'onebot', 10000, 1, 2147483647),
    reconnectBaseMs: num(one, 'reconnect_base_ms', 'onebot', 1000, 1, 2147483647),
    reconnectMaxMs: num(one, 'reconnect_max_ms', 'onebot', 30000, 1, 2147483647),
    heartbeatMs: num(one, 'heartbeat_ms', 'onebot', 30000, 1, 2147483647),
    rateLimitMs: 2000, dedupTtlMs: 300000, dedupMax: 10000, conversationMax: 10000,
  };
  if (onebot.reconnectBaseMs > onebot.reconnectMaxMs) fail('onebot.reconnect_max_ms', '不得小于重连基础间隔');
  const personaPath = filePath(text(p, 'file', 'persona', 'prompts/listener.md'), base, 'persona.file');
  const listener: ListenerConfig = {
    ownerId, enabled, apiKey, model, baseUrl: url(text(ai, 'base_url', 'ai', 'https://api.openai.com/v1'), 'ai.base_url', true),
    timeoutMs: num(ai, 'timeout_ms', 'ai', 45000, 1000, 120000), maxTokens: num(ai, 'max_output_tokens', 'ai', 1200, 128, 4096),
     maxToolCallsPerWake: wakeNumber(ai,'max_tool_calls_per_wake','ai',96,1,4096),
     wakeTimeoutMs: wakeNumber(ai,'wake_timeout_ms','ai',90000,1000,600000),
     ...sessionSettings(ai,'ai'),
    debounceMs, delayMaxMs, cooldownMs: num(reply, 'cooldown_ms', 'reply', 5000, 1000, 60000),
    randomReplyProbability: num(reply, 'random_probability', 'reply', 0.03, 0, 1, false),
    randomCooldownMs: num(random, 'cooldown_ms', 'reply.random', 60000, 1000, 3600000),
    randomMaxPerMinute: num(random, 'max_per_minute', 'reply.random', 2, 1, 10),
    mentionEnabled: bool(reply, 'mention', 'reply', true), quoteBotEnabled: bool(reply, 'quote_bot', 'reply', true),
    memoryPath: filePath(text(memory, 'path', 'memory', 'data/listener.sqlite'), base, 'memory.path'),
    retentionDays: num(memory, 'retention_days', 'memory', 7, 1, 30), maxContextChars: num(memory, 'context_chars', 'memory', 24000, 8000, 100000),
    botName: text(bot, 'name', 'bot', 'Listener'), ownerName: text(bot, 'owner_name', 'bot', '時雨てる'),
    tools: { ...extendedSettings(tools.extended,'tools.extended'), members: bool(tools, 'members', 'tools', true), mention: bool(tools, 'mention', 'tools', true), reactions: bool(tools, 'reactions', 'tools', false), moderation: {
      mute: moderationMode(moderation, 'mute', 'tools.moderation', 'off'), unmute: moderationMode(moderation, 'unmute', 'tools.moderation', 'off'),
      recall: moderationMode(moderation, 'recall', 'tools.moderation', 'off'), memberCard: moderationMode(moderation, 'member_card', 'tools.moderation', 'off'),
      confirmationTtlSeconds: num(moderation, 'confirmation_ttl_seconds', 'tools.moderation', 60, 1, 60),
      maxMuteSeconds: num(moderation, 'max_mute_seconds', 'tools.moderation', 600, 1, 600),
    } },
    images: {enabled:bool(images,'enabled','images',false),maxPerTurn:num(images,'max_per_turn','images',3,1,3),maxDownloadMb:num(images,'max_download_mb','images',10,1,10)},
    forward: {enabled:bool(forward,'enabled','forward',false)},
    attention: {enabled:bool(attention,'enabled','attention',false),maxPlans:num(attention,'max_plans','attention',16,1,32)},
    persona: persona(personaPath),
  };
  const level = text(logs,'level','logging','info');
  if (!['debug','info','warn','error'].includes(level)) fail('logging.level','必须是 debug、info、warn 或 error');
  const logging: LoggingConfig = {
    level:level as LogLevel, console:bool(logs,'console','logging',true), file:bool(logs,'file','logging',true),
    directory:filePath(text(logs,'directory','logging','data/logs'),base,'logging.directory'),
    retentionDays:num(logs,'retention_days','logging',7,1,30), maxFileMb:num(logs,'max_file_mb','logging',20,1,100),
    maxTotalMb:num(logs,'max_total_mb','logging',200,1,1000),
  };
  if (logging.maxTotalMb < logging.maxFileMb) fail('logging.max_total_mb','不得小于单文件大小上限');
  let configured: Table;
  if(Object.hasOwn(root,'groups')){
    const raw=root.groups;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))fail('groups','必须是群号索引表');
    const keys=Object.keys(raw as Table);
    if(keys.length>32)fail('groups','最多配置32个群');
    for(const key of keys)groupId(key,'groups');
    configured=raw as Table;
  }else configured={};
  const groups:ListenerConfig[]=[];
  for(const [id,settings] of Object.entries(configured)){
    const group=groupSettings(id,settings,listener,base,legacyGroupId);
    if(group.enabled)groups.push(group.config);
  }
  if(groups.length&&!ownerConfigured)fail('bot.owner_id','启用群时必须在本地全局配置中显式指定主人QQ号');
  checkMemoryPaths(groups);
  onebot.allowedGroups=new Set(groups.map(group=>group.groupId!));
  return { onebot, listener, groups, maxConcurrentTurns, logging, personaPath, configPath };
}
