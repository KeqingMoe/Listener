import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadAppConfig, ConfigError, assertStoragePaths } from './config/loader.js';
import { toListenerConfig } from './config/runtime.js';
import { OneBotClient } from './client.js';
import { id } from './bot.js';
import { Listener } from './listener.js';
import { OpenAIModel } from './model.js';
import { SQLiteMemory } from './memory.js';
import { WorldEventStore } from './world-events.js';
import { ResponsesModel } from './responses-model.js';
import type { ModelRequestRecord, ModelRequestStart } from './model-usage.js';
import { ModelSession } from './model-session.js';
import { resolveOwnerId } from './contracts/index.js';
import { GroupRouter } from './group-router.js';
import { GroupRegistry } from './config/group-registry.js';
import { TurnScheduler } from './turn-scheduler.js';
import { configureLogging, getLogContext, log, observeLogs } from './logger.js';
import { RuntimeEventStore } from './runtime-events.js';
import { TelemetryStore } from './telemetry.js';
import { FACE_CATALOG, EXAMPLE_FACE_CATALOG } from './face-catalog.js';
import { getReactionCatalog } from './reaction-catalog.js';
import { CustomFaceStore } from './custom-face-store.js';
import { CustomFaceCoordinator } from './custom-face-coordinator.js';
import { SharedCustomFaceStaging } from './custom-face-staging.js';
let logger: ReturnType<typeof configureLogging> | undefined;
let telemetry: TelemetryStore | undefined;
let runtimeEvents:RuntimeEventStore|undefined,stopObserving:(()=>void)|undefined;
let heartbeat:ReturnType<typeof setInterval>|undefined;
let registry: GroupRegistry | undefined;
let customFaceStore: CustomFaceStore | undefined;
let customFaceCoordinator: CustomFaceCoordinator | undefined;

async function main(): Promise<void> {
  const app=loadAppConfig();
  const {onebot:config,model:modelConfig,runtime}=app;
  logger=configureLogging(app.logging,[config.token,modelConfig.apiKey]);
  log('info','app.start',{count:app.configuredGroupIds.filter(groupId=>app.resolveGroup(groupId).enabled).length});
  log(FACE_CATALOG===EXAMPLE_FACE_CATALOG?'warn':'info','app.faces_ready',{count:FACE_CATALOG.length,reason:FACE_CATALOG===EXAMPLE_FACE_CATALOG?'example_catalog':'local_catalog'});
  const ownerId=resolveOwnerId(app.identity.ownerId);
  if(config.allowPrivate||config.adminUsers.size!==1||!config.adminUsers.has(ownerId))throw new Error('Owner configuration mismatch');
  const client=new OneBotClient(config);
  const scheduler=new TurnScheduler(runtime.maxConcurrentTurns);
  process.umask(0o077);
  mkdirSync(dirname(app.storage.telemetryPath),{recursive:true,mode:0o700});
  telemetry=new TelemetryStore(app.storage.telemetryPath,{secrets:[config.token,modelConfig.apiKey]});
  try{runtimeEvents=new RuntimeEventStore(app.storage.telemetryPath);stopObserving=observeLogs(record=>runtimeEvents?.record(record));}
  catch{log('warn','app.diagnostics_unavailable',{reason:'storage_failed'});}
  // Reject unsupported compaction before contacting the provider, including the
  // unlisted-group default branch of all-groups mode.
  const declared=app.configuredGroupIds.map(groupId=>app.resolveGroup(groupId));
  const enabledGroups=new Map(declared.map(group=>[group.groupId,group.enabled]));
  if(declared.some(group=>group.enabled&&group.session.compaction!==false))throw new Error('Server compaction is not verified for this endpoint');
  registry=new GroupRegistry(app,()=>log('warn','app.registry_failed',{reason:'storage_failed'}));
  mkdirSync(app.storage.directory,{recursive:true,mode:0o700});
  customFaceStore=new CustomFaceStore({path:resolve(app.storage.directory,'custom-faces.sqlite')});
  customFaceCoordinator=new CustomFaceCoordinator({path:resolve(app.storage.directory,'custom-face-operations.sqlite')});
  const customFaces={store:customFaceStore,coordinator:customFaceCoordinator,staging:new SharedCustomFaceStaging({directory:app.storage.customFaceDirectory,providerDirectory:app.storage.napcatCustomFaceDirectory})};
  const modelOptions={...modelConfig};
  let router:GroupRouter;
  router=new GroupRouter({
    enabled:groupId=>enabledGroups.get(groupId)??app.defaultsEnabled,
    listGroups:()=>client.call('get_group_list',{no_cache:true}),
    membershipChanged:groupIds=>{
      for(const groupId of groupIds){
        if(app.resolveGroup(groupId).session.compaction!==false){
          log('error','app.group_policy_failed',{group_id:groupId,reason:'server_compaction_unverified'});
          throw new Error('Server compaction is not verified for this endpoint');
        }
      }
      registry!.update(groupIds);
    },
    onError:reason=>log('warn','app.group_discovery_failed',{reason}),
    create:async groupId=>{
      const policy=app.resolveGroup(groupId);
      if(!policy.enabled)throw new Error('Group disabled');
      if(policy.session.compaction!==false)throw new Error('Server compaction is not verified for this endpoint');
      assertStoragePaths(app.storage,router.groupIds.map(value=>app.resolveGroup(value)));
      const group=toListenerConfig(app,policy);
      let lastRequestId:string|undefined;
      let memory:SQLiteMemory|undefined,world:WorldEventStore|undefined,session:ModelSession|undefined;
      const contexts=new Map<string,{groupId:string;turnId?:string;phase?:string;wakeId?:string}>();
      const context=()=>{const trace=getLogContext();return {groupId,...(typeof trace.turn_id==='string'?{turnId:trace.turn_id}:{}),...(typeof trace.phase==='string'?{phase:trace.phase}:{}),...(session?.state().wakeId?{wakeId:session.state().wakeId!}:{})};};
      const scoped={...modelOptions,onRequestStart:(record:ModelRequestStart)=>{
        const scope=context();contexts.set(record.requestId,scope);lastRequestId=record.requestId;
        try{telemetry?.beginRequest({...record,...scope});}catch{log('warn','model.telemetry_failed',{reason:'storage_failed'});}
      },onRequest:(record:ModelRequestRecord)=>{
        lastRequestId=record.requestId;const scope=contexts.get(record.requestId)??context();contexts.delete(record.requestId);
        try{telemetry?.record({...record,...scope});}catch{log('warn','model.telemetry_failed',{reason:'storage_failed'});}
      }};
      const model=policy.session.transport==='responses'?new ResponsesModel({...scoped,sessionId:`group:${groupId}`}):new OpenAIModel(scoped);
      try{
        mkdirSync(dirname(policy.storage.databasePath),{recursive:true,mode:0o700});
        memory=new SQLiteMemory({path:policy.storage.databasePath,maxContextChars:group.maxContextChars,retentionDays:policy.history.retentionDays,groupId});
        world=new WorldEventStore({path:`${policy.storage.databasePath}.events.sqlite`,groupId,retentionDays:policy.history.retentionDays});
        session=new ModelSession({path:`${policy.storage.databasePath}.session.sqlite`,groupId,maxTranscriptBytes:policy.session.maxTranscriptBytes});
        if(model instanceof ResponsesModel){const checkpoint=session.getTransportCheckpoint();if(checkpoint){try{model.restoreContinuationCheckpoint(checkpoint);}catch{session.reset('invalid_transport_checkpoint');}}}
        for(const entry of memory.recent())world.appendMessage(entry,{source:'migration',observedAt:entry.time});
        chmodSync(policy.storage.databasePath,0o600);
        const listener=new Listener(client,model,memory,group,Math.random,undefined,scheduler,{world,session,modelRequestId:()=>lastRequestId,customFaces});
        if(group.observeReactions)log('info','app.reactions_ready',{count:getReactionCatalog().length});
        log('info','app.group_ready',{group_id:groupId});
        return listener;
      }catch(error){
        for(const resource of [memory,world,session])try{resource?.close();}catch{log('warn','app.group_cleanup_failed',{reason:'close_failed'});}
        log('error','app.group_init_failed',{group_id:groupId,reason:'group_initialization_failed'});throw error;
      }
    },
  });
  let selfId:string|undefined,stopping=false;
  const pulse=()=>log('debug','app.heartbeat',{status:selfId?'connected':'disconnected'});
  pulse();heartbeat=setInterval(pulse,15000);heartbeat.unref();
  client.on('ready',(data:unknown)=>{
    selfId=data&&typeof data==='object'&&'user_id' in data?id(data.user_id):undefined;
    if(!selfId){router.setConnected(false);log('warn','onebot.identity_failed');return;}
    const identity=selfId;
    void router.connect(identity).then(()=>{if(selfId===identity&&!stopping)log('info','onebot.ready',{count:router.size});}).catch(()=>log('warn','app.group_discovery_failed',{reason:'group_initialization_failed'}));
  });
  client.on('disconnected',()=>{selfId=undefined;router.setConnected(false);if(!stopping)log('warn','onebot.disconnected');});
  const receive=(event:unknown)=>{
    if(!selfId||stopping)return;
    // Index arrival metadata, not message content. Only enabled groups of this authenticated account.
    if(event&&typeof event==='object'){
      const raw=event as Record<string,unknown>,groupId=id(raw.group_id);
      if(raw.post_type==='message'&&raw.message_type==='group'&&id(raw.self_id)===selfId&&groupId&&(enabledGroups.get(groupId)??app.defaultsEnabled)&&id(raw.user_id)!==selfId)
        log('debug','onebot.message_received',{group_id:groupId,message_id:raw.message_id});
    }
    void router.receive(event,selfId).catch(()=>log('warn','message.failed',{reason:'event_handler_failed'}));
  };
  client.on('message',receive);client.on('notice',receive);
  const stop=()=>{
    if(stopping)return;stopping=true;clearInterval(heartbeat);log('info','app.stopping');
    const groupsStopping=router.stop();scheduler.close();
    void Promise.allSettled([groupsStopping,client.stop()]).then(results=>{
      if(results.some(result=>result.status==='rejected')){log('error','app.shutdown_failed',{reason:'operation_failed'});process.exitCode=1;}
      else log('info','app.stopped');
    }).finally(async()=>{
      try{customFaceCoordinator?.close();}catch{log('warn','app.custom_faces_close_failed',{reason:'close_failed'});}
       try{customFaceStore?.close();}catch{log('warn','app.custom_faces_close_failed',{reason:'close_failed'});}
       try{registry?.close();}catch{log('warn','app.registry_failed',{reason:'close_failed'});}
      try{telemetry?.close();}catch{log('warn','model.telemetry_failed',{reason:'close_failed'});}
      stopObserving?.();try{runtimeEvents?.close();}catch{}
      await logger?.close();process.exit(process.exitCode??0);
    });
  };
  process.on('SIGINT',stop);process.on('SIGTERM',stop);client.start();
}
void main().catch(async(error:unknown)=>{
  try{customFaceCoordinator?.close();}catch{}
  try{customFaceStore?.close();}catch{}
  try{registry?.close();}catch{}
  try{telemetry?.close();}catch{}
  clearInterval(heartbeat);
  if(logger){log('error','app.startup_failed',{reason:'startup_failed'});stopObserving?.();try{runtimeEvents?.close();}catch{}await logger.close();}
  else console.error(error instanceof ConfigError?error.message:'Listener startup failed; details suppressed to protect secrets');
  process.exitCode=1;process.exit(1);
});
