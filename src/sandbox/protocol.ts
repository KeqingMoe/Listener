export type DiagnosticKind = 'guest_exception' | 'contract_error';
export type DiagnosticPhase = 'compile' | 'execute' | 'result';

export interface ExecutionDiagnostic {
  kind: DiagnosticKind;
  phase: DiagnosticPhase;
  name?: string;
  message: string;
  stack?: string;
  truncated: boolean;
}

export function isExecutionDiagnostic(
  value: unknown,
): value is ExecutionDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const d = value as Record<string, unknown>;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(d))) {
    return false;
  }
  const allowed = ['kind', 'phase', 'name', 'message', 'stack', 'truncated'];
  if (
    Reflect.ownKeys(d).some(
      (k) =>
        typeof k !== 'string' ||
        !allowed.includes(k) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(d, k)!, 'value'),
    )
  ) {
    return false;
  }
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(d)) ||
    !['kind', 'phase', 'message', 'truncated'].every((k) =>
      Object.hasOwn(d, k),
    ) ||
    typeof d.kind !== 'string' ||
    typeof d.phase !== 'string' ||
    !['guest_exception', 'contract_error'].includes(d.kind) ||
    !['compile', 'execute', 'result'].includes(d.phase) ||
    typeof d.message !== 'string' ||
    typeof d.truncated !== 'boolean' ||
    ('name' in d && typeof d.name !== 'string') ||
    ('stack' in d && typeof d.stack !== 'string')
  ) {
    return false;
  }
  try {
    return Buffer.byteLength(JSON.stringify(d)) <= 8192;
  } catch {
    return false;
  }
}

/** Host side of guest `tools.<name>(args)`. Args and results are JSON values whose byte fields are Uint8Array. */
export type ToolCaller = (
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

export const TOOL_CALL_LIMITS = {
  concurrent: 8,
  jsonBytes: 1024 * 1024,
  attachmentBytes: 64 * 1024 * 1024,
  attachments: 256,
};

export interface ExecutionOptions {
  code: string;
  tools?: readonly string[];
  callTool?: ToolCaller;
  timeoutMs?: number | null;
  memoryBytes?: number;
  stackBytes?: number;
  codeBytes?: number;
  resultBytes?: number;
  logBytes?: number;
}

export type ExecutionResult =
  | { status: 'completed'; value: string; logs: string[] }
  | {
      status: 'failed' | 'cancelled';
      error: string;
      logs: string[];
      diagnostic?: ExecutionDiagnostic;
    };

export interface ExecutionLimits {
  timeoutMs: number | null;
  memoryBytes: number;
  stackBytes: number;
  codeBytes: number;
  resultBytes: number;
  logBytes: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutMs: null,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  codeBytes: 64 * 1024,
  resultBytes: 64 * 1024,
  logBytes: 16 * 1024,
};

export function normalizeOptions(options: ExecutionOptions): {
  code: string;
  limits: ExecutionLimits;
} {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits) as (keyof ExecutionLimits)[]) {
    const v = options[key];
    if (v === undefined) {
      continue;
    }
    if (key === 'timeoutMs' && v === null) {
      limits.timeoutMs = null;
      continue;
    }
    if (
      typeof v !== 'number' ||
      !Number.isSafeInteger(v) ||
      v <= 0 ||
      v > 2147483647
    ) {
      throw new Error('invalid_limits');
    }
    limits[key] = v;
  }
  if (
    typeof options.code !== 'string' ||
    Buffer.byteLength(options.code) > limits.codeBytes
  ) {
    throw new Error('code_too_large');
  }
  return { code: options.code, limits };
}
