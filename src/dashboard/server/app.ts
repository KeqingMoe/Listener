import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  Repository,
  ResourceLimit,
  summarize,
  type Sources,
} from './repository.ts';
import type { Range } from '../contracts/contracts.ts';
import { registerReviewRoutes } from './review-routes.ts';
import { ReviewRepository } from './review-repository.ts';
import { buildRequestTrends } from './request-trends.ts';
import { RequestTrendsSync } from './request-trends-sync.ts';
import { registerResourceSync } from './resource-sync.ts';
import { isIP } from 'node:net';
import { type AuthStore, sessionToken } from './auth.ts';
import { authWrites, registerAuthRoutes } from './auth-routes.ts';

export interface AppOptions extends Sources {
  /** Required at runtime: absent stores fail closed. Caller owns store lifetime. */
  auth?: AuthStore;
  webRoot?: string;
  now?: () => number;
  /** Bind hostname used for Host validation; defaults to loopback only. */
  listenHost?: string;
}

const DAY = 86400000;
class InvalidQuery extends Error {}

function integer(v: unknown, defaultValue: number) {
  if (v === undefined) {
    return defaultValue;
  }
  if (typeof v !== 'string' || !/^\d{1,16}$/.test(v)) {
    throw new InvalidQuery();
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidQuery();
  }
  return n;
}

function allowedHost(host: string, listenHost = '127.0.0.1') {
  try {
    const u = new URL(`http://${host}`);
    return (
      !u.username &&
      !u.password &&
      u.pathname === '/' &&
      (['localhost', '127.0.0.1', '[::1]', listenHost].includes(u.hostname) ||
        u.hostname === `[${listenHost}]` ||
        (['0.0.0.0', '::'].includes(listenHost) &&
          isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0)) &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

export function buildApp(options: AppOptions) {
  const auth = options.auth;
  if (!auth) {
    throw new Error('Dashboard authentication store required');
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 1024,
    requestTimeout: 10000,
  });
  const repository = new Repository(options);
  const reviewRepository = new ReviewRepository(repository);
  const now = options.now ?? Date.now;
  app.addHook('onClose', async () => repository.close());
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
    const host = req.headers.host;
    const authWrite = req.method === 'POST' && authWrites.has(req.url);
    if (
      !host ||
      !allowedHost(host, options.listenHost) ||
      (!['GET', 'HEAD'].includes(req.method) && !authWrite)
    ) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Read-only access from configured host required',
      });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Cross-site access denied' });
    }
    if (authWrite && !req.headers.origin) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Same-origin access required' });
    }
    if (req.headers.origin) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Invalid origin' });
      }
      if (
        origin.origin !== `${auth.secureCookie ? 'https' : 'http'}://${host}` ||
        req.headers.origin !== origin.origin
      ) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Same-origin access required' });
      }
    }
    const path = req.url.split('?')[0]!;
    const publicAuth =
      ((req.method === 'GET' || req.method === 'HEAD') &&
        path === '/api/auth/session') ||
      (authWrite &&
        (req.url === '/api/auth/login' || req.url === '/api/auth/logout'));
    // Gate all API-shaped paths before routing, including encoded/case variants.
    let decoded: string;
    try {
      decoded = decodeURIComponent(path).toLowerCase();
    } catch {
      decoded = '/api/';
    }
    if ((decoded === '/api' || decoded.startsWith('/api/')) && !publicAuth) {
      if (!auth.configured) {
        return reply.code(503).send({
          error: auth.configurationError,
          message: 'Set DASHBOARD_PASSWORD in .env and restart the dashboard',
        });
      }
      if (!auth.authenticated(sessionToken(req.headers.cookie))) {
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'Sign in required' });
      }
    }
  });
  registerAuthRoutes(app, auth);
  app.setErrorHandler((error, _req, reply) => {
    if (
      error instanceof InvalidQuery ||
      (error instanceof Error && 'validation' in error && error.validation)
    ) {
      return reply
        .code(400)
        .send({ error: 'invalid_query', message: 'Invalid query parameters' });
    }
    if (
      error instanceof Error &&
      'statusCode' in error &&
      [403, 404].includes(Number(error.statusCode))
    ) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    }
    if (error instanceof ResourceLimit) {
      return reply.code(503).send({
        error: 'unavailable',
        message: 'Query exceeds resource limit; select a narrower time range',
      });
    }
    return reply
      .code(503)
      .send({ error: 'unavailable', message: 'Data temporarily unavailable' });
  });
  const parse = (value: unknown, extra: string[] = []) => {
    repository.refreshGroups();
    const q = value as Record<string, unknown>;
    if (
      Object.keys(q).some(
        (k) => !['since', 'until', 'groupId', ...extra].includes(k),
      )
    ) {
      throw new InvalidQuery();
    }
    const until = integer(q.until, now()),
      since = integer(q.since, Math.max(0, until - DAY));
    if (since > until || until - since > 31 * DAY) {
      throw new InvalidQuery();
    }
    let groupId: string | undefined;
    if (q.groupId !== undefined) {
      if (
        typeof q.groupId !== 'string' ||
        !repository.groups.some((g) => g.groupId === q.groupId)
      ) {
        throw new InvalidQuery();
      }
      groupId = q.groupId;
    }
    return { range: { since, until } as Range, groupId, q };
  };
  app.get('/api/meta', async (req) => {
    repository.refreshGroups();
    if (Object.keys(req.query as object).length) {
      throw new InvalidQuery();
    }
    return {
      groups: repository.groups.map((g) => ({ groupId: g.groupId })),
      readOnly: true,
      maxRangeDays: 31,
      now: now(),
      availability: repository.availability(),
    };
  });
  const trendsSync = new RequestTrendsSync(reviewRepository, now);
  app.get('/api/request-trends/sync', async (req) => {
    const { range, groupId, q } = parse(req.query, ['cursor']);
    const fingerprint = createHash('sha256')
      .update(sessionToken(req.headers.cookie) ?? '')
      .digest('hex');
    return trendsSync.sync(range, groupId, q.cursor, fingerprint);
  });
  app.get('/api/request-trends', async (req) => {
    const { range, groupId } = parse(req.query);
    const requests = reviewRepository.requests(range, groupId);
    return buildRequestTrends(range, repository.availability(), requests);
  });
  app.get('/api/overview', async (req) => {
    const { range, groupId } = parse(req.query),
      rows = reviewRepository.requests(range, groupId).map((r) => ({
        interval_known: r.performance.coverage.modelIntervalRequests === 1,
        request_id: r.requestId,
        group_id: r.groupId,
        started_at: r.startedAt,
        ended_at: r.endedAt,
        duration_ms: r.durationMs,
        status: r.status,
        error_code: r.errorCode,
        input_tokens: r.totalInputTokens,
        cached_input_tokens: r.cachedInputTokens,
        output_tokens: r.outputTokens,
        ttft_ms: r.ttftMs,
        decode_duration_ms: r.decodeDurationMs,
      })),
      toolRows = repository.toolTimings(range, groupId),
      bucket = range.until - range.since <= 2 * DAY ? 3600000 : DAY;
    const series = [];
    for (
      let start = Math.floor(range.since / bucket) * bucket;
      start <= range.until;
      start += bucket
    ) {
      series.push({
        bucketStart: start,
        ...summarize(
          rows.filter(
            (r) => r.started_at >= start && r.started_at < start + bucket,
          ),
          toolRows.filter(
            (t) => t.proposed_at >= start && t.proposed_at < start + bucket,
          ),
        ),
      });
    }
    return {
      range,
      availability: repository.availability(),
      summary: summarize(rows, toolRows),
      series,
      groups: repository.groups
        .filter((g) => !groupId || g.groupId === groupId)
        .map((g) => ({
          groupId: g.groupId,
          ...summarize(
            rows.filter((r) => r.group_id === g.groupId),
            toolRows.filter((t) => t.group_id === g.groupId),
          ),
        })),
    };
  });
  app.get('/api/wakes', async (req) => {
    const { range, groupId, q } = parse(req.query, [
        'limit',
        'cursor',
        'q',
        'outcome',
      ]),
      limit = integer(q.limit, 30);
    if (limit < 1 || limit > 100) {
      throw new InvalidQuery();
    }
    if (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 200)) {
      throw new InvalidQuery();
    }
    if (
      q.outcome !== undefined &&
      (typeof q.outcome !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(q.outcome))
    ) {
      throw new InvalidQuery();
    }
    const binding = createHash('sha256')
      .update(
        JSON.stringify({
          range,
          groupId,
          q: q.q,
          outcome: q.outcome,
          groups: repository.groups
            .filter((g) => !groupId || g.groupId === groupId)
            .map((g) => g.groupId)
            .sort(),
        }),
      )
      .digest('hex');
    let offset = 0;
    if (q.cursor !== undefined) {
      if (
        typeof q.cursor !== 'string' ||
        q.cursor.length > 300 ||
        !/^[A-Za-z0-9_-]+$/.test(q.cursor)
      ) {
        throw new InvalidQuery();
      }
      try {
        const cursor = JSON.parse(
          Buffer.from(q.cursor, 'base64url').toString(),
        );
        if (
          cursor.binding !== binding ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          cursor.offset > 10000
        ) {
          throw new Error();
        }
        offset = cursor.offset;
      } catch {
        throw new InvalidQuery();
      }
    }
    const { items, hasMore } = repository.wakes(range, groupId, offset, limit, {
      q: q.q as string | undefined,
      outcome: q.outcome as string | undefined,
    });
    if (hasMore && offset + limit > 10000) {
      throw new ResourceLimit();
    }
    return {
      range,
      availability: repository.availability(),
      items: items.map((item) => reviewRepository.wakeSummary(item)),
      nextCursor: hasMore
        ? Buffer.from(
            JSON.stringify({ binding, offset: offset + limit }),
          ).toString('base64url')
        : null,
    };
  });
  app.get('/api/wakes/:id', async (req, reply) => {
    repository.refreshGroups();
    const q = req.query as Record<string, unknown>,
      id = (req.params as { id: string }).id;
    if (
      Object.keys(q).some((k) => k !== 'groupId') ||
      typeof q.groupId !== 'string' ||
      !repository.groups.some((g) => g.groupId === q.groupId) ||
      !id ||
      id.length > 128 ||
      /[\x00-\x1f]/.test(id)
    ) {
      throw new InvalidQuery();
    }
    if (!repository.session(q.groupId)) {
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'Session data unavailable' });
    }
    const detail = repository.detail(q.groupId, id);
    if (detail) {
      detail.wake = reviewRepository.wakeSummary(detail.wake);
    }
    return (
      detail ??
      reply.code(404).send({ error: 'not_found', message: 'Wake not found' })
    );
  });
  app.get('/api/tools', async (req) => {
    const { range, groupId } = parse(req.query);
    return {
      range,
      availability: repository.availability(),
      items: repository.tools(range, groupId),
    };
  });
  registerReviewRoutes(app, repository, now);
  registerResourceSync(app, repository, now);
  if (options.webRoot && existsSync(options.webRoot)) {
    app.register(fastifyStatic, {
      root: options.webRoot,
      index: ['index.html'],
      dotfiles: 'deny',
      cacheControl: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.includes('.')) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }
  return app;
}
