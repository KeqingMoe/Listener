import type { WebSearchProviderConfig } from '../../config/app.ts';

export interface WebSource {
  url: string;
  title: string;
  snippet?: string;
  published_at?: string;
}

export interface WebSearchResult {
  sources: WebSource[];
  truncated: boolean;
  failed_queries: number;
}

/** One backend call per query; the tool merges, dedupes and bounds the results. */
export type WebSearchBackend = (
  query: string,
  signal: AbortSignal,
) => Promise<WebSource[]>;

export type HttpFetch = (
  url: string,
  init: {
    signal: AbortSignal;
    headers: Record<string, string>;
    redirect: 'error';
  },
) => Promise<Response>;

export const SEARCH_LIMITS = {
  queries: 4,
  queryBytes: 512,
  sources: 10,
  titleChars: 200,
  snippetChars: 500,
  responseBytes: 2 * 1024 * 1024,
  timeoutMs: 15_000,
} as const;

const clip = (value: string, max: number): string => {
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
};

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read a bounded body; the provider is local but its output is still untrusted. */
async function boundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
  ) {
    throw new Error('search_response_too_large');
  }
  if (!response.body) {
    throw new Error('search_failed');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('search_response_too_large');
    }
    chunks.push(value);
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, total),
    ),
  );
}

/** SearXNG JSON API. The configured instance is operator-trusted infrastructure,
 * so it is not subject to the public-address policy that guards web_fetch. */
export function createSearxngBackend(
  config: Extract<WebSearchProviderConfig, { type: 'searxng' }>,
  fetcher: HttpFetch = fetch,
): WebSearchBackend {
  return async (query, signal) => {
    const url = new URL(config.url + '/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const response = await fetcher(url.href, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new Error('search_failed');
    }
    const body = await boundedJson(response, SEARCH_LIMITS.responseBytes);
    const results =
      body &&
      typeof body === 'object' &&
      Array.isArray((body as { results?: unknown }).results)
        ? (body as { results: unknown[] }).results
        : undefined;
    if (!results) {
      throw new Error('search_failed');
    }
    const sources: WebSource[] = [];
    for (const item of results) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const r = item as Record<string, unknown>,
        link = publicUrl(r.url);
      if (!link) {
        continue;
      }
      const title =
        typeof r.title === 'string'
          ? clip(r.title, SEARCH_LIMITS.titleChars)
          : '';
      const snippet =
        typeof r.content === 'string'
          ? clip(r.content, SEARCH_LIMITS.snippetChars)
          : '';
      const published =
        typeof r.publishedDate === 'string' &&
        !Number.isNaN(Date.parse(r.publishedDate))
          ? new Date(r.publishedDate).toISOString()
          : undefined;
      sources.push({
        url: link,
        title: title || link,
        ...(snippet ? { snippet } : {}),
        ...(published ? { published_at: published } : {}),
      });
    }
    return sources;
  };
}

export function createSearchBackend(
  config: WebSearchProviderConfig,
  fetcher?: HttpFetch,
): WebSearchBackend {
  switch (config.type) {
    case 'searxng':
      return createSearxngBackend(config, fetcher);
  }
}

/** Queries run concurrently; results interleave by rank and dedupe by URL. */
export async function runSearch(
  backend: WebSearchBackend,
  queries: string[],
  signal?: AbortSignal,
  timeoutMs: number = SEARCH_LIMITS.timeoutMs,
): Promise<WebSearchResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const settled = await Promise.allSettled(
      queries.map((query) => backend(query, controller.signal)),
    );
    if (signal?.aborted) {
      throw new Error('cancelled');
    }
    const lists = settled.map((result) =>
      result.status === 'fulfilled' ? result.value : undefined,
    );
    const failed = lists.filter((list) => !list).length;
    if (failed === queries.length) {
      throw new Error(
        controller.signal.aborted ? 'search_timeout' : 'search_unavailable',
      );
    }
    const seen = new Set<string>(),
      sources: WebSource[] = [];
    let total = 0;
    const depth = Math.max(0, ...lists.map((list) => list?.length ?? 0));
    for (let rank = 0; rank < depth; rank++) {
      for (const list of lists) {
        const source = list?.[rank];
        if (!source || seen.has(source.url)) {
          continue;
        }
        seen.add(source.url);
        total++;
        if (sources.length < SEARCH_LIMITS.sources) {
          sources.push(source);
        }
      }
    }
    return {
      sources,
      truncated: total > sources.length,
      failed_queries: failed,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
