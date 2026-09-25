import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadAppConfig, ConfigError } from './config-loader.js';
import { OneBotClient } from './client.js';
import { id } from './bot.js';
import { Listener } from './listener.js';
import { OpenAIModel } from './model.js';
import { SQLiteMemory } from './memory.js';
import { LISTENER_GROUP, OWNER_ID } from './contracts.js';
import { configureLogging, log } from './logger.js';
let logger: ReturnType<typeof configureLogging> | undefined;

async function main(): Promise<void> {
  const {onebot: config, listener: ai, logging} = loadAppConfig();
  logger=configureLogging(logging,[config.token,ai.apiKey]);
  log('info','app.start',{group_id:LISTENER_GROUP,ai_enabled:ai.enabled,images_enabled:ai.images?.enabled ?? false});
  // Single-group installation: configuration cannot silently widen this boundary.
  if (config.allowedGroups.size !== 1 || !config.allowedGroups.has(LISTENER_GROUP) ||
      config.adminUsers.size !== 1 || !config.adminUsers.has(OWNER_ID)) throw new Error('Group/owner configuration mismatch');
  const client = new OneBotClient(config);
  let memory: SQLiteMemory | undefined;
  let model: OpenAIModel | undefined;
  if (ai.enabled) {
    process.umask(0o077);
    mkdirSync(dirname(ai.memoryPath), {recursive:true,mode:0o700});
    memory = new SQLiteMemory({path:ai.memoryPath,maxContextChars:ai.maxContextChars,retentionDays:ai.retentionDays});
    chmodSync(ai.memoryPath,0o600);
    model = new OpenAIModel({baseUrl:ai.baseUrl,apiKey:ai.apiKey,model:ai.model,timeoutMs:ai.timeoutMs,maxTokens:ai.maxTokens});
  }
  const listener = new Listener(client,model,memory,ai);
  let selfId: string | undefined;
  let stopping = false;
  client.on('ready', (data: unknown) => {
    selfId = data && typeof data === 'object' && 'user_id' in data ? id(data.user_id) : undefined;
    listener.setConnected(!!selfId);
    log(selfId?'info':'warn',selfId?'onebot.ready':'onebot.identity_failed',{group_id:LISTENER_GROUP,ai_enabled:ai.enabled,images_enabled:ai.images?.enabled ?? false});
  });
  client.on('disconnected', () => {
    selfId = undefined; listener.setConnected(false);
    if (!stopping) log('warn','onebot.disconnected');
  });
  client.on('message', (event: unknown) => {
    if (!selfId || stopping) return;
    void listener.receive(event,selfId).catch(() => log('warn','message.failed',{reason:'event_handler_failed'}));
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('info','app.stopping');
    void Promise.allSettled([listener.stop(),client.stop()])
      .then(results=>{
        if(results.some(result=>result.status==='rejected')){log('error','app.shutdown_failed',{reason:'operation_failed'});process.exitCode=1;}
        else log('info','app.stopped');
      })
      .finally(async()=>{
        await logger?.close();
        // A blocked stdout pipe may keep a native write alive after bounded
        // logger shutdown. Only this executable owns process termination.
        process.exit(process.exitCode ?? 0);
      });
  };
  process.on('SIGINT',stop);
  process.on('SIGTERM',stop);
  client.start();
}
void main().catch(async (error: unknown) => {
  if (logger) { log('error','app.startup_failed',{reason:'startup_failed'});await logger.close(); }
  else console.error(error instanceof ConfigError ? error.message : 'Listener startup failed; details suppressed to protect secrets');
  process.exitCode = 1;
  process.exit(1);
});
