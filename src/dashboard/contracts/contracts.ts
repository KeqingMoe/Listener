import type { ModelRequestDiagnostics } from "../../observability/model-diagnostics.js";
import type { RequestOutcome, ToolOutcome } from "./outcomes.js";
import type { CacheMetrics } from './metrics.js';
export interface Range {
  since: number;
  until: number;
}
export interface Availability {
  telemetry: boolean;
  sessions: Array<{ groupId: string; available: boolean }>;
}
export interface GroupMeta {
  groupId: string;
}
export interface MetaResponse {
  groups: GroupMeta[];
  readOnly: true;
  maxRangeDays: 31;
  now: number;
  availability: Availability;
}
export interface UsageSummary {
  performance: import('./metrics.js').PerformanceMetrics;
  requests: number;
  successes: number;
  errors: number;
  timeouts: number;
  cancelled: number;
  running: number;
  interrupted: number;
  unknown: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheHitRate: number | null;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  /** Weighted non-streaming end-to-end throughput for successful requests with known output usage. */
  tps: number | null;
}
export interface OverviewResponse {
  range: Range;
  availability: Availability;
  summary: UsageSummary;
  series: Array<UsageSummary & { bucketStart: number }>;
  groups: Array<UsageSummary & { groupId: string }>;
}
export interface WakeItem extends CacheMetrics {
  performance: import('./metrics.js').PerformanceMetrics;
  tps: number | null;
  wakeId: string;
  groupId: string;
  sessionId: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  outcome: string | null;
  reasonCode: string | null;
  diagnostics: Record<string, number>;
  trigger: null;
  modelRequests: number;
  toolCalls: number;
  /** Historical compatibility: total input, including cache. */
  inputTokens: number | null;
  uncachedInputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens: number | null;
}
export interface WakesResponse {
  range: Range;
  availability: Availability;
  items: WakeItem[];
  nextCursor: string | null;
}
export interface RequestItem extends CacheMetrics {
  performance: import('./metrics.js').PerformanceMetrics;
  tps: number | null;
  requestId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: "success" | "error" | "unknown";
  outcome: RequestOutcome;
  errorCode: string | null;
  httpStatus: number | null;
  diagnostics: ModelRequestDiagnostics | null;
  transport: "chat" | "responses" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}
export interface ToolItem {
  ordinal: number;
  name: string;
  state: string;
  proposedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  status: string | null;
  outcome: ToolOutcome;
  reasonCode: string | null;
}
export interface WakeDetailResponse {
  wake: WakeItem;
  requests: RequestItem[];
  tools: ToolItem[];
  truncated: boolean;
  availability: Availability;
}
export interface ToolSummary {
  name: string;
  calls: number;
  finished: number;
  pending: number;
  started: number;
  unknown: number;
  skipped: number;
  handled: number;
  rejected: number;
  deferred: number;
  cancelled: number;
  errors: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
}
export interface ToolsResponse {
  range: Range;
  availability: Availability;
  items: ToolSummary[];
}
export interface ApiError {
  error:
    | "invalid_query"
    | "forbidden"
    | "not_found"
    | "unavailable"
    | "internal_error";
  message: string;
}
// GET /api/meta
// GET /api/overview|wakes|tools?since=<epoch ms>&until=<epoch ms>&groupId=<optional enabled group>
// GET /api/wakes also accepts limit (1..100, default 30), opaque cursor, metadata q and outcome.
// outcome=running means no finish; failed/cancelled group related terminal reasons; other tokens match raw outcome.
// GET /api/wakes/:id requires groupId. Detail arrays have a 500-item resource bound.
// Ranges default to last 24 hours, max 31 days. Unknown values are null, not zero.
// Follow a wakes cursor with the exact response.range since/until and original groupId.
// Wake list/review summaries use stable inspection/message physical-turn associations, including failures and running requests.
// Legacy metadata detail keeps persisted message.request_id-only request arrays; never assume wakeId=turnId.
// uncachedInputTokens and cacheHitRate use only valid paired input/cache samples; missing usage is never zero.
// performance.modelTps (legacy tps) uses tpsOutputTokens/tpsDurationMs from the SAME successful known-output samples.
// performance.modelDurationMs sums ended HTTP durations including failures; coverage exposes missing measurements.
// toolDurationMs is cumulative real ledger timing; toolWallDurationMs/modelWallDurationMs union nested/overlapping intervals.
// otherDurationMs = wake wall minus model interval union, NOT exclusive tool/NapCat/DB latency; never add tool cumulative time to wall time.
// Global wall/round TPS and request tool/other times are null: no full-round or world-time attribution is implied.
// Cross-session physical-turn scopes may cross wake boundaries; their wall analysis stays null with whyIncomplete, never negative/clamped.
// Overview/tool scans above 10,000 rows return 503; narrow the range rather than showing partial totals.
// Metadata APIs do not return message content, raw tool arguments/results, checkpoints, or filesystem paths.
// Authorized review detail APIs expose bounded, credential-scrubbed content; see review.ts.
