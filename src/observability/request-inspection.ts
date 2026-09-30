import type { ModelRequestInspection } from './model-usage.ts';

// 这里处理的都是私有诊断材料，绝不能传给公开logger。
const INSPECTION_FIELD_BYTES = 64 * 1024;
const credentialKey =
  /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|password|passwd|secret|token|secret[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|confirmation[-_]?code|confirm[-_]?code|authorization[-_]?code|auth[-_]?code)$/i;

function scrubText(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return (
    text
      .replace(/(\/confirm\s+)[0-9a-f]{32}\b/gi, '$1[REDACTED]')
      .replace(
        /data:image\/[^;\s]+;base64,[a-zA-Z0-9+/=\r\n]+/g,
        (value) => `[image data omitted; ${Buffer.byteLength(value)} bytes]`,
      )
      // header值有自己的语法：认证scheme中含空格，Cookie/Set-Cookie含多个分号分隔的凭据，
      // 因此整行值都要遮蔽。
      .replace(
        /^([ \t]*(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)[ \t]*:[ \t]*)[^\r\n]*/gim,
        '$1[REDACTED]',
      )
      .replace(
        /(\b(?:authorization|proxy[-_]?authorization)["']?[ \t]*[:=][ \t]*)(?:Basic|Bearer|Negotiate)[ \t]+[A-Za-z0-9._~+/-]+=*/gi,
        '$1[REDACTED]',
      )
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
      // 正文里单独出现的token/secret属于业务文本，不视为认证上下文，因此不在此列。
      .replace(
        /(\b(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|password|passwd|secret[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|confirmation[-_]?code|confirm[-_]?code|authorization[-_]?code|auth[-_]?code)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
        '$1[REDACTED]',
      )
  );
}

function scrub(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 80) {
    return '[omitted: nesting limit]';
  }
  if (typeof value === 'string') {
    // 工具参数和输出里经常是序列化后的JSON，先解析再逐字段脱敏。
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') {
        return JSON.stringify(scrub(parsed, secrets, depth + 1));
      }
    } catch {}
    return scrubText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, secrets, depth + 1));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const imageBase64 =
      record.type === 'base64' &&
      typeof record.media_type === 'string' &&
      /^image\/[a-z0-9.+-]+$/i.test(record.media_type);
    return Object.fromEntries(
      Object.entries(record).map(([key, v]) => [
        key,
        credentialKey.test(key) ||
        (key === 'code' && record.status === 'confirmation_required')
          ? '[REDACTED]'
          : key === 'encrypted_content'
            ? '[encrypted reasoning omitted; not readable]'
            : key === 'data' && imageBase64 && typeof v === 'string'
              ? `[image data omitted; ${Buffer.byteLength(v)} bytes]`
              : scrub(v, secrets, depth + 1),
      ]),
    );
  }
  return value;
}

/** 脱敏后按字节上限裁剪；超限时深度优先保留前部内容并插入截断标记。 */
export function sanitizeInspectionValue(
  value: unknown,
  secrets: readonly string[] = [],
  maxBytes = 1024 * 1024,
): { value: unknown; truncated: boolean } {
  const clean = scrub(value, secrets);
  const serialized = JSON.stringify(clean) ?? 'null';
  const limit = Number.isFinite(maxBytes)
    ? Math.max(256, Math.floor(maxBytes))
    : 1024 * 1024;
  if (Buffer.byteLength(serialized) <= limit) {
    return {
      value: clean,
      truncated:
        serialized.includes('[omitted: nesting limit]') ||
        serialized.includes('[image data omitted;'),
    };
  }
  let budget = limit - 128;
  const cut = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const bytes = Buffer.byteLength(JSON.stringify(v));
      if (bytes <= budget) {
        budget -= bytes;
        return v;
      }
      const prefix = Buffer.from(v)
        .subarray(0, Math.max(0, Math.floor((budget - 100) / 6)))
        .toString('utf8');
      budget = 0;
      return prefix + `[truncated string; ${Buffer.byteLength(v)} bytes]`;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      budget -= 96; // 递归前先为省略标记预留空间。
      for (const item of v) {
        if (budget < 128) {
          out.push('[truncated: remaining array items omitted]');
          break;
        }
        budget--;
        out.push(cut(item));
      }
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = Object.create(null);
      budget -= 96; // 为递归返回时追加的标记预留空间。
      for (const [key, item] of Object.entries(v)) {
        const cost = Buffer.byteLength(JSON.stringify(key)) + 2;
        if (budget < cost + 128) {
          out._inspection_truncated = 'remaining fields omitted';
          break;
        }
        budget -= cost;
        out[key] = cut(item);
      }
      return out;
    }
    budget -= Buffer.byteLength(JSON.stringify(v) ?? 'null');
    return v;
  };
  return { value: cut(clean), truncated: true };
}

export function sanitizeInspection(
  value: ModelRequestInspection,
  secrets: readonly string[] = [],
): ModelRequestInspection {
  const out: ModelRequestInspection = {};
  let truncated = value.contentTruncated === true;
  for (const key of [
    'requestJson',
    'responseJson',
    'reasoningText',
    'errorText',
    'responseId',
    'previousResponseId',
    'providerRequestId',
    'requestMode',
  ] as const) {
    const input = value[key];
    if (typeof input !== 'string') {
      continue;
    }
    const limit =
      key === 'requestJson' || key === 'responseJson'
        ? 1024 * 1024
        : INSPECTION_FIELD_BYTES;
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(input);
      isJson = true;
    } catch {
      parsed = input;
    }
    const clean = sanitizeInspectionValue(parsed, secrets, limit);
    out[key] = isJson
      ? JSON.stringify(clean.value)
      : typeof clean.value === 'string'
        ? clean.value
        : JSON.stringify(clean.value);
    truncated ||= clean.truncated;
  }
  out.contentTruncated = truncated;
  return out;
}

export function providerRequestId(headers: Headers): string | undefined {
  for (const key of [
    'x-request-id',
    'request-id',
    'openai-request-id',
    'x-amzn-requestid',
  ]) {
    const value = headers.get(key);
    if (value) {
      return value.slice(0, 512);
    }
  }
  return undefined;
}

export function responseInspection(
  text: string,
  partial = false,
): ModelRequestInspection {
  const result: ModelRequestInspection = {
    responseJson: partial ? `[partial response; incomplete]\n${text}` : text,
    contentTruncated: partial,
  };
  try {
    const raw = JSON.parse(text);
    const reasoning: string[] = [];
    if (typeof raw.id === 'string') {
      result.responseId = raw.id;
    }
    for (const choice of raw.choices ?? []) {
      const m = choice?.message;
      for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
        if (typeof m?.[key] === 'string') {
          reasoning.push(m[key]);
        }
      }
    }
    for (const item of raw.output ?? []) {
      if (item?.type === 'reasoning') {
        for (const key of ['summary', 'content']) {
          for (const part of Array.isArray(item[key]) ? item[key] : []) {
            if (typeof part?.text === 'string') {
              reasoning.push(part.text);
            }
          }
        }
        if (typeof item.text === 'string') {
          reasoning.push(item.text);
        }
        if (item.encrypted_content) {
          reasoning.push('[encrypted reasoning omitted; not readable]');
        }
      }
    }
    if (reasoning.length) {
      result.reasoningText = reasoning.join('\n');
    }
    if (raw.error != null) {
      result.errorText =
        typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error);
    }
  } catch {
    /* 非JSON或不完整的响应体按原文保留，不伪造成JSON。 */
  }
  return result;
}

/** HTTP请求已经失败，读取错误响应体用于诊断时只给极短的时间预算，不能占用模型请求的超时。 */
export async function readErrorInspection(
  response: Response,
  budgetMs = 25,
): Promise<ModelRequestInspection> {
  if (!response.body) {
    return { errorText: '[HTTP error body unavailable]' };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0,
    complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        break;
      }
      const keep = item.value.subarray(
        0,
        Math.max(0, INSPECTION_FIELD_BYTES - size),
      );
      chunks.push(keep);
      size += keep.length;
      if (size >= INSPECTION_FIELD_BYTES) {
        break;
      }
    }
  })();
  try {
    await Promise.race([
      reading.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(150, budgetMs));
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (!complete) {
      void reader.cancel().catch(() => {});
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return {
    ...responseInspection(text, !complete),
    errorText: `${complete ? '' : '[partial HTTP error body; incomplete]\n'}${text || '[HTTP error body unavailable]'}`,
  };
}
