import type { Config } from './onebot.js';
import type { LoggingConfig } from '../observability/logger.js';
import type { ResolvedToolPolicies } from './tool-policy.js';
export interface ResolvedGroupConfig {
  groupId:string; enabled:boolean; personaPath:string; persona:string;
  reply:{mention:boolean;quoteBot:boolean;delayMs:readonly [number,number];cooldownMs:number;random:false|{probability:number;cooldownMs:number;maxPerMinute:number}};
  session:{transport:'chat'|'responses';maxTranscriptBytes:number;compaction:false|{thresholdTokens:number}};
  execution:{maxToolCallsPerWake:number;wakeTimeoutMs:number};
  messages:{mentions:boolean};observation:{reactions:boolean};confirmation:{ttlSeconds:number};history:{retentionDays:number};
  storage:{databasePath:string};tools:ResolvedToolPolicies;
}
export interface AppConfig {
  configPath:string;
  identity:{name:string;ownerId:string;ownerName:string};
  onebot:Config;
  model:{baseUrl:string;apiKey:string;model:string;timeoutMs:number;maxTokens:number};
  runtime:{maxConcurrentTurns:number};
  storage:{directory:string;telemetryPath:string;registryPath:string;customFaceDirectory:string;napcatCustomFaceDirectory:string};
  logging:LoggingConfig;
  defaultsEnabled:boolean;
  configuredGroupIds:readonly string[];
  resolveGroup(id:string):ResolvedGroupConfig;
}
