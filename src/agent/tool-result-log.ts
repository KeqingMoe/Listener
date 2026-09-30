import type { JsonObject } from '../contracts/json.ts';
import { log } from '../observability/logger.ts';

/** 每次工具调用结束写一条tool.complete日志；只记录白名单内的状态、错误码与布尔标记。 */
export function logToolResult(
  tool: string,
  result: JsonObject,
  started: number,
  round: number,
): void {
  const status = [
    'ok',
    'pending',
    'partial',
    'error',
    'confirmation_required',
    'executed',
    'staged',
    'unknown',
  ].includes(String(result.status))
    ? String(result.status)
    : 'error';
  const codes = [
    'invalid_arguments',
    'tool_disabled',
    'images_disabled',
    'image_unavailable',
    'forbidden_group',
    'message_not_in_context',
    'cancelled',
    'image_first',
    'call_limit',
    'forward_first',
    'transcription_first',
    'forward_disabled',
    'invalid_range',
    'budget_exhausted',
    'forbidden_reference',
    'resource_limit',
    'resource_cycle',
    'forward_unavailable',
    'range_out_of_bounds',
    'plan_limit',
    'operation_limit',
    'plan_not_found',
    'invalid_transaction',
    'random_failed',
    'turn_finished',
    'reaction_rejected',
    'reaction_result_unknown',
    'verification_failed',
    'api_unavailable',
    'reaction_failed',
    'reaction_catalog_unavailable',
    'invalid_turn',
    'reaction_users_unavailable',
    'pagination_unavailable',
    'pagination_cycle',
    'incomplete_page',
    'invalid_cursor',
    'query_invalidated',
    'provider_rejected',
    'delivery_unknown',
    'action_result_unknown',
    'operation_result_unknown',
    'previous_submission_pending',
    'membership_transition_pending',
    'duplicate_message_ack',
    'management_result_review_required',
    'confirmation_verification_failed',
    'busy',
    'web_unavailable',
    'search_unavailable',
    'search_timeout',
    'invalid_url',
    'blocked_url',
    'fetch_timeout',
    'fetch_too_large',
    'unsupported_content_type',
    'unsupported_charset',
    'fetch_failed',
  ];
  const detail =
    typeof result.error === 'string' ? result.error : result.reason;
  const reason =
    typeof detail === 'string' && codes.includes(detail)
      ? detail
      : status === 'error'
        ? 'tool_rejected'
        : undefined;
  const flags: Record<string, boolean> = {};
  for (const key of [
    'submitted',
    'effect_confirmed',
    'effect_unknown',
    'provider_reported_failure',
    'cancelled_after_dispatch',
    'local_projection_failed',
    'cached',
    'duplicate',
    'dispatched',
  ]) {
    if (typeof result[key] === 'boolean') {
      flags[key] = result[key] as boolean;
    }
  }
  log(
    status === 'error' ||
      status === 'partial' ||
      status === 'unknown' ||
      result.local_projection_failed === true
      ? 'warn'
      : 'info',
    'tool.complete',
    {
      tool,
      status,
      reason,
      round,
      ...flags,
      ...(Number.isSafeInteger(result.provider_code)
        ? { retcode: result.provider_code }
        : {}),
      duration_ms: Date.now() - started,
    },
  );
}
