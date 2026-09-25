import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadAppConfig, ConfigError } from './config-loader.js';
import { OneBotClient } from './client.js';
import { id } from './bot.js';
import { Listener } from './listener.js';
import { OpenAIModel } from './model.js';
import { SQLiteMemory } from './memory.js';
import { LISTENER_GROUP, OWNER_ID } from './contracts.js';

async function main(): Promise<void> {
  const {onebot: config, listener: ai} = loadAppConfig();
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
    console.info(selfId ? `Listener connected; group-only; AI ${ai.enabled ? 'enabled' : 'disabled (configure API first)'}` : 'OneBot identity unavailable; messages disabled');
  });
  client.on('disconnected', () => {
    selfId = undefined; listener.setConnected(false);
    if (!stopping) console.info('OneBot disconnected; reconnect scheduled');
  });
  client.on('message', (event: unknown) => {
    if (!selfId || stopping) return;
    void listener.receive(event,selfId).catch(() => console.warn('Listener event rejected or failed'));
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void Promise.all([listener.stop(),client.stop()]).then(() => console.info('Listener stopped'));
  };
  process.on('SIGINT',stop);
  process.on('SIGTERM',stop);
  client.start();
}
void main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : 'Listener startup failed; details suppressed to protect secrets');
  process.exitCode = 1;
});
