import { lookup as dnsLookup } from 'node:dns/promises';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Transform } from 'node:stream';
import { isPublicAddress } from '../images/download.ts';

export const FETCH_LIMITS = {
  urlChars: 2048,
  responseBytes: 2 * 1024 * 1024,
  redirects: 5,
  timeoutMs: 20_000,
} as const;
const USER_AGENT = 'Mozilla/5.0 (compatible; qqbot-listener/1.0; +web_fetch)';

export type FetchKind = 'html' | 'text' | 'json' | 'xml';

export type FetchOutcome =
  | {
      kind: 'body';
      url: string;
      httpStatus: number;
      contentType: FetchKind;
      text: string;
    }
  | { kind: 'redirect'; url: string; httpStatus: number; location: string };

/** 稳定的机器可读错误码；不暴露远端错误文本。 */
export class FetchError extends Error {
  constructor(
    readonly code:
      | 'invalid_url'
      | 'blocked_url'
      | 'fetch_timeout'
      | 'fetch_too_large'
      | 'unsupported_content_type'
      | 'unsupported_charset'
      | 'fetch_failed'
      | 'cancelled',
  ) {
    super(code);
  }
}

export interface FetchDependencies {
  lookup?: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
  request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  timeoutMs?: number;
}

export function validateFetchUrl(value: unknown): URL {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > FETCH_LIMITS.urlChars ||
    /[\u0000-\u001f\u007f\s]/.test(value.trim())
  ) {
    throw new FetchError('invalid_url');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new FetchError('invalid_url');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    throw new FetchError('invalid_url');
  }
  url.hash = '';
  return url;
}

function classify(header: string | undefined): {
  kind: FetchKind;
  charset?: string;
} {
  const [type = '', ...params] = (header ?? '')
    .split(';')
    .map((part) => part.trim());
  const mime = type.toLowerCase();
  const charset = params
    .map((p) => /^charset\s*=\s*"?([^";]+)"?$/i.exec(p)?.[1])
    .find(Boolean)
    ?.toLowerCase();
  const kind: FetchKind | undefined =
    mime === 'text/html' || mime === 'application/xhtml+xml'
      ? 'html'
      : mime === 'application/json' || mime.endsWith('+json')
        ? 'json'
        : mime === 'application/xml' ||
            mime === 'text/xml' ||
            mime.endsWith('+xml')
          ? 'xml'
          : mime.startsWith('text/')
            ? 'text'
            : undefined;
  if (!kind) {
    throw new FetchError('unsupported_content_type');
  }
  return { kind, ...(charset ? { charset } : {}) };
}

/** 响应头的charset优先；HTML也可能在靠前的meta标签里声明编码（GBK页面常见）。 */
function decode(bytes: Buffer, kind: FetchKind, declared?: string): string {
  let label = declared;
  if (!label && kind === 'html') {
    label = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i
      .exec(bytes.subarray(0, 4096).toString('latin1'))?.[1]
      ?.toLowerCase();
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label ?? 'utf-8');
  } catch {
    throw new FetchError('unsupported_charset');
  }
  const text = decoder.decode(bytes);
  if (
    /[\u0000-\u0008\u000e-\u001f]/.test(
      text.slice(0, 4096).replace(/[\t\n\r\f\v]/g, ''),
    )
  ) {
    throw new FetchError('unsupported_content_type');
  }
  return text;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FetchError('cancelled');
  }
}

async function resolvePublic(
  url: URL,
  lookup: NonNullable<FetchDependencies['lookup']>,
  signal: AbortSignal,
): Promise<{ hostname: string; address: string; family: number }> {
  const hostname = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const literal = isIP(hostname);
  const addresses = literal
    ? [{ address: hostname, family: literal }]
    : await Promise.race([
        lookup(hostname, { all: true, verbatim: true }).catch(() => {
          throw new FetchError('fetch_failed');
        }),
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new FetchError('cancelled')),
            { once: true },
          ),
        ),
      ]);
  // 解析出的每个地址都必须是公网地址：混有内网地址的应答视为DNS rebinding迹象。
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.some(
      (entry) =>
        !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family,
    )
  ) {
    throw new FetchError('blocked_url');
  }
  const { address, family } = addresses[0]!;
  return { hostname, address, family };
}

function decompressor(encoding: string | undefined): Transform | undefined {
  const value = (encoding ?? 'identity').trim().toLowerCase();
  if (value === 'identity' || value === '') {
    return undefined;
  }
  if (value === 'gzip' || value === 'x-gzip') {
    return createGunzip();
  }
  if (value === 'deflate') {
    return createInflate();
  }
  if (value === 'br') {
    return createBrotliDecompress();
  }
  throw new FetchError('unsupported_content_type');
}

/** 发起一次固定解析地址的请求，不读取重定向响应体。 */
function requestOnce(
  url: URL,
  target: { hostname: string; address: string; family: number },
  request: NonNullable<FetchDependencies['request']> | undefined,
  signal: AbortSignal,
): Promise<{
  status: number;
  location?: string;
  contentType?: string;
  bytes?: Buffer;
}> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined,
      response: IncomingMessage | undefined,
      inflater: Transform | undefined,
      settled = false;
    const finish = (error?: Error, value?: Parameters<typeof resolve>[0]) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
        inflater?.destroy();
        response?.destroy();
        req?.destroy();
      } else {
        resolve(value!);
      }
    };
    const onAbort = () => finish(new FetchError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    const https = url.protocol === 'https:';
    const send = request ?? (https ? httpsRequest : httpRequest);
    try {
      req = send(
        {
          protocol: url.protocol,
          hostname: target.hostname,
          port: url.port || (https ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          agent: false,
          family: target.family,
          ...(https
            ? {
                servername: isIP(target.hostname) ? undefined : target.hostname,
                rejectUnauthorized: true,
              }
            : {}),
          // 只连接通过公网地址检查的那个地址。
          lookup: (_host, options, callback) => {
            if ((options as { all?: boolean }).all) {
              (
                callback as (
                  e: null,
                  a: Array<{ address: string; family: number }>,
                ) => void
              )(null, [{ address: target.address, family: target.family }]);
            } else {
              (callback as (e: null, a: string, f: number) => void)(
                null,
                target.address,
                target.family,
              );
            }
          },
          headers: {
            'User-Agent': USER_AGENT,
            Accept:
              'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        } as RequestOptions,
        (incoming) => {
          response = incoming;
          const status = incoming.statusCode ?? 0;
          incoming.on('error', () => finish(new FetchError('fetch_failed')));
          if (
            status >= 300 &&
            status < 400 &&
            typeof incoming.headers.location === 'string'
          ) {
            incoming.resume();
            finish(undefined, { status, location: incoming.headers.location });
            return;
          }
          const contentType = incoming.headers['content-type'];
          try {
            classify(contentType);
            inflater = decompressor(incoming.headers['content-encoding']);
          } catch (error) {
            finish(error as Error);
            return;
          }
          const declared = incoming.headers['content-length'];
          if (
            !inflater &&
            declared !== undefined &&
            /^\d+$/.test(declared) &&
            Number(declared) > FETCH_LIMITS.responseBytes
          ) {
            finish(new FetchError('fetch_too_large'));
            return;
          }
          const chunks: Buffer[] = [];
          let raw = 0,
            total = 0;
          const collect = (chunk: Buffer) => {
            if (settled) {
              return;
            }
            total += chunk.length;
            // 解压后的字节同样受限，防止压缩炸弹无限膨胀。
            if (total > FETCH_LIMITS.responseBytes) {
              finish(new FetchError('fetch_too_large'));
              return;
            }
            chunks.push(chunk);
          };
          const done = () =>
            finish(undefined, {
              status,
              contentType,
              bytes: Buffer.concat(chunks, total),
            });
          if (inflater) {
            incoming.on('data', (chunk: Buffer) => {
              raw += chunk.length;
              if (raw > FETCH_LIMITS.responseBytes) {
                finish(new FetchError('fetch_too_large'));
              }
            });
            incoming.pipe(inflater);
            inflater.on('data', collect);
            inflater.on('error', () => finish(new FetchError('fetch_failed')));
            inflater.on('end', done);
          } else {
            incoming.on('data', collect);
            incoming.on('end', done);
          }
          incoming.on('aborted', () => finish(new FetchError('fetch_failed')));
        },
      );
      req.on('error', () => finish(new FetchError('fetch_failed')));
      if (signal.aborted) {
        onAbort();
      }
      if (settled) {
        req.destroy();
      } else {
        req.end();
      }
    } catch {
      finish(new FetchError('fetch_failed'));
    }
  });
}

/**
 * 匿名、有上限地抓取公网HTTP(S)资源。同源重定向会跟随并重新检查地址；
 * 跨源重定向交还给调用方处理。
 */
export function createWebFetcher(
  dependencies: FetchDependencies = {},
): (value: unknown, signal?: AbortSignal) => Promise<FetchOutcome> {
  const lookup =
    dependencies.lookup ?? ((host, options) => dnsLookup(host, options));
  return async (value, callerSignal) => {
    let url = validateFetchUrl(value);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    callerSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, dependencies.timeoutMs ?? FETCH_LIMITS.timeoutMs);
    try {
      for (let hop = 0; ; hop++) {
        checkAbort(controller.signal);
        const target = await resolvePublic(url, lookup, controller.signal);
        checkAbort(controller.signal);
        const result = await requestOnce(
          url,
          target,
          dependencies.request,
          controller.signal,
        );
        if (result.location !== undefined) {
          let next: URL;
          try {
            next = validateFetchUrl(new URL(result.location, url).href);
          } catch {
            throw new FetchError('fetch_failed');
          }
          const sameOrigin =
            next.host === url.host &&
            (next.protocol === url.protocol ||
              (url.protocol === 'http:' && next.protocol === 'https:'));
          if (!sameOrigin || hop >= FETCH_LIMITS.redirects) {
            return {
              kind: 'redirect',
              url: url.href,
              httpStatus: result.status,
              location: next.href,
            };
          }
          url = next;
          continue;
        }
        const { kind, charset } = classify(result.contentType);
        return {
          kind: 'body',
          url: url.href,
          httpStatus: result.status,
          contentType: kind,
          text: decode(result.bytes!, kind, charset),
        };
      }
    } catch (error) {
      if (timedOut) {
        throw new FetchError('fetch_timeout');
      }
      if (callerSignal?.aborted) {
        throw new FetchError('cancelled');
      }
      throw error instanceof FetchError
        ? error
        : new FetchError('fetch_failed');
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', cancel);
    }
  };
}
