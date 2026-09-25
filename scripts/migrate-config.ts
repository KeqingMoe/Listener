import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, chmodSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import { stringify } from 'smol-toml';
import { loadAppConfig, ConfigError } from '../src/config-loader.js';
import { LISTENER_GROUP, OWNER_ID } from '../src/contracts.js';

// One-time migration only. Runtime never consults these legacy behavior variables.
export function migrateConfig(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  root = resolve(root);
  const configPath = resolve(root,'config.toml');
  if (existsSync(configPath)) throw new ConfigError('迁移取消：config.toml 已存在，不覆盖现有配置');
  const envPath = resolve(root,'.env');
  const source = readFileSync(envPath,'utf8');
  const file = parseEnv(source);
  const known = new Set(['ONEBOT_WS_URL','ONEBOT_ACCESS_TOKEN','ALLOW_PRIVATE','ALLOWED_GROUP_IDS','ALLOWED_USER_IDS','ADMIN_USER_IDS','AI_ENABLED','OPENAI_BASE_URL','OPENAI_MODEL','OPENAI_API_KEY','AI_RANDOM_REPLY_PROBABILITY','AI_RANDOM_COOLDOWN_MS','AI_RANDOM_MAX_PER_MINUTE','AI_DEBOUNCE_MS','AI_DELAY_MAX_MS','AI_COOLDOWN_MS','AI_MEMORY_PATH','AI_CONTEXT_CHARS','AI_RETENTION_DAYS','AI_TIMEOUT_MS','AI_MAX_TOKENS','API_TIMEOUT_MS','RECONNECT_BASE_MS','RECONNECT_MAX_MS','HEARTBEAT_MS','RATE_LIMIT_MS','DEDUP_TTL_MS','DEDUP_MAX','CONVERSATION_MAX']);
  if (Object.keys(file).some(k=>!known.has(k))) throw new ConfigError('迁移取消：旧 .env 含未知字段，请先人工检查');
  const effective = {...file};
  for (const key of known) if (env[key] !== undefined) effective[key] = env[key]!;
  const value = (key:string,fallback:string) => effective[key] ?? fallback;
  const number = (key:string,fallback:number) => {
    if (effective[key] === undefined) return fallback;
    if (!effective[key]!.trim() || !Number.isFinite(Number(effective[key]))) throw new ConfigError(`迁移取消：${key} 数值无效`);
    return Number(effective[key]);
  };
  const bool = (key:string,fallback:boolean) => {
    if (effective[key] === undefined) return fallback;
    if (!['true','false'].includes(effective[key]!)) throw new ConfigError(`迁移取消：${key} 必须是 true 或 false`);
    return effective[key] === 'true';
  };
  if (value('ALLOWED_GROUP_IDS',LISTENER_GROUP)!==LISTENER_GROUP || value('ADMIN_USER_IDS',OWNER_ID)!==OWNER_ID) throw new ConfigError('迁移取消：群或管理员与本安装不一致');
  const minDelay = number('AI_DEBOUNCE_MS',1200);
  const doc = {
    bot:{name:'Listener',owner_id:OWNER_ID,owner_name:'時雨てる'},
    groups:{[LISTENER_GROUP]:{enabled:true}},
    onebot:{url:value('ONEBOT_WS_URL','ws://127.0.0.1:3001'),token_env:'ONEBOT_ACCESS_TOKEN',api_timeout_ms:number('API_TIMEOUT_MS',10000),reconnect_base_ms:number('RECONNECT_BASE_MS',1000),reconnect_max_ms:number('RECONNECT_MAX_MS',30000),heartbeat_ms:number('HEARTBEAT_MS',30000)},
    ai:{enabled:bool('AI_ENABLED',false),base_url:value('OPENAI_BASE_URL','https://api.openai.com/v1'),model:value('OPENAI_MODEL',''),api_key_env:'OPENAI_API_KEY',timeout_ms:number('AI_TIMEOUT_MS',45000),max_output_tokens:number('AI_MAX_TOKENS',1200)},
    persona:{file:'prompts/listener.md'},
    reply:{mention:true,quote_bot:true,random_probability:number('AI_RANDOM_REPLY_PROBABILITY',0.03),delay_ms:[minDelay,number('AI_DELAY_MAX_MS',Math.max(3000,minDelay))],cooldown_ms:number('AI_COOLDOWN_MS',5000),max_parts:3,random:{cooldown_ms:number('AI_RANDOM_COOLDOWN_MS',60000),max_per_minute:number('AI_RANDOM_MAX_PER_MINUTE',2)}},
    memory:{path:value('AI_MEMORY_PATH','data/listener.sqlite'),retention_days:number('AI_RETENTION_DAYS',7),context_chars:number('AI_CONTEXT_CHARS',24000)},
    tools:{members:true,mention:true,moderation:{mute:true,recall:true,member_card:true,confirmation_ttl_seconds:60,max_mute_seconds:600}},
  };
  const token = value('ONEBOT_ACCESS_TOKEN',''); const key = value('OPENAI_API_KEY','');
  // Values are preserved via dotenv single quotes, with no interpolation or escaping.
  const quote = (secret:string) => {
    if (/[\r\n\u0000']/.test(secret)) throw new ConfigError('迁移取消：密钥包含需人工处理的特殊字符');
    return `'${secret}'`;
  };
  const newEnv = `# 仅保留密钥；行为参数在 config.toml。\nONEBOT_ACCESS_TOKEN=${quote(token)}\n${key ? `OPENAI_API_KEY=${quote(key)}\n` : ''}`;
  const suffix = randomBytes(8).toString('hex');
  const tempConfig = resolve(root,`.config-migration-${suffix}.toml`);
  const tempEnv = resolve(root,`.env-migration-${suffix}`);
  const backup = resolve(root,'data/config-migration.env.bak');
  if (existsSync(backup)) throw new ConfigError('迁移取消：已有旧配置备份，不覆盖');
  let installed = false;
  try {
    writeFileSync(tempConfig,stringify(doc),{flag:'wx',mode:0o600});
    writeFileSync(tempEnv,newEnv,{flag:'wx',mode:0o600});
    loadAppConfig({configPath:tempConfig,envPath:tempEnv,env:{}});
    mkdirSync(dirname(backup),{recursive:true,mode:0o700});
    // Validate first, then preserve original secrets before replacing either file.
    copyFileSync(envPath,backup,constants.COPYFILE_EXCL);
    chmodSync(backup,0o600);
    // Use exclusive installation so a concurrently-created config is never replaced.
    copyFileSync(tempConfig,configPath,constants.COPYFILE_EXCL); installed = true;
    renameSync(tempEnv,envPath);
  } catch (error) {
    if (installed) unlinkSync(configPath);
    throw error;
  } finally {
    if (existsSync(tempConfig)) unlinkSync(tempConfig);
    if (existsSync(tempEnv)) unlinkSync(tempEnv);
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { migrateConfig(); console.log('已迁移到 config.toml；.env 仅含密钥，旧文件备份在 data/config-migration.env.bak。'); }
  catch(error) { console.error(error instanceof ConfigError ? error.message : '配置迁移失败，详细信息已隐藏以保护密钥'); process.exitCode=1; }
}
