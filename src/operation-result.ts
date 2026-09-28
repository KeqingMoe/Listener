import { OneBotError } from './client.js';
import type { JsonObject } from './contracts/index.js';

/** A reused message ID is not evidence of a new send; distinguish it from local storage failure. */
export class DuplicateMessageAckError extends Error {
  constructor() { super('duplicate_message_ack'); this.name = 'DuplicateMessageAckError'; }
}
/** Identity verification failed before claiming an ACK; this is not a projection-only failure. */
export class UnverifiedMessageAckError extends Error {
  constructor() { super('message_ack_unverified'); this.name = 'UnverifiedMessageAckError'; }
}

/** A successful provider submission is not a failure or proof of the final QQ state. */
export function submittedResult(details: JsonObject = {}): JsonObject {
  return {
    ...details,
    status: 'ok', submitted: true, effect_confirmed: false, delivery_confirmed: false,
    confirmation_basis: 'provider_submission', retry_allowed: false,
  };
}

/** Only locally unsent calls and the audited WS pre-handler validation code prove rejection.
 * NapCat's 1200 includes exceptions AFTER writing (e.g. card/recall acknowledgement timeout).
 * Never expose remote wording or infer that such an operation had no effect.
 */
export function writeFailure(error: unknown, unknownError = 'delivery_unknown'): JsonObject {
  if (error instanceof OneBotError) {
    if (error.code === 'unavailable' || error.code === 'busy')
      return { status: 'error', error: error.code === 'busy' ? 'api_busy' : 'api_unavailable', dispatched: false };
    if (error.code === 'api_failed' && error.retcode === 1400)
      return { status: 'error', error: 'provider_rejected', provider_code: 1400, dispatched: false };
    return {
      status: 'unknown', error: unknownError, effect_unknown: true, retry_allowed: false,
      ...(error.code === 'api_failed' ? {
        provider_reported_failure: true,
        ...(Number.isSafeInteger(error.retcode) ? { provider_code: error.retcode! } : {}),
      } : {}),
    };
  }
  return { status: 'unknown', error: unknownError, effect_unknown: true, retry_allowed: false };
}

/** Cancellation cannot erase an acknowledgement already received. */
export function afterDispatch(result: JsonObject, cancelled: boolean): JsonObject {
  return cancelled && result.dispatched !== false ? { ...result, cancelled_after_dispatch: true } : result;
}
