import type { ChatMessage, Completion, Model } from '../contracts/model.ts';
import { MODEL_USER_AGENT } from '../config/version.ts';
import type { ToolCall, ToolDefinition } from '../contracts/tools.ts';
import { log } from '../observability/logger.ts';
import { EXTENDED_TOOL_NAMES } from '../config/extended-tools.ts';
import { randomUUID } from 'node:crypto';
import {
  providerRequestId,
  readErrorInspection,
  responseInspection,
} from '../observability/request-inspection.ts';
import {
  parseChatUsage,
  type ModelRequestInspection,
  type ModelRequestStart,
  type ModelRequestRecord,
  type ModelUsage,
} from '../observability/model-usage.ts';

export type {
  ModelRequestRecord,
  ModelUsage,
  ModelRequestDiagnostics,
} from '../observability/model-usage.ts';
import {
  normalizeModelRequestDiagnostics,
  providerDiagnostics,
  upstreamAbortSource,
  type ModelRequestDiagnostics,
} from '../observability/model-diagnostics.ts';
import { readSse, SseError } from './sse.ts';

export type ModelErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'response_too_large'
  | 'invalid_response'
  | 'truncated_response';

export class ModelError extends Error {
  readonly diagnostics?: ModelRequestDiagnostics;
  constructor(
    readonly code: ModelErrorCode,
    readonly httpStatus?: number,
    diagnostics?: ModelRequestDiagnostics,
  ) {
    super(
      code === 'cancelled' || code === 'timeout'
        ? 'Model request aborted or timed out'
        : 'Model request failed',
    );
    this.name = 'ModelError';
    this.diagnostics = normalizeModelRequestDiagnostics(diagnostics);
  }
}

const KNOWN_TOOLS = new Set([
  ...EXTENDED_TOOL_NAMES,
  'send_message',
  'finish',
  'get_group_members',
  'get_member_info',
  'read_message',
  'view_images',
  'read_forward',
  'mute_member',
  'unmute_member',
  'recall_message',
  'set_member_card',
  'manage_attention',
  'react_message',
  'get_reaction_users',
]);

function usageLogFields(u: ModelUsage): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const [field, key] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
    ['cached_input_tokens', 'cachedInputTokens'],
    ['reasoning_tokens', 'reasoningTokens'],
    ['prompt_tokens', 'inputTokens'],
    ['completion_tokens', 'outputTokens'],
  ] as const) {
    const n = u[key];
    if (n != null) {
      fields[field] = n;
    }
  }
  if (
    u.cachedInputTokens != null &&
    u.inputTokens != null &&
    u.inputTokens > 0
  ) {
    fields.cache_hit_rate = u.cachedInputTokens / u.inputTokens;
  }
  return fields;
}

export interface OpenAIModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  onRequestStart?: (record: ModelRequestStart) => void;
  onRequest?: (record: ModelRequestRecord) => void;
  /** Evaluated per request; authentication, content type and User-Agent remain authoritative. */
  requestHeaders?: () => Readonly<Record<string, string>>;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validate(value: unknown): Completion {
  if (
    !object(value) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  ) {
    throw Error();
  }
  const choice: unknown = value.choices[0];
  if (!object(choice) || !object(choice.message)) {
    throw Error();
  }
  const message = choice.message;
  if (
    message.role !== 'assistant' ||
    (message.content !== undefined &&
      message.content !== null &&
      typeof message.content !== 'string')
  ) {
    throw Error();
  }
  if (
    choice.finish_reason !== 'stop' &&
    choice.finish_reason !== 'tool_calls'
  ) {
    throw Error();
  }
  const calls: unknown =
    message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(calls) || calls.length > 8) {
    throw Error();
  }
  if ((choice.finish_reason === 'tool_calls') !== calls.length > 0) {
    throw Error();
  }
  const ids = new Set<string>();
  const validated: ToolCall[] = calls.map((call: unknown) => {
    if (
      !object(call) ||
      typeof call.id !== 'string' ||
      !call.id ||
      call.id.length > 256 ||
      ids.has(call.id) ||
      call.type !== 'function' ||
      !object(call.function)
    ) {
      throw Error();
    }
    const fn = call.function;
    // Validate the transport envelope, not tool semantics: unknown/disabled tools
    // and invalid argument JSON must reach the dispatcher, consume its shared
    // wake budget, and return a tool result the model can correct.
    if (
      typeof fn.name !== 'string' ||
      !fn.name.length ||
      fn.name.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(fn.name) ||
      typeof fn.arguments !== 'string' ||
      Buffer.byteLength(fn.arguments) > MAX_ARGUMENT_BYTES
    ) {
      throw Error();
    }
    ids.add(call.id);
    return {
      id: call.id,
      type: 'function',
      function: { name: fn.name, arguments: fn.arguments },
    };
  });
  return {
    content: (message.content ?? null) as string | null,
    tool_calls: validated,
  };
}

/** Single attempt transport. Errors deliberately contain no remote text or underlying cause. */
export class OpenAIModel implements Model {
  private readonly endpoint: string;
  private readonly options: OpenAIModelOptions;
  constructor(options: OpenAIModelOptions) {
    try {
      const url = new URL(options.baseUrl);
      const local =
        url.hostname === 'localhost' ||
        url.hostname === '[::1]' ||
        /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        options.baseUrl.includes('?') ||
        options.baseUrl.includes('#') ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
        !options.apiKey ||
        /[\r\n]/.test(options.apiKey) ||
        !options.model ||
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 2_147_483_647 ||
        !Number.isSafeInteger(options.maxTokens) ||
        options.maxTokens < 1
      ) {
        throw Error();
      }
      url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
      this.endpoint = url.toString();
      this.options = { ...options };
    } catch {
      throw new Error('Invalid model configuration');
    }
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    signal?: AbortSignal,
  ): Promise<Completion> {
    const started = performance.now();
    const startedAt = Date.now();
    const requestId = randomUUID();
    let requestUsage: ModelUsage = {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
    };
    let requestStatus: ModelRequestRecord['status'] = 'error';
    const toolNames = tools
      .map((tool) => tool.function.name)
      .filter((name) => KNOWN_TOOLS.has(name));
    log('info', 'model.start', { tools: toolNames });
    const controller = new AbortController();
    let abortReason: 'cancelled' | 'timeout' | undefined;
    let failure: ModelErrorCode = 'network_error';
    let httpStatus: number | undefined;
    const diagnostics: ModelRequestDiagnostics = {
      requestMode: 'fresh',
      requestTimeoutMs: this.options.timeoutMs,
    };
    let stage: ModelRequestDiagnostics['failureStage'] = 'request';
    const abort = () => {
      if (!abortReason) {
        abortReason = 'cancelled';
        diagnostics.abortSource = upstreamAbortSource(signal?.reason);
      }
      controller.abort();
    };
    const timer = setTimeout(() => {
      if (!abortReason) {
        abortReason = 'timeout';
        diagnostics.abortSource = 'request_timeout';
      }
      controller.abort();
    }, this.options.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    let inspection: ModelRequestInspection = { requestMode: 'fresh' };
    const chunks: Uint8Array[] = [];
    let bodyComplete = false;
    let firstOutputAt: number | undefined,
      streamCompletedAt: number | undefined;
    let streamedContent = '',
      reasoning = '',
      finishReason: string | undefined,
      rawUsage: unknown,
      responseId: string | undefined;
    let sentAt = started;
    const streamedCalls = new Map<
      number,
      { id: string; name: string; arguments: string; argumentBytes: number }
    >();
    let assembledBytes = 0,
      capturedBytes = 0,
      captureTruncated = false;
    const account = (text: string) => {
      assembledBytes += Buffer.byteLength(text);
      if (assembledBytes > MAX_RESPONSE_BYTES) {
        failure = 'response_too_large';
        throw Error();
      }
    };
    try {
      const requestJson = JSON.stringify({
        model: this.options.model,
        messages,
        max_tokens: this.options.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      });
      inspection.requestJson = requestJson;
      try {
        this.options.onRequestStart?.(
          Object.freeze({
            requestId,
            startedAt,
            transport: 'chat',
            model: this.options.model,
            requestJson,
            requestMode: 'fresh',
          }),
        );
      } catch {}
      const headers = new Headers(this.options.requestHeaders?.());
      headers.set('content-type', 'application/json');
      headers.set('authorization', `Bearer ${this.options.apiKey}`);
      headers.set('user-agent', MODEL_USER_AGENT);
      sentAt = performance.now();
      const response = await fetch(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers,
        body: requestJson,
      });
      inspection.providerRequestId = providerRequestId(response.headers);
      if (!response.ok) {
        failure = 'http_error';
        httpStatus = response.status;
        stage = 'http_status';
        diagnostics.providerCategory = 'unknown';
        // An observed HTTP failure wins over timeout/cancellation during diagnostic collection.
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        abortReason = undefined;
        inspection = {
          ...inspection,
          ...(await readErrorInspection(response)),
        };
        throw Error();
      }
      stage = 'response_body';
      if (
        !response.body ||
        (response.headers.get('content-type') ?? '')
          .split(';', 1)[0]!
          .trim()
          .toLowerCase() !== 'text/event-stream'
      ) {
        failure = 'invalid_response';
        throw Error();
      }
      const length = response.headers.get('content-length');
      if (length && Number(length) > MAX_WIRE_BYTES) {
        failure = 'response_too_large';
        await response.body.cancel();
        throw Error();
      }
      failure = 'invalid_response';
      await readSse(
        response.body,
        (data, at) => {
          if (data === '[DONE]') {
            if (!finishReason) {
              throw Error();
            }
            streamCompletedAt = at;
            return true;
          }
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            failure = 'invalid_response';
            throw Error();
          }
          if (!object(event)) {
            throw Error();
          }
          const raw = event;
          if (raw.id !== undefined) {
            if (
              typeof raw.id !== 'string' ||
              raw.id.length > 256 ||
              (responseId !== undefined && responseId !== raw.id)
            ) {
              throw Error();
            }
            responseId = raw.id;
          }
          if (raw.error != null) {
            Object.assign(diagnostics, providerDiagnostics(raw));
            throw Error();
          }
          if (!Array.isArray(raw.choices) || raw.choices.length > 1) {
            throw Error();
          }
          const choices = raw.choices;
          if (raw.usage) {
            rawUsage = raw.usage;
            requestUsage = parseChatUsage(raw.usage);
          }
          const choice = object(choices[0]) ? choices[0] : undefined;
          if (!choice) {
            if (choices.length) {
              throw Error();
            }
            return;
          }
          if (choice.index !== 0 || !object(choice.delta)) {
            throw Error();
          }
          const alreadyFinished = finishReason !== undefined;
          if (
            choice.finish_reason !== null &&
            choice.finish_reason !== undefined
          ) {
            if (typeof choice.finish_reason !== 'string' || alreadyFinished) {
              throw Error();
            }
            finishReason = choice.finish_reason;
          }
          const delta = object(choice.delta) ? choice.delta : {};
          if (
            Object.hasOwn(delta, 'content') &&
            delta.content !== null &&
            delta.content !== undefined &&
            typeof delta.content !== 'string'
          ) {
            throw Error();
          }
          if (
            Object.hasOwn(delta, 'tool_calls') &&
            !Array.isArray(delta.tool_calls) &&
            delta.tool_calls !== undefined
          ) {
            throw Error();
          }
          let effective = false;
          for (const key of [
            'content',
            'reasoning_content',
            'reasoning',
          ] as const) {
            if (typeof delta[key] === 'string' && delta[key]) {
              effective = true;
              account(delta[key]);
              if (key === 'content') {
                streamedContent += delta[key];
              } else {
                reasoning += delta[key];
              }
            }
          }
          const tc = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          for (const item of tc) {
            if (
              !object(item) ||
              !Number.isSafeInteger(item.index) ||
              (item.index as number) < 0 ||
              (item.index as number) >= 8
            ) {
              throw Error();
            }
            if (item.type !== undefined && item.type !== 'function') {
              throw Error();
            }
            const index = item.index as number;
            let call = streamedCalls.get(index);
            if (!call) {
              call = { id: '', name: '', arguments: '', argumentBytes: 0 };
              streamedCalls.set(index, call);
            }
            if (item.id !== undefined) {
              if (
                typeof item.id !== 'string' ||
                !item.id ||
                (call.id && call.id !== item.id)
              ) {
                throw Error();
              }
              call.id = item.id;
            }
            if (item.function !== undefined && !object(item.function)) {
              throw Error();
            }
            if (object(item.function)) {
              for (const key of ['name', 'arguments'] as const) {
                const value = item.function[key];
                if (value !== undefined) {
                  if (typeof value !== 'string') {
                    throw Error();
                  }
                  if (value) {
                    if (key === 'arguments') {
                      call.argumentBytes += Buffer.byteLength(value);
                      if (call.argumentBytes > MAX_ARGUMENT_BYTES) {
                        throw Error();
                      }
                    } else if (
                      Buffer.byteLength(call.name) + Buffer.byteLength(value) >
                      128
                    ) {
                      throw Error();
                    }
                    call[key] += value;
                    effective = true;
                  }
                }
              }
            }
          }
          if (alreadyFinished && (effective || tc.length)) {
            throw Error();
          }
          if (effective && firstOutputAt === undefined) {
            firstOutputAt = at;
          }
        },
        {
          maxBytes: MAX_WIRE_BYTES,
          signal: controller.signal,
          onBytes: (chunk) => {
            if (capturedBytes < MAX_RESPONSE_BYTES) {
              const keep = chunk.subarray(
                0,
                MAX_RESPONSE_BYTES - capturedBytes,
              );
              chunks.push(keep);
              capturedBytes += keep.byteLength;
              if (keep.byteLength < chunk.byteLength) {
                captureTruncated = true;
              }
            }
          },
        },
      );
      bodyComplete = true;
      inspection = {
        ...inspection,
        ...responseInspection(Buffer.concat(chunks).toString('utf8')),
      };
      if (finishReason === 'length') {
        failure = 'truncated_response';
        throw Error();
      }
      if (!finishReason) {
        throw Error();
      }
      const value = {
        ...(responseId ? { id: responseId } : {}),
        choices: [
          {
            message: {
              role: 'assistant',
              content: streamedContent || null,
              tool_calls: [...streamedCalls.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([index, call]) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
            },
            finish_reason: finishReason,
          },
        ],
        usage: rawUsage,
      };
      inspection = {
        ...inspection,
        ...responseInspection(JSON.stringify(value)),
        ...(reasoning ? { reasoningText: reasoning } : {}),
      };
      stage = 'response_validate';
      const result = validate(value);
      stage = 'post_response';
      if (controller.signal.aborted) {
        throw Error();
      }
      requestStatus = 'success';
      log('info', 'model.complete', {
        duration_ms: performance.now() - started,
        tools: toolNames,
        outcome: 'success',
        ...usageLogFields(requestUsage),
      });
      return result;
    } catch (error) {
      if (error instanceof SseError) {
        failure = error.code;
      }
      if (!inspection.errorText && error instanceof Error && error.message) {
        inspection.errorText = error.message;
      }
      const code = abortReason ?? failure;
      log(code === 'cancelled' ? 'info' : 'warn', 'model.failed', {
        duration_ms: performance.now() - started,
        tools: toolNames,
        reason: code,
        ...usageLogFields(requestUsage),
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      });
      diagnostics.failureStage = stage;
      throw new ModelError(code, httpStatus, diagnostics);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const code =
        requestStatus === 'error' ? (abortReason ?? failure) : undefined;
      if (!bodyComplete && chunks.length) {
        inspection = {
          ...inspection,
          ...responseInspection(Buffer.concat(chunks).toString('utf8'), true),
        };
      }
      if (code && !inspection.errorText) {
        inspection.errorText = code;
      }
      const record: ModelRequestRecord = {
        inspection,
        requestId,
        startedAt,
        endedAt: Date.now(),
        durationMs: Math.max(0, performance.now() - started),
        ttftMs: firstOutputAt === undefined ? null : firstOutputAt - sentAt,
        decodeDurationMs:
          requestStatus === 'success' &&
          firstOutputAt !== undefined &&
          streamCompletedAt !== undefined
            ? streamCompletedAt - firstOutputAt
            : null,
        transport: 'chat',
        model: this.options.model,
        status: requestStatus,
        ...(code ? { errorCode: code } : {}),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        usage: requestUsage,
        diagnostics: normalizeModelRequestDiagnostics(diagnostics),
      };
      try {
        this.options.onRequest?.(record);
      } catch {
        /* telemetry observers are non-critical */
      }
    }
  }
}
