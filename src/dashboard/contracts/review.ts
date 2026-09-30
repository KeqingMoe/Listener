import type { Availability, Range, WakeItem } from './contracts.ts';
import type { CacheMetrics } from './metrics.ts';
import type { ModelRequestDiagnostics } from '../../observability/model-diagnostics.ts';
import type { RequestOutcome, ToolOutcome } from './outcomes.ts';

/** 所有未知标量均为null。inputTokens特指未命中缓存的输入。 */
export interface ReviewRequest extends CacheMetrics {
  performance: import('./metrics.ts').PerformanceMetrics;
  requestId: string;
  groupId: string;
  wakeId: string | null;
  turnId: string | null;
  model: string | null;
  transport: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: string;
  outcome: RequestOutcome | 'running' | 'interrupted';
  errorCode: string | null;
  httpStatus: number | null;
  diagnostics?: ModelRequestDiagnostics | null;
  inputTokens: number | null;
  totalInputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** 流式输出速率，不含首个有效输出之前的等待。 */
  tps: number | null;
  ttftMs: number | null;
  decodeDurationMs: number | null;
  responseId: string | null;
  previousResponseId: string | null;
  providerRequestId: string | null;
  requestMode: string | null;
  hasInspection: boolean;
}

export interface ReviewTool {
  ordinal: number;
  name: string;
  requestId: string | null;
  callId: string | null;
  state: string;
  status: string | null;
  outcome: ToolOutcome;
  reasonCode: string | null;
  proposedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  arguments: unknown;
  result: unknown;
}

export interface RequestLink {
  requestId: string;
  groupId: string;
  wakeId: string | null;
}

export interface RequestReviewDetail {
  request: ReviewRequest;
  requestBody: unknown;
  responseBody: unknown;
  reasoningText: string | null;
  errorText: string | null;
  contentTruncated: boolean;
  tools: ReviewTool[];
  previousRequest: RequestLink | null;
  nextRequests: RequestLink[];
}

export interface WakeReviewDetail {
  wake: WakeItem;
  requests: ReviewRequest[];
  tools: ReviewTool[];
  messages: Array<{
    role: string;
    content: unknown;
    toolCallId?: string;
    requestId?: string;
    createdAt: number | null;
  }>;
  events: Array<{
    time: number | null;
    kind: string;
    title: string;
    detail?: unknown;
  }>;
  trigger: { type?: string; messageIds?: string[]; actorId?: string } | null;
  contentTruncated: boolean;
}

export interface ReviewRequestsResponse {
  range: Range;
  items: ReviewRequest[];
  nextCursor: string | null;
}

export const EVENT_CATEGORIES = [
  'app',
  'onebot',
  'message',
  'trigger',
  'turn',
  'model',
  'tool',
  'image',
  'forward',
  'memory',
  'moderation',
  'command',
  'send',
  'attention',
  'session',
] as const;

export interface ReviewEvent {
  sequence: number;
  time: number;
  event: string;
  level: string | null;
  groupId: string | null;
  turnId: string | null;
  messageId: string | null;
  title: string;
  detail: unknown;
}

/**
 * GET /api/events?since&until&groupId&limit&cursor&category&q，category取自EVENT_CATEGORIES。
 * q只搜索event/group/turn/message元数据；全局的app/onebot连接事件始终可见。
 */
export interface ReviewEventsResponse {
  range: Range;
  items: ReviewEvent[];
  nextCursor: string | null;
}

export interface HealthResponse {
  now: number;
  availability: Availability;
  connectivity: 'connected' | 'disconnected' | 'stale' | 'unknown';
  lastHeartbeatAt: number | null;
  lastConnectionEventAt: number | null;
  groups: Array<{
    groupId: string;
    sessionAvailable: boolean;
    lastObservedMessageAt: number | null;
    observationSource: 'runtime_received' | 'legacy_world' | null;
    lastRequestAt: number | null;
  }>;
  note: string;
}
// review API约定：
// GET /api/requests?since&until&groupId&limit&cursor&outcome&q
// GET /api/requests/:id?groupId（必填）；GET /api/wakes/:id/review?groupId（必填）
// GET /api/health。所有路由都需要认证，并会重新检查群授权。
// 列表：范围不超过31天，limit为1..100；cursor绑定到具体的范围、过滤条件和群策略。
// 请求体和工具内容只能通过这些review详情路由获取，元数据API不返回。
