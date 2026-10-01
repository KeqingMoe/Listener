import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Repository, ResourceLimit } from './repository.ts';
import { ReviewRepository } from './review-repository.ts';
import { isJavascriptJobId } from '../contracts/javascript-jobs.ts';
import { javascriptJobLinks } from './javascript-job-links.ts';
import { EVENT_CATEGORIES } from '../contracts/review.ts';
import {
  InvalidQuery,
  MAX_OFFSET,
  cursorAfter,
  cursorOffset,
  detailId,
  encodeCursor,
  onlyKeys,
  pageLimit,
  queryBinding,
  queryInteger,
  searchText,
  timeRange,
  type Query,
} from './query.ts';

/** 注册review相关路由。每个请求开始前都会重新刷新群授权。 */
export function registerReviewRoutes(
  app: FastifyInstance,
  base: Repository,
  now: () => number,
): void {
  type Req = FastifyRequest<{
    Params: { id?: string };
    Querystring: Record<string, unknown>;
  }>;
  const review = new ReviewRepository(base);
  const run =
    (fn: (req: Req, reply: FastifyReply) => unknown) =>
    async (req: Req, reply: FastifyReply) => {
      base.refreshGroups();
      return fn(req, reply);
    };
  const group = (q: Query, required = false) => {
    if (q.groupId === undefined && !required) {
      return undefined;
    }
    if (
      typeof q.groupId !== 'string' ||
      !base.groups.some((g) => g.groupId === q.groupId)
    ) {
      throw new InvalidQuery();
    }
    return q.groupId;
  };
  app.get(
    '/api/javascript-jobs/:id/links',
    run((req) => {
      const q = req.query as Query;
      onlyKeys(q, ['groupId', 'since', 'until', 'anchorOrdinal']);
      const anchorOrdinal =
        q.anchorOrdinal === undefined
          ? undefined
          : queryInteger(q.anchorOrdinal, 0);
      if (anchorOrdinal !== undefined && anchorOrdinal < 1) {
        throw new InvalidQuery();
      }
      const groupId = group(q, true)!;
      if (!isJavascriptJobId(req.params.id)) {
        throw new InvalidQuery();
      }
      return javascriptJobLinks(
        base,
        groupId,
        req.params.id!,
        timeRange(q, now()),
        anchorOrdinal,
      );
    }),
  );
  const detail = (req: Req) => {
    const q = req.query as Query;
    onlyKeys(q, ['groupId']);
    return { groupId: group(q, true)!, id: detailId(req.params.id, 256) };
  };
  app.get(
    '/api/requests',
    run((req) => {
      const q = req.query as Query;
      onlyKeys(q, [
        'since',
        'until',
        'groupId',
        'limit',
        'cursor',
        'outcome',
        'modelName',
        'q',
      ]);
      if (
        q.modelName !== undefined &&
        (typeof q.modelName !== 'string' ||
          !q.modelName ||
          q.modelName.length > 128)
      ) {
        throw new InvalidQuery();
      }
      const range = timeRange(q, now()),
        limit = pageLimit(q, 30),
        groupId = group(q),
        text = searchText(q);
      if (
        q.outcome !== undefined &&
        (typeof q.outcome !== 'string' ||
          ![
            'success',
            'failed',
            'timeout',
            'cancelled',
            'unknown',
            'running',
            'interrupted',
          ].includes(q.outcome))
      ) {
        throw new InvalidQuery();
      }
      const binding = queryBinding({
        range,
        groupId,
        groups: base.groups.map((g) => g.groupId).sort(),
        outcome: q.outcome,
        modelName: q.modelName,
        q: text,
      });
      const offset = cursorOffset(q.cursor, binding);
      const search = text?.toLowerCase() ?? '';
      const all = review
        .requests(range, groupId)
        .filter(
          (r) =>
            (q.outcome === undefined || r.outcome === q.outcome) &&
            (q.modelName === undefined || r.modelName === q.modelName) &&
            (!search ||
              [
                r.requestId,
                r.modelName,
                r.model,
                r.errorCode,
                r.responseId,
                r.previousResponseId,
                r.providerRequestId,
                r.turnId,
                r.wakeId,
              ].some((v) => v?.toLowerCase().includes(search))),
        );
      const hasMore = all.length > offset + limit;
      if (hasMore && offset + limit > MAX_OFFSET) {
        throw new ResourceLimit();
      }
      return {
        range,
        items: all.slice(offset, offset + limit),
        nextCursor: hasMore
          ? encodeCursor(binding, { offset: offset + limit })
          : null,
      };
    }),
  );
  app.get(
    '/api/requests/:id',
    run((req, reply) => {
      const { groupId, id } = detail(req);
      return (
        review.detail(groupId, id) ??
        reply
          .code(404)
          .send({ error: 'not_found', message: 'Request not found' })
      );
    }),
  );
  app.get(
    '/api/wakes/:id/review',
    run((req, reply) => {
      const { groupId, id } = detail(req);
      if (!base.session(groupId)) {
        return reply
          .code(503)
          .send({ error: 'unavailable', message: 'Session data unavailable' });
      }
      return (
        review.wake(groupId, id) ??
        reply.code(404).send({ error: 'not_found', message: 'Wake not found' })
      );
    }),
  );
  app.get(
    '/api/events',
    run((req) => {
      const q = req.query as Query;
      onlyKeys(q, [
        'since',
        'until',
        'groupId',
        'limit',
        'cursor',
        'category',
        'q',
      ]);
      const range = timeRange(q, now()),
        limit = pageLimit(q, 50),
        groupId = group(q),
        text = searchText(q);
      if (
        q.category !== undefined &&
        (typeof q.category !== 'string' ||
          !(EVENT_CATEGORIES as readonly string[]).includes(q.category))
      ) {
        throw new InvalidQuery();
      }
      const binding = queryBinding({
        range,
        groupId,
        groups: base.groups.map((g) => g.groupId).sort(),
        category: q.category,
        q: text,
      });
      // 事件按sequence倒序做keyset分页，cursor记录上一页最后一条的sequence。
      const after = cursorAfter(q.cursor, binding) ?? Number.MAX_SAFE_INTEGER;
      const { items, hasMore } = review.events(
        range,
        groupId,
        q.category as string | undefined,
        text,
        after,
        limit,
      );
      return {
        range,
        items,
        nextCursor: hasMore
          ? encodeCursor(binding, { after: items.at(-1)!.sequence })
          : null,
      };
    }),
  );
  app.get(
    '/api/health',
    run((req) => {
      if (Object.keys(req.query).length) {
        throw new InvalidQuery();
      }
      return review.health(now());
    }),
  );
}
