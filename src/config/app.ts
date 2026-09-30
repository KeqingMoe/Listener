import type { Config } from './onebot.ts';
import type { LoggingConfig } from '../observability/logger.ts';
import type { ResolvedToolPolicies } from './tool-policy.ts';
/** Tagged union so further providers add branches without reinterpreting fields. */
export type WebSearchProviderConfig={type:'searxng';url:string};
export type ModelTransport='chat'|'responses'|{type:'responses';incremental:boolean};
export interface ResolvedGroupConfig {
  groupId:string; enabled:boolean; personaPath:string; persona:string;
  reply:{mention:boolean;quoteBot:boolean;delayMs:readonly [number,number];cooldownMs:number;random:false|{probability:number;cooldownMs:number;maxPerMinute:number}};
  session:{maxTranscriptBytes:number;compaction:false|{thresholdTokens:number}};
  execution:{maxToolCallsPerWake:number;wakeTimeoutMs:number};
  messages:{mentions:boolean};observation:{reactions:boolean};confirmation:{ttlSeconds:number};history:{retentionDays:number};
  storage:{databasePath:string};tools:ResolvedToolPolicies;
}
export interface AppConfig {
  configPath:string;
  identity:{name:string;ownerId:string};
  onebot:Config;
  model:{baseUrl:string;apiKey:string;model:string;timeoutMs:number;maxTokens:number;opencodeHeaders:boolean;transport:ModelTransport};
  runtime:{maxConcurrentTurns:number};
  /** Absent search means the web_search tool is not offered at all. */
  web:{search?:WebSearchProviderConfig};
  storage:{directory:string;telemetryPath:string;registryPath:string;customFaceDirectory:string;napcatCustomFaceDirectory:string;artifactDirectory:string;napcatArtifactDirectory:string};
  logging:LoggingConfig;
  defaultsEnabled:boolean;
  configuredGroupIds:readonly string[];
  resolveGroup(id:string):ResolvedGroupConfig;
}
