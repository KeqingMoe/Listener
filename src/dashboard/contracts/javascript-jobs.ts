import type { Range } from './contracts.ts';

/** Opaque host ID; capped at Fastify's 100-character route limit (host IDs are 39). */
export function isJavascriptJobId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    /^js_[A-Za-z0-9_-]+$/.test(value)
  );
}

export interface JavascriptJobLink {
  key: string;
  anchor?: boolean;
  kind:
    | 'execution'
    | 'query'
    | 'cancellation'
    | 'notification_received'
    | 'notification_projected';
  time: number | null;
  wakeId: string | null;
  requestId: string | null;
  callId: string | null;
  ordinal: number | null;
  state: string | null;
  status: string | null;
  taskStatus: string | null;
}

export type JavascriptJobLinkLimitation =
  | 'tool_result_limit'
  | 'tool_intent_limit'
  | 'notification_journal_limit'
  | 'inbox_limit'
  | 'byte_limit'
  | 'record_size_limit'
  | 'candidate_record_unreadable'
  | 'linked_record_missing'
  | 'identifier_redacted'
  | 'wake_lookup_unavailable'
  | 'wake_lookup_limit'
  | 'anchor_unmatched'
  | 'output_limit';

/** Observations only: notification projection does not imply delivery or reading. */
export interface JavascriptJobLinksResponse {
  groupId: string;
  jobId: string;
  range: Range;
  items: JavascriptJobLink[];
  truncated: boolean;
  limitations?: JavascriptJobLinkLimitation[];
  unavailable: boolean;
}
