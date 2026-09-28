import type { ModelTransport } from './app.js';
import type { ResolvedToolPolicies } from './tool-policy.js';
import type { ForwardConfig } from '../tools/forwards/tools.js';
import type { ExtendedToolsConfig } from './extended-tools.js';
export interface ImagesConfig { enabled: boolean; maxDownloadMb: number }
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
  extended?: ExtendedToolsConfig;
  moderation: ModerationPolicy;
}
/** Low-level module options. Deployments obtain a complete policy from toListenerConfig. */
export interface ListenerConfig {
  groupId?: string;
  /** Trusted global deployment owner; never accepted from group overrides or chat. */
  ownerId?: string;
  enabled: boolean; baseUrl: string; apiKey: string; model: string;
  timeoutMs: number; maxTokens: number; debounceMs: number; cooldownMs: number;
  maxToolCallsPerWake?: number; wakeTimeoutMs?: number;
  transport?: ModelTransport; sessionMaxContextBytes?: number;
  serverCompaction?: 'off' | 'auto'; compactThreshold?: number;
  memoryPath: string; maxContextChars: number; retentionDays: number;
  randomReplyProbability?: number; randomCooldownMs?: number; randomMaxPerMinute?: number; delayMaxMs?: number;
  persona?: string; botName?: string; ownerName?: string;
  mentionEnabled?: boolean; quoteBotEnabled?: boolean;
  /** Resolved authorization takes precedence over the module-specific projections below. */
  toolPermissions?: ResolvedToolPolicies;
  observeReactions?: boolean;
  messageMentions?: boolean;
  confirmationTtlSeconds?: number;
  tools?: ToolsConfig;
  images?: ImagesConfig;
  forward?: ForwardConfig;
  attention?: { enabled: boolean; maxPlans: number };
}

/** The application boundary always supplies a complete, independently scoped policy. */
export interface ResolvedListenerConfig extends ListenerConfig {
  toolPermissions: ResolvedToolPolicies;
  observeReactions: boolean;
  messageMentions: boolean;
  confirmationTtlSeconds: number;
}
