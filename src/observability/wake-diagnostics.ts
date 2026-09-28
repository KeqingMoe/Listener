import { types } from 'node:util';
import type { JsonObject } from '../contracts/index.js';

/** Local reason codes only. Never persist arbitrary exception or provider text. */
export const WAKE_REASON_CODES = [
  'turn_timeout', 'disconnected', 'reset', 'shutdown', 'generation_changed', 'cancelled',
  'timeout', 'http_error', 'network_error', 'response_too_large', 'invalid_response', 'truncated_response',
  'operation_failed', 'session_checkpoint_failed', 'tool_budget_exhausted', 'prose_suppressed',
  'session_rotated', 'response_state_expired', 'configuration_changed', 'transcript_resource_boundary', 'transient_images_lost', 'recovered_after_crash',
  'unavailable', 'busy', 'api_failed', 'send_failed', 'stopped', 'connection_lost', 'invalid_data',
] as const;
const COUNTERS = [
  'duration_ms', 'model_rounds', 'tool_calls', 'tool_calls_limit', 'wake_timeout_ms',
  'sent_messages', 'sent_submissions', 'management_executed', 'management_submitted', 'management_unknown',
  'reactions', 'reaction_submitted', 'reaction_unknown', 'reaction_failures',
] as const;
export function normalizeWakeDiagnostics(value: unknown): JsonObject {
  const result: JsonObject = {};
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return result;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const reason = descriptors.reason_code?.value as unknown;
    if (typeof reason === 'string' && (WAKE_REASON_CODES as readonly string[]).includes(reason)) result.reason_code = reason;
    for (const key of COUNTERS) {
      const n: unknown = descriptors[key]?.value;
      if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) result[key] = n;
    }
  } catch { /* Optional diagnostics must not prevent recording the terminal state. */ }
  return result;
}
