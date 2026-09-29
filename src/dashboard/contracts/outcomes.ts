// Diagnostic categories do not change the model/tool protocol status or prove an external effect.
export const REQUEST_REASONS = ["cancelled", "timeout", "http_error", "network_error", "response_too_large", "invalid_response", "truncated_response"] as const;
export const REASONS = [
  ...REQUEST_REASONS, "image_first", "forward_first", "transcription_first", "turn_finished", "tool_disabled",
  "images_disabled", "forward_disabled", "forbidden_group", "forbidden_reference", "owner_required",
  "invalid_arguments", "permission_denied", "image_unavailable", "message_not_in_context", "call_limit", "invalid_range",
  "budget_exhausted", "tool_budget_exhausted", "resource_limit", "resource_cycle", "forward_unavailable",
  "range_out_of_bounds", "plan_limit", "operation_limit", "plan_not_found", "invalid_transaction",
  "random_failed", "reaction_rejected", "reaction_result_unknown", "verification_failed", "api_unavailable",
  "reaction_failed", "reaction_catalog_unavailable", "invalid_turn", "reaction_users_unavailable",
  "pagination_unavailable", "pagination_cycle", "incomplete_page", "invalid_cursor", "query_invalidated",
  "provider_rejected", "delivery_unknown", "action_result_unknown", "operation_result_unknown",
  "previous_submission_pending", "membership_transition_pending", "duplicate_message_ack",
  "management_result_review_required", "confirmation_verification_failed", "confirmation_notification_failed",
  "execution_result_unknown", "operation_failed", "session_checkpoint_failed", "reset", "disconnected",
  "shutdown", "turn_timeout", "wake_timeout", "generation_changed", "response_state_expired",
  "process_restarted", "recovered", "config_changed", "transcript_limit", "finished", "finish",
  "cursor_with_filters", "owner_reset", "recovered_after_crash", "configuration_changed", "transient_images_lost",
  "transcript_resource_boundary", "session_rotated",
  // Fixed public custom-face failure codes; never accept arbitrary provider text.
  "message_ack_unverified", "previous_operation_unresolved", "storage_configuration",
  "storage_unavailable", "storage_integrity", "storage_capacity", "storage_invalid_image",
  "invalid_data", "identity_unavailable", "identity_unverified", "directory_unavailable",
  "invalid_directory", "ambiguous_directory", "invalid_face_ref", "resource_not_verified",
  "resource_unavailable", "image_too_large", "image_identity_mismatch", "visual_output_unavailable",
  "image_budget_exhausted", "provider_reported_failure", "provider_result_unverified",
  "source_changed", "ambiguous_content", "collection_content_unverified",
  "collection_not_uniquely_verified", "collection_binding_unavailable", "description_unavailable",
] as const;
const safe = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value) ? value : null;
export const requestReason = (value: unknown): string | null => safe(value, REQUEST_REASONS);
export const reasonCode = (value: unknown): string | null => safe(value, REASONS);
export type RequestOutcome = "success" | "failed" | "cancelled" | "timeout" | "unknown";
export function requestOutcome(status: unknown, error: unknown): RequestOutcome {
  if (status === "success") return "success";
  if (status !== "error") return "unknown";
  return error === "cancelled" ? "cancelled" : error === "timeout" ? "timeout" : "failed";
}
// Match only the two exact historical messages, never expose arbitrary result text.
export function toolReason(row: { reason_code?: unknown; reason?: unknown; error?: unknown }): string | null {
  const code = reasonCode(row.reason_code) ?? reasonCode(row.reason) ?? reasonCode(row.error);
  if (code) return code;
  if (row.error === "先接收本轮图片内容，再在下一轮决定回复或操作。") return "image_first";
  if (row.error === "先接收本轮转发读取结果，再在下一轮决定回复或操作。") return "forward_first";
  return null;
}
export type ToolOutcome = "pending" | "started" | "handled" | "failed" | "rejected" | "deferred" | "cancelled" | "unknown" | "skipped";
const HANDLED = ["ok", "executed", "pending", "confirmation_required", "staged", "duplicate", "success", "submitted"];
const REJECTED = ["permission_denied", "invalid_arguments", "tool_disabled", "images_disabled", "forward_disabled", "forbidden_group", "forbidden_reference", "owner_required"];
export function toolOutcome(row: { state?: unknown; status?: unknown; reason_code?: unknown; reason?: unknown; error?: unknown }): ToolOutcome {
  if (row.state === "pending" || row.state === "started" || row.state === "skipped" || row.state === "unknown") return row.state;
  if (row.status === "skipped") return "skipped";
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "error") {
    const reason = toolReason(row);
    if (reason === "image_first" || reason === "forward_first" || reason === "transcription_first" || reason === "management_result_review_required") return "deferred";
    if (reason === "cancelled") return "cancelled";
    // A more specific diagnostic must not erase the underlying rejection category.
    if ((reason && REJECTED.includes(reason)) || (typeof row.error === "string" && REJECTED.includes(row.error))) return "rejected";
    return "failed"; // Unrecognised explicit errors remain failures, not normal handling.
  }
  return typeof row.status === "string" && HANDLED.includes(row.status) ? "handled" : "unknown";
}
