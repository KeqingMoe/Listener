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
  requests: number;
  successes: number;
  errors: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheHitRate: number | null;
  cacheCoverage: number | null;
  knownInputRequests: number;
  knownCacheRequests: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
}
export interface OverviewResponse {
  range: Range;
  availability: Availability;
  summary: UsageSummary;
  series: Array<UsageSummary & { bucketStart: number }>;
  groups: Array<UsageSummary & { groupId: string }>;
}
export interface WakeItem {
  wakeId: string;
  groupId: string;
  sessionId: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  outcome: string | null;
  trigger: null;
  modelRequests: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface WakesResponse {
  range: Range;
  availability: Availability;
  items: WakeItem[];
  nextCursor: string | null;
}
export interface RequestItem {
  requestId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: "success" | "error" | "unknown";
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
// GET /api/wakes also accepts limit (1..100, default 30) and opaque cursor.
// GET /api/wakes/:id requires groupId. Detail arrays have a 500-item resource bound.
// Ranges default to last 24 hours, max 31 days. Unknown values are null, not zero.
// Follow a wakes cursor with the exact response.range since/until and original groupId.
// modelRequests counts only requests linked through persisted message.request_id; never assume wakeId=turnId.
// uncachedInputTokens and cacheHitRate use only requests with both input/cache usage known.
// Overview/tool scans above 10,000 rows return 503; narrow the range rather than showing partial totals.
// No API returns message content, raw tool arguments/results, checkpoints, or filesystem paths.
