import { OneBotError } from './client.ts';
import type { JsonObject } from '../contracts/json.ts';

/** 重复出现的消息ID不能证明发生了新的发送；用于与本地存储失败区分开。 */
export class DuplicateMessageAckError extends Error {
  constructor() {
    super('duplicate_message_ack');
    this.name = 'DuplicateMessageAckError';
  }
}

/** 在确认ACK之前身份校验就失败了；这不是仅投影（projection）层面的失败。 */
export class UnverifiedMessageAckError extends Error {
  constructor() {
    super('message_ack_unverified');
    this.name = 'UnverifiedMessageAckError';
  }
}

/** provider提交成功既不是失败，也不能证明QQ上的最终状态。 */
export function submittedResult(details: JsonObject = {}): JsonObject {
  return {
    ...details,
    status: 'ok',
    submitted: true,
    effect_confirmed: false,
    delivery_confirmed: false,
    confirmation_basis: 'provider_submission',
    retry_allowed: false,
  };
}

/**
 * 只有本地未发出的调用和经过核实的WS pre-handler校验错误码（1400）能证明请求被拒绝。
 * NapCat的1200也包括写入之后才发生的异常（例如改名片/撤回的确认超时）。
 * 绝不暴露远端的错误措辞，也不能据此推断操作没有生效。
 */
export function writeFailure(
  error: unknown,
  unknownError = 'delivery_unknown',
): JsonObject {
  if (error instanceof OneBotError) {
    if (error.code === 'unavailable' || error.code === 'busy') {
      return {
        status: 'error',
        error: error.code === 'busy' ? 'api_busy' : 'api_unavailable',
        dispatched: false,
      };
    }
    if (error.code === 'api_failed' && error.retcode === 1400) {
      return {
        status: 'error',
        error: 'provider_rejected',
        provider_code: 1400,
        dispatched: false,
      };
    }
    return {
      status: 'unknown',
      error: unknownError,
      effect_unknown: true,
      retry_allowed: false,
      ...(error.code === 'api_failed'
        ? {
            provider_reported_failure: true,
            ...(Number.isSafeInteger(error.retcode)
              ? { provider_code: error.retcode! }
              : {}),
          }
        : {}),
    };
  }
  return {
    status: 'unknown',
    error: unknownError,
    effect_unknown: true,
    retry_allowed: false,
  };
}

/** 取消不能抹掉已经收到的确认；已派发的结果只追加cancelled_after_dispatch标记。 */
export function afterDispatch(
  result: JsonObject,
  cancelled: boolean,
): JsonObject {
  return cancelled && result.dispatched !== false
    ? { ...result, cancelled_after_dispatch: true }
    : result;
}
