/**
 * 工具内部的可公开失败：code是可以原样返回给模型的静态错误码。
 * 其他任何异常都不应把message当作错误码透出。
 */
export class ToolFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function fail(code: string): never {
  throw new ToolFailure(code);
}

/** ToolFailure取其code，其余异常一律换成fallback。 */
export function failureCode(error: unknown, fallback: string): string {
  return error instanceof ToolFailure ? error.code : fallback;
}
