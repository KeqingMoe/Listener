import type { Availability, Range, WakeItem } from './contracts.js';
import type { CacheMetrics } from './metrics.js';
import type { ModelRequestDiagnostics } from '../../src/observability/model-diagnostics.js';
import type { RequestOutcome, ToolOutcome } from './outcomes.js';
/** All unknown scalars are null. inputTokens is explicitly UNCACHED input. */
export interface ReviewRequest extends CacheMetrics {
  performance: import('./metrics.js').PerformanceMetrics;
  requestId: string; groupId: string; wakeId: string | null; turnId: string | null;
  model: string | null; transport: string; startedAt: number; endedAt: number | null;
  durationMs: number | null; status: string; outcome: RequestOutcome | 'running' | 'interrupted';
  errorCode: string | null; httpStatus: number | null;
  diagnostics?: ModelRequestDiagnostics | null;
  inputTokens: number | null; totalInputTokens: number | null; cachedInputTokens: number | null;
  outputTokens: number | null; reasoningTokens: number | null;
  /** Non-streaming end-to-end outputTokens / (durationMs / 1000), never TTFT. */
  tps: number | null;
  responseId: string | null; previousResponseId: string | null; providerRequestId: string | null;
  requestMode: string | null; hasInspection: boolean;
}
export interface ReviewTool {
  ordinal: number; name: string; requestId: string | null; callId: string | null;
  state: string; status: string | null; outcome: ToolOutcome; reasonCode: string | null;
  proposedAt: number | null; startedAt: number | null; finishedAt: number | null; durationMs: number | null;
  arguments: unknown; result: unknown;
}
export interface RequestLink { requestId: string; groupId: string; wakeId: string | null }
export interface RequestReviewDetail {
  request: ReviewRequest; requestBody: unknown; responseBody: unknown;
  reasoningText: string | null; errorText: string | null; contentTruncated: boolean;
  tools: ReviewTool[]; previousRequest: RequestLink | null; nextRequests: RequestLink[];
}
export interface WakeReviewDetail {
  wake: WakeItem; requests: ReviewRequest[]; tools: ReviewTool[];
  messages: Array<{role: string; content: unknown; toolCallId?: string; requestId?: string; createdAt: number | null}>;
  events: Array<{time: number | null; kind: string; title: string; detail?: unknown}>;
  trigger: {type?: string; messageIds?: string[]; actorId?: string} | null;
  contentTruncated: boolean;
}
export interface ReviewRequestsResponse { range: Range; items: ReviewRequest[]; nextCursor: string | null }
export const EVENT_CATEGORIES = ['app','onebot','message','trigger','turn','model','tool','image','forward','memory','moderation','command','send','attention','session'] as const;
export interface ReviewEvent {
  sequence: number; time: number; event: string; level: string | null;
  groupId: string | null; turnId: string | null; messageId: string | null;
  title: string; detail: unknown;
}
export interface ReviewEventsResponse { range: Range; items: ReviewEvent[]; nextCursor: string | null }
// GET /api/events?since&until&groupId&limit&cursor&category&q; category is EVENT_CATEGORIES.
// q searches event/group/turn/message metadata only; global app/onebot connection events remain visible.
export interface HealthResponse {
  now: number; availability: Availability; connectivity: 'connected' | 'disconnected' | 'stale' | 'unknown';
  lastHeartbeatAt: number | null; lastConnectionEventAt: number | null;
  groups: Array<{groupId: string; sessionAvailable: boolean; lastObservedMessageAt: number | null; observationSource: 'runtime_received' | 'legacy_world' | null; lastRequestAt: number | null}>;
  note: string;
}
// GET /api/requests?since&until&groupId&limit&cursor&outcome&q
// GET /api/requests/:id?groupId (required); GET /api/wakes/:id/review?groupId (required)
// GET /api/health. All routes require authenticated access and refresh group authorization.
// Lists: range <=31 days, limit 1..100; cursor bound to exact range/filter/group policy.
// Request bodies/tool content available only from these review detail routes, not metadata APIs.
