import type { ForwardConfig } from './forward-tools.js';
export interface ImagesConfig { enabled: boolean; maxPerTurn: number; maxDownloadMb: number }
export type ModerationMode = 'off' | 'confirm' | 'direct';
export interface ModerationPolicy {
  mute: ModerationMode;
  unmute: ModerationMode;
  recall: ModerationMode;
  memberCard: ModerationMode;
  confirmationTtlSeconds: number;
  maxMuteSeconds: number;
}
export interface ToolsConfig {
  members: boolean;
  mention: boolean;
  reactions?: boolean;
  moderation: ModerationPolicy;
}
export interface ListenerConfig {
  groupId?: string;
  enabled: boolean; baseUrl: string; apiKey: string; model: string;
  timeoutMs: number; maxTokens: number; debounceMs: number; cooldownMs: number;
  maxToolCallsPerWake?: number; wakeTimeoutMs?: number;
  memoryPath: string; maxContextChars: number; retentionDays: number;
  randomReplyProbability?: number; randomCooldownMs?: number; randomMaxPerMinute?: number; delayMaxMs?: number;
  persona?: string; botName?: string; ownerName?: string;
  mentionEnabled?: boolean; quoteBotEnabled?: boolean;
  tools?: ToolsConfig;
  images?: ImagesConfig;
  forward?: ForwardConfig;
  attention?: { enabled: boolean; maxPlans: number };
}
