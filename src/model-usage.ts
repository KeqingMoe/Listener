import type { ModelRequestDiagnostics } from './model-diagnostics.js';
export type { ModelRequestDiagnostics } from './model-diagnostics.js';
export interface ModelUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
}
export type RequestErrorCode = 'cancelled' | 'timeout' | 'http_error' | 'network_error' | 'response_too_large' | 'invalid_response' | 'truncated_response';
export const REQUEST_ERRORS: readonly RequestErrorCode[] = ['cancelled','timeout','http_error','network_error','response_too_large','invalid_response','truncated_response'];
export interface ModelRequestInspection {
  requestJson?: string; responseJson?: string; reasoningText?: string; errorText?: string;
  responseId?: string; previousResponseId?: string; providerRequestId?: string; requestMode?: string; contentTruncated?: boolean;
}
export interface ModelRequestStart {
  readonly requestId: string; readonly startedAt: number; readonly transport: 'chat' | 'responses'; readonly model: string;
  readonly requestJson: string; readonly requestMode: string; readonly previousResponseId?: string;
}
export interface ModelRequestRecord {
  inspection?: ModelRequestInspection;
  requestId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  transport: 'chat' | 'responses';
  model: string;
  status: 'success' | 'error';
  errorCode?: RequestErrorCode;
  httpStatus?: number;
  usage: ModelUsage;
  diagnostics?: ModelRequestDiagnostics;
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
/** Invalid/missing counts remain unknown; dependent counters require their denominator. */
export function normalizeUsage(value: unknown): ModelUsage {
  const v=object(value), inputTokens=count(v.inputTokens), outputTokens=count(v.outputTokens);
  const cached=count(v.cachedInputTokens), reasoning=count(v.reasoningTokens);
  return {inputTokens,outputTokens,totalTokens:count(v.totalTokens),
    cachedInputTokens:cached!==null&&inputTokens!==null&&cached<=inputTokens?cached:null,
    reasoningTokens:reasoning!==null&&outputTokens!==null&&reasoning<=outputTokens?reasoning:null};
}
export function parseChatUsage(value: unknown): ModelUsage {
  const v=object(value), details=object(v.prompt_tokens_details);
  // Canonical field wins when present, including malformed canonical values. Do
  // not silently fall back to a conflicting vendor counter in that case.
  const cached=Object.hasOwn(details,'cached_tokens')?details.cached_tokens:v.prompt_cache_hit_tokens;
  return normalizeUsage({inputTokens:v.prompt_tokens,outputTokens:v.completion_tokens,totalTokens:v.total_tokens,
    cachedInputTokens:cached,reasoningTokens:object(v.completion_tokens_details).reasoning_tokens});
}
export function parseResponsesUsage(value: unknown): ModelUsage {
  const v=object(value);
  return normalizeUsage({inputTokens:v.input_tokens,outputTokens:v.output_tokens,totalTokens:v.total_tokens,
    cachedInputTokens:object(v.input_tokens_details).cached_tokens,reasoningTokens:object(v.output_tokens_details).reasoning_tokens});
}
