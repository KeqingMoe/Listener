import type { ModelTransport, WebSearchProviderConfig } from './app.ts';
import type { ResolvedToolPolicies } from './tool-policy.ts';
import type { ForwardConfig } from '../tools/forwards/tools.ts';
import type { ExtendedToolsConfig } from './extended-tools.ts';

export interface ImagesConfig {
  enabled: boolean;
  maxDownloadMb: number;
}

export type ModerationMode = 'off' | 'confirm' | 'direct';

export interface ModerationPolicy {
  mute: ModerationMode;
  unmute: ModerationMode;
  recall: ModerationMode;
  memberCard: ModerationMode;
  confirmationTtlSeconds: number;
  maxMuteSeconds: number;
}

interface ToolsConfig {
  members: boolean;
  mention: boolean;
  reactions?: boolean;
  extended?: ExtendedToolsConfig;
  moderation: ModerationPolicy;
}

/** 底层模块选项。实际部署通过toListenerConfig获得完整策略。 */
export interface ListenerConfig {
  groupId?: string;
  /** 可信的全局部署owner；从不接受来自群级覆盖或聊天内容的值。 */
  ownerId?: string;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  debounceMs: number;
  cooldownMs: number;
  maxToolCallsPerWake?: number;
  wakeTimeoutMs?: number;
  transport?: ModelTransport;
  sessionMaxContextBytes?: number;
  serverCompaction?: 'off' | 'auto';
  compactThreshold?: number;
  memoryPath: string;
  maxContextChars: number;
  retentionDays: number;
  randomReplyProbability?: number;
  randomCooldownMs?: number;
  randomMaxPerMinute?: number;
  delayMaxMs?: number;
  persona?: string;
  botName?: string;
  mentionEnabled?: boolean;
  quoteBotEnabled?: boolean;
  /** 已解析的授权优先于下面各模块专用的投影字段。 */
  toolPermissions?: ResolvedToolPolicies;
  observeReactions?: boolean;
  messageMentions?: boolean;
  confirmationTtlSeconds?: number;
  tools?: ToolsConfig;
  images?: ImagesConfig;
  forward?: ForwardConfig;
  attention?: { enabled: boolean; maxPlans: number };
  /** 部署配置的搜索后端；未配置时不提供web_search。 */
  webSearch?: WebSearchProviderConfig;
}

/** 应用边界始终提供完整且按群独立的策略。 */
export interface ResolvedListenerConfig extends ListenerConfig {
  toolPermissions: ResolvedToolPolicies;
  observeReactions: boolean;
  messageMentions: boolean;
  confirmationTtlSeconds: number;
}
