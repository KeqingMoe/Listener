import type { Config } from './onebot.ts';
import type { LoggingConfig } from '../observability/logger.ts';
import type { ResolvedToolPolicies } from './tool-policy.ts';

/** 带标签的联合类型，新增provider只需加分支，无需重新解释已有字段。 */
export type WebSearchProviderConfig = { type: 'searxng'; url: string };

export type ModelTransport =
  'chat' | 'responses' | { type: 'responses'; incremental: boolean };

export interface ResolvedGroupConfig {
  groupId: string;
  enabled: boolean;
  personaPath: string;
  persona: string;
  reply: {
    mention: boolean;
    quoteBot: boolean;
    delayMs: readonly [number, number];
    cooldownMs: number;
    random:
      false | { probability: number; cooldownMs: number; maxPerMinute: number };
  };
  session: {
    maxTranscriptBytes: number;
  };
  execution: { maxToolCallsPerWake: number; wakeTimeoutMs: number };
  messages: { mentions: boolean };
  observation: { reactions: boolean };
  confirmation: { ttlSeconds: number };
  history: { retentionDays: number };
  storage: { databasePath: string };
  tools: ResolvedToolPolicies;
}

export interface AppConfig {
  configPath: string;
  identity: { name: string; ownerId: string };
  onebot: Config;
  model: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxTokens: number;
    opencodeHeaders: boolean;
    transport: ModelTransport;
  };
  runtime: { maxConcurrentTurns: number };
  /** 未配置search时完全不提供web_search工具。 */
  web: { search?: WebSearchProviderConfig };
  storage: {
    directory: string;
    telemetryPath: string;
    registryPath: string;
    customFaceDirectory: string;
    napcatCustomFaceDirectory: string;
    artifactDirectory: string;
    napcatArtifactDirectory: string;
  };
  logging: LoggingConfig;
  defaultsEnabled: boolean;
  configuredGroupIds: readonly string[];
  resolveGroup(id: string): ResolvedGroupConfig;
}
