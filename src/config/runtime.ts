import type { AppConfig, ResolvedGroupConfig } from './app.js';
import type { ListenerConfig, ResolvedListenerConfig } from './listener.js';
import { EXTENDED_TOOL_NAMES, type ExtendedToolsConfig } from './extended-tools.js';
import { TOOL_CAPABILITIES, type ToolName } from './tool-policy.js';

/** One-way projection into module options; the resolved policy remains authoritative. */
export function applyToolPolicies(config: ResolvedListenerConfig): ResolvedListenerConfig;
export function applyToolPolicies(config: ListenerConfig): ListenerConfig;
export function applyToolPolicies(config: ListenerConfig): ListenerConfig {
  const policies=config.toolPermissions;
  if(!policies)return config;
  const direct=(name:ToolName)=>policies[name]?.mode==='direct';
  const mode=(name:ToolName)=>policies[name]?.mode??'off';
  const extended:ExtendedToolsConfig={};
  for(const name of EXTENDED_TOOL_NAMES)extended[name]=mode(name);
  return {...config,tools:{members:direct('get_group_members')||direct('get_member_info'),
    mention:config.messageMentions??true,reactions:direct('react_message'),extended,
    moderation:{mute:mode('mute_member'),unmute:mode('unmute_member'),recall:mode('recall_message'),memberCard:mode('set_member_card'),
      confirmationTtlSeconds:config.confirmationTtlSeconds??60,maxMuteSeconds:policies.mute_member.maxSeconds??TOOL_CAPABILITIES.mute_member.options.max_seconds!.default}},
    images:{enabled:direct('view_images'),maxPerTurn:policies.view_images.maxPerTurn??TOOL_CAPABILITIES.view_images.options.max_per_turn!.default,maxDownloadMb:policies.view_images.maxDownloadMb??TOOL_CAPABILITIES.view_images.options.max_download_mb!.default},
    forward:{enabled:direct('read_forward')},
    attention:{enabled:direct('manage_attention'),maxPlans:policies.manage_attention.maxPlans??TOOL_CAPABILITIES.manage_attention.options.max_plans!.default}};
}
export function optionalToolEnabled(config:ListenerConfig,name:ToolName,modulePermission:boolean):boolean {
  return config.toolPermissions ? config.toolPermissions[name]?.mode==='direct' : modulePermission;
}
export function observesReactions(config:ListenerConfig):boolean {
  return config.observeReactions ?? (config.toolPermissions ? false : config.tools?.reactions===true);
}

/** Sole application→listener adapter. Resolved groups never carry model credentials. */
export function toListenerConfig(app:AppConfig,group:ResolvedGroupConfig):ResolvedListenerConfig {
  const random=group.reply.random;
  return applyToolPolicies({
    groupId:group.groupId,ownerId:app.identity.ownerId,botName:app.identity.name,ownerName:app.identity.ownerName,
    enabled:group.enabled,...app.model,
    persona:group.persona,debounceMs:group.reply.delayMs[0],delayMaxMs:group.reply.delayMs[1],cooldownMs:group.reply.cooldownMs,
    mentionEnabled:group.reply.mention,quoteBotEnabled:group.reply.quoteBot,
    randomReplyProbability:random?random.probability:0,randomCooldownMs:random?random.cooldownMs:60000,randomMaxPerMinute:random?random.maxPerMinute:2,
    sessionMaxContextBytes:group.session.maxTranscriptBytes,
    serverCompaction:group.session.compaction?'auto':'off',...(group.session.compaction?{compactThreshold:group.session.compaction.thresholdTokens}:{}),
    maxToolCallsPerWake:group.execution.maxToolCallsPerWake,wakeTimeoutMs:group.execution.wakeTimeoutMs,
    memoryPath:group.storage.databasePath,retentionDays:group.history.retentionDays,
    // Cache constructor bound only; production ModelSession never summarizes via this budget.
    maxContextChars:24000,
    toolPermissions:structuredClone(group.tools),observeReactions:group.observation.reactions,
    messageMentions:group.messages.mentions,confirmationTtlSeconds:group.confirmation.ttlSeconds,
  });
}
