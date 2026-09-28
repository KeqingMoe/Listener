import { types } from 'node:util';

export interface ModelRequestDiagnostics {
  abortSource?: 'request_timeout' | 'turn_timeout' | 'disconnected' | 'reset' | 'shutdown' | 'generation_changed' | 'external_unknown';
  providerCategory?: 'previous_response_missing' | 'context_limit' | 'invalid_tool_link' | 'invalid_request' | 'rate_limit' | 'auth' | 'unknown';
  providerParameter?: 'previous_response_id' | 'input' | 'tools' | 'max_output_tokens' | 'max_tokens' | 'model' | 'other';
  failureStage?: 'request' | 'http_status' | 'response_body' | 'response_parse' | 'response_validate' | 'post_response';
  requestMode?: 'fresh' | 'continue_live' | 'continue_restored';
  requestTimeoutMs?: number;
}
const fields = {
  abortSource: ['request_timeout','turn_timeout','disconnected','reset','shutdown','generation_changed','external_unknown'],
  providerCategory: ['previous_response_missing','context_limit','invalid_tool_link','invalid_request','rate_limit','auth','unknown'],
  providerParameter: ['previous_response_id','input','tools','max_output_tokens','max_tokens','model','other'],
  failureStage: ['request','http_status','response_body','response_parse','response_validate','post_response'],
  requestMode: ['fresh','continue_live','continue_restored'],
} as const;
/** Never invoke user getters or Proxy traps, including on revoked proxies. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
export function normalizeModelRequestDiagnostics(value: unknown): ModelRequestDiagnostics | undefined {
  const result: Record<string, unknown> = {};
  for (const [key, allowed] of Object.entries(fields)) {
    const v = own(value, key);
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) result[key] = v;
  }
  const timeout = own(value, 'requestTimeoutMs');
  if (typeof timeout === 'number' && Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 2147483647) result.requestTimeoutMs = timeout;
  return Object.keys(result).length ? result as ModelRequestDiagnostics : undefined;
}
/** Upstream reasons are deliberately narrower than internal abort sources. */
export function upstreamAbortSource(reason: unknown): ModelRequestDiagnostics['abortSource'] {
  return typeof reason === 'string' && ['turn_timeout','disconnected','reset','shutdown'].includes(reason)
    ? reason as ModelRequestDiagnostics['abortSource'] : 'external_unknown';
}
const categories: Record<string, ModelRequestDiagnostics['providerCategory']> = {
  previous_response_not_found: 'previous_response_missing', previous_response_id_not_found: 'previous_response_missing', response_not_found: 'previous_response_missing',
  context_length_exceeded: 'context_limit', context_window_exceeded: 'context_limit',
  invalid_tool_call: 'invalid_tool_link', invalid_tool_call_id: 'invalid_tool_link', tool_call_not_found: 'invalid_tool_link', invalid_function_call_output: 'invalid_tool_link',
  invalid_request: 'invalid_request', invalid_request_error: 'invalid_request',
  rate_limit_exceeded: 'rate_limit', rate_limit_error: 'rate_limit', insufficient_quota: 'rate_limit',
  invalid_api_key: 'auth', authentication_error: 'auth', permission_denied: 'auth', permission_error: 'auth',
};
export function providerDiagnostics(raw: unknown): ModelRequestDiagnostics {
  const error = own(raw, 'error');
  const code = own(error, 'code'), type = own(error, 'type'), param = own(error, 'param');
  const lookup = (v: unknown) => typeof v === 'string' && Object.hasOwn(categories, v) ? categories[v] : undefined;
  const category = lookup(code) ?? lookup(type) ?? 'unknown';
  return { providerCategory: category,
    ...(typeof param === 'string' ? { providerParameter: (fields.providerParameter as readonly string[]).includes(param) ? param as ModelRequestDiagnostics['providerParameter'] : 'other' } : {}) };
}
