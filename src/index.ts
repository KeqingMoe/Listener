import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadAppConfig, ConfigError } from './config-loader.js';
import { OneBotClient } from './client.js';
import { id } from './bot.js';
import { Listener } from './listener.js';
import { OpenAIModel } from './model.js';
import { SQLiteMemory } from './memory.js';
import { resolveGroupId, OWNER_ID } from './contracts.js';
import { GroupRouter } from './group-router.js';
import { TurnScheduler } from './turn-scheduler.js';
import { configureLogging, log } from './logger.js';
import { FACE_CATALOG, EXAMPLE_FACE_CATALOG } from './face-catalog.js';
let logger: ReturnType<typeof configureLogging> | undefined;

async function main(): Promise<void> {
  const {onebot: config, listener: ai, logging, groups, maxConcurrentTurns} = loadAppConfig();
  logger=configureLogging(logging,[config.token,ai.apiKey]);
  log('info','app.start',{count:groups.length,ai_enabled:ai.enabled});
  log(FACE_CATALOG===EXAMPLE_FACE_CATALOG?'warn':'info','app.faces_ready',{count:FACE_CATALOG.length,reason:FACE_CATALOG===EXAMPLE_FACE_CATALOG?'example_catalog':'local_catalog'});
  // Route only explicitly configured groups; private access and owner authority
  // cannot be widened by group overrides or model-selected parameters.
  const groupIds=groups.map(group=>resolveGroupId(group.groupId));
  if(new Set(groupIds).size!==groups.length||config.allowedGroups.size!==groups.length||
     groupIds.some(groupId=>!config.allowedGroups.has(groupId))||config.allowPrivate||
     config.adminUsers.size!==1||!config.adminUsers.has(OWNER_ID))throw new Error('Group/owner configuration mismatch');
  const client = new OneBotClient(config);
  const scheduler=new TurnScheduler(maxConcurrentTurns);
  const model=ai.enabled?new OpenAIModel({baseUrl:ai.baseUrl,apiKey:ai.apiKey,model:ai.model,timeoutMs:ai.timeoutMs,maxTokens:ai.maxTokens}):undefined;
  const entries:Array<readonly [string,Listener]>=[];
  const memories:SQLiteMemory[]=[];
  let router:GroupRouter;
  try {
    for(const group of groups){
      const groupId=resolveGroupId(group.groupId);
      let memory:SQLiteMemory|undefined;
      try {
        if(group.enabled){
          process.umask(0o077);
          mkdirSync(dirname(group.memoryPath),{recursive:true,mode:0o700});
          memory=new SQLiteMemory({path:group.memoryPath,maxContextChars:group.maxContextChars,retentionDays:group.retentionDays,groupId});
          memories.push(memory);
          chmodSync(group.memoryPath,0o600);
        }
        entries.push([groupId,new Listener(client,model,memory,group,Math.random,undefined,scheduler)]);
        log('info','app.group_ready',{group_id:groupId,ai_enabled:group.enabled,images_enabled:group.images?.enabled ?? false,forward_enabled:group.forward?.enabled ?? false});
      } catch(error){
        log('error','app.group_init_failed',{group_id:groupId,reason:error instanceof Error&&error.message==='Memory group mismatch'?'memory_group_mismatch':'group_initialization_failed'});
        throw error;
      }
    }
    router=new GroupRouter(entries);
  } catch(error){
    scheduler.close();
    await Promise.allSettled(entries.map(([,listener])=>listener.stop()));
    for(const memory of memories)memory.close();
    throw error;
  }
  let selfId: string | undefined;
  let stopping = false;
  client.on('ready', (data: unknown) => {
    selfId = data && typeof data === 'object' && 'user_id' in data ? id(data.user_id) : undefined;
    router.setConnected(!!selfId);
    log(selfId?'info':'warn',selfId?'onebot.ready':'onebot.identity_failed',{count:router.size,ai_enabled:ai.enabled});
  });
  client.on('disconnected', () => {
    selfId = undefined; router.setConnected(false);
    if (!stopping) log('warn','onebot.disconnected');
  });
  client.on('message', (event: unknown) => {
    if (!selfId || stopping) return;
    void router.receive(event,selfId).catch(() => log('warn','message.failed',{reason:'event_handler_failed'}));
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('info','app.stopping');
    const groupsStopping=router.stop();
    scheduler.close();
    void Promise.allSettled([groupsStopping,client.stop()])
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
