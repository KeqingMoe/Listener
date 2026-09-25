import type { ForwardConfig } from './forward-tools.js';
export interface ImagesConfig { enabled: boolean; maxPerTurn: number; maxDownloadMb: number }
export interface ModerationPolicy {
  mute: boolean;
  recall: boolean;
  memberCard: boolean;
  confirmationTtlSeconds: number;
  maxMuteSeconds: number;
}
export interface ToolsConfig {
  members: boolean;
  mention: boolean;
  moderation: ModerationPolicy;
}
export interface ListenerConfig {
  groupId?: string;
  enabled: boolean; baseUrl: string; apiKey: string; model: string;
  timeoutMs: number; maxTokens: number; debounceMs: number; cooldownMs: number;
  memoryPath: string; maxContextChars: number; retentionDays: number;
  randomReplyProbability?: number; randomCooldownMs?: number; randomMaxPerMinute?: number; delayMaxMs?: number;
  persona?: string; botName?: string; ownerName?: string;
  mentionEnabled?: boolean; quoteBotEnabled?: boolean; maxParts?: number;
  tools?: ToolsConfig;
  images?: ImagesConfig;
  forward?: ForwardConfig;
  attention?: { enabled: boolean; maxPlans: number };
}
