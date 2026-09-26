import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadAppConfig, ConfigError } from './config-loader.js';
import { OneBotClient } from './client.js';
import { id } from './bot.js';
import { Listener } from './listener.js';
import { OpenAIModel } from './model.js';
import { SQLiteMemory } from './memory.js';
import { WorldEventStore } from './world-events.js';
import { ResponsesModel } from './responses-model.js';
import type { ModelRequestRecord } from './model-usage.js';
import { ModelSession } from './model-session.js';
import { resolveGroupId, OWNER_ID } from './contracts.js';
import { GroupRouter } from './group-router.js';
import { TurnScheduler } from './turn-scheduler.js';
import { configureLogging, getLogContext, log } from './logger.js';
import { TelemetryStore } from './telemetry.js';
import { FACE_CATALOG, EXAMPLE_FACE_CATALOG } from './face-catalog.js';
import { getReactionCatalog } from './reaction-catalog.js';
let logger: ReturnType<typeof configureLogging> | undefined;
let telemetry: TelemetryStore | undefined;

async function main(): Promise<void> {
  const {onebot: config, listener: ai, logging, groups, maxConcurrentTurns} = loadAppConfig();
  logger=configureLogging(logging,[config.token,ai.apiKey]);
  log('info','app.start',{count:groups.length,ai_enabled:ai.enabled});
  log(FACE_CATALOG===EXAMPLE_FACE_CATALOG?'warn':'info','app.faces_ready',{count:FACE_CATALOG.length,reason:FACE_CATALOG===EXAMPLE_FACE_CATALOG?'example_catalog':'local_catalog'});
  if(groups.some(group=>group.enabled&&group.tools?.reactions))log('info','app.reactions_ready',{count:getReactionCatalog().length});
  // Route only explicitly configured groups; private access and owner authority
  // cannot be widened by group overrides or model-selected parameters.
  const groupIds=groups.map(group=>resolveGroupId(group.groupId));
  if(new Set(groupIds).size!==groups.length||config.allowedGroups.size!==groups.length||
     groupIds.some(groupId=>!config.allowedGroups.has(groupId))||config.allowPrivate||
     config.adminUsers.size!==1||!config.adminUsers.has(OWNER_ID))throw new Error('Group/owner configuration mismatch');
  const client = new OneBotClient(config);
  const scheduler=new TurnScheduler(maxConcurrentTurns);
  if(ai.enabled){
    process.umask(0o077);
    mkdirSync(dirname(ai.memoryPath),{recursive:true,mode:0o700});
    telemetry=new TelemetryStore(`${ai.memoryPath}.telemetry.sqlite`);
  }
  const modelOptions={baseUrl:ai.baseUrl,apiKey:ai.apiKey,model:ai.model,timeoutMs:ai.timeoutMs,maxTokens:ai.maxTokens,onRequest:(record:ModelRequestRecord)=>{
    const trace=getLogContext();
    try { telemetry?.record({...record,
      ...(typeof trace.group_id==='string'?{groupId:trace.group_id}:{}),
      ...(typeof trace.turn_id==='string'?{turnId:trace.turn_id}:{}),
      ...(typeof trace.phase==='string'?{phase:trace.phase}:{}),
    }); } catch { log('warn','model.telemetry_failed',{reason:'storage_failed'}); }
  }};
  // HTTP 200 alone does not establish provider-side compaction support.
  if(groups.some(group=>group.enabled&&group.serverCompaction==='auto'))throw new Error('Server compaction is not verified for this endpoint');
  const entries:Array<readonly [string,Listener]>=[];
  const memories:SQLiteMemory[]=[];
  const worlds:WorldEventStore[]=[];
  const sessions:ModelSession[]=[];
  let router:GroupRouter;
  try {
    for(const group of groups){
      const groupId=resolveGroupId(group.groupId);
      let lastRequestId:string|undefined;
      const scopedModelOptions={...modelOptions,onRequest:(record:ModelRequestRecord)=>{lastRequestId=record.requestId;modelOptions.onRequest(record);}};
      const model=group.enabled?(group.transport==='responses'?new ResponsesModel({...scopedModelOptions,sessionId:`group:${groupId}`}):new OpenAIModel(scopedModelOptions)):undefined;
      let memory:SQLiteMemory|undefined;
      let world:WorldEventStore|undefined;
      let session:ModelSession|undefined;
      try {
        if(group.enabled){
          process.umask(0o077);
          mkdirSync(dirname(group.memoryPath),{recursive:true,mode:0o700});
          memory=new SQLiteMemory({path:group.memoryPath,maxContextChars:group.maxContextChars,retentionDays:group.retentionDays,groupId});
          memories.push(memory);
          world=new WorldEventStore({path:`${group.memoryPath}.events.sqlite`,groupId,retentionDays:group.retentionDays});
          worlds.push(world);
          session=new ModelSession({path:`${group.memoryPath}.session.sqlite`,groupId,maxTranscriptBytes:group.sessionMaxContextBytes});
          sessions.push(session);
          if(model instanceof ResponsesModel){
            const checkpoint=session.getTransportCheckpoint();
            if(checkpoint){try { model.restoreContinuationCheckpoint(checkpoint); } catch { session.reset('invalid_transport_checkpoint'); }}
          }
          for(const entry of memory.recent())world.appendMessage(entry,{source:'migration',observedAt:entry.time});
          chmodSync(group.memoryPath,0o600);
        }
        entries.push([groupId,new Listener(client,model,memory,group,Math.random,undefined,scheduler,{world,session,modelRequestId:()=>lastRequestId})]);
        log('info','app.group_ready',{group_id:groupId,ai_enabled:group.enabled,images_enabled:group.images?.enabled ?? false,forward_enabled:group.forward?.enabled ?? false,attention_enabled:group.attention?.enabled ?? false,reactions_enabled:group.tools?.reactions ?? false});
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
    for(const world of worlds)world.close();
    for(const session of sessions)session.close();
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
  const receiveGroupEvent = (event: unknown) => {
    if (!selfId || stopping) return;
    void router.receive(event,selfId).catch(() => log('warn','message.failed',{reason:'event_handler_failed'}));
  };
  client.on('message', receiveGroupEvent);
  client.on('notice', receiveGroupEvent);
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
        try { telemetry?.close(); } catch { log('warn','model.telemetry_failed',{reason:'close_failed'}); }
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
  try { telemetry?.close(); } catch { /* Preserve the startup failure. */ }
  if (logger) { log('error','app.startup_failed',{reason:'startup_failed'});await logger.close(); }
  else console.error(error instanceof ConfigError ? error.message : 'Listener startup failed; details suppressed to protect secrets');
  process.exitCode = 1;
  process.exit(1);
});
