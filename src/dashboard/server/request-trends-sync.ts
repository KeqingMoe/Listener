import { randomBytes } from 'node:crypto';
import { requestChangeLogSchemaIntact } from '../../observability/request-change-log.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Range } from '../contracts/contracts.ts';
import type {
  RequestTrendSyncPoint,
  RequestTrendsSyncResponse,
} from '../contracts/request-trends.ts';
import { type ReviewRepository } from './review-repository.ts';
import { ResourceLimit } from './repository.ts';
import {
  buildRequestTrends,
  buildRequestTrendBuckets,
  MAX_REQUEST_TREND_POINTS,
} from './request-trends.ts';

type Meta = { epoch: string; revision: number; floor_revision: number };

type Snapshot = {
  binding: string;
  db: DatabaseSync | null;
  epoch: string | null;
  revision: number;
  range: Range;
  expires: number;
  points: Map<string, RequestTrendSyncPoint>;
};

export const TREND_SYNC_TTL_MS = 5 * 60_000;
export const TREND_SYNC_MAX_SNAPSHOTS = 32;
export const TREND_SYNC_MAX_CACHED_POINTS = 100_000;
const key = (group: string, request: string) =>
  JSON.stringify([group, request]);

/** Per-app bounded cache. Tokens are opaque capabilities additionally bound to the authenticated scope. */
export class RequestTrendsSync {
  private readonly cache = new Map<string, Snapshot>();
  constructor(
    private readonly review: ReviewRepository,
    private readonly now = Date.now,
  ) {}

  private meta(db: DatabaseSync | null): Meta | null {
    if (!db) {
      return null;
    }
    try {
      if (!requestChangeLogSchemaIntact(db)) {
        return null;
      }
      const row = db
        .prepare(
          'SELECT schema_version,epoch,revision,floor_revision FROM request_change_meta WHERE singleton=1',
        )
        .get();
      if (
        !row ||
        row.schema_version !== 1 ||
        typeof row.epoch !== 'string' ||
        !Number.isSafeInteger(row.revision) ||
        !Number.isSafeInteger(row.floor_revision) ||
        Number(row.floor_revision) < 0 ||
        Number(row.revision) < Number(row.floor_revision)
      ) {
        return null;
      }
      return {
        epoch: row.epoch,
        revision: Number(row.revision),
        floor_revision: Number(row.floor_revision),
      };
    } catch {
      return null;
    }
  }

  sync(
    range: Range,
    groupId: string | undefined,
    cursor: unknown,
    sessionFingerprint: string,
  ): RequestTrendsSyncResponse {
    const base = this.review.base,
      time = this.now();
    for (const [token, state] of this.cache) {
      if (state.expires <= time) {
        this.cache.delete(token);
      }
    }
    const binding = JSON.stringify([
      sessionFingerprint,
      groupId ?? null,
      base.sources.telemetryPath,
      [...base.groups].sort((a, b) => a.groupId.localeCompare(b.groupId)),
    ]);
    const availability = base.availability();
    const db = base.telemetry();
    availability.telemetry = db !== null;
    // No awaits between BEGIN and COMMIT: metadata, journal and both projections share one SQLite snapshot.
    db?.exec('BEGIN');
    try {
      const meta = this.meta(db);
      const previous =
        typeof cursor === 'string' && /^[a-f0-9]{64}$/.test(cursor)
          ? this.cache.get(cursor)
          : undefined;
      const delta = !!(
        previous &&
        meta &&
        previous.binding === binding &&
        previous.db === db &&
        previous.epoch === meta.epoch &&
        previous.revision >= meta.floor_revision &&
        previous.revision <= meta.revision &&
        range.until - range.since ===
          previous.range.until - previous.range.since &&
        range.since >= previous.range.since
      );
      const points = delta
        ? new Map(previous!.points)
        : new Map<string, RequestTrendSyncPoint>();
      const read = (r: Range, group?: string, ids?: string[]) => {
        const rows = this.review.requests(
          r,
          group,
          undefined,
          ids ? { requestIds: ids } : undefined,
          { skipAssociations: true, telemetry: db },
        );
        const projected = buildRequestTrends(r, availability, rows).points;
        return rows.map((row, index) => ({
          ...projected[index]!,
          key: key(row.groupId, row.requestId),
        }));
      };
      if (!delta) {
        for (const point of read(range, groupId)) {
          points.set(point.key, point);
        }
      } else {
        const dirty = new Map<string, Set<string>>();
        const authorized = new Set(
          base.groups
            .filter((g) => !groupId || g.groupId === groupId)
            .map((g) => g.groupId),
        );
        const add = (g: unknown, r: unknown) => {
          if (
            typeof g !== 'string' ||
            typeof r !== 'string' ||
            !authorized.has(g)
          ) {
            return;
          }
          const ids = dirty.get(g) ?? new Set<string>();
          ids.add(r);
          dirty.set(g, ids);
        };
        // Journal is writer-bounded (50k); stream it and retain only deduplicated authorized keys.
        let expectedRevision = previous!.revision + 1;
        let contiguous = true;
        for (const row of db!
          .prepare(
            'SELECT revision,old_group_id,old_request_id,new_group_id,new_request_id FROM request_changes WHERE revision>? AND revision<=? ORDER BY revision',
          )
          .iterate(previous!.revision, meta!.revision)) {
          if (row.revision !== expectedRevision++) {
            contiguous = false;
          }
          add(row.old_group_id, row.old_request_id);
          add(row.new_group_id, row.new_request_id);
        }
        if (!contiguous || expectedRevision !== meta!.revision + 1) {
          db!.exec('ROLLBACK');
          this.cache.clear();
          return this.sync(range, groupId, undefined, sessionFingerprint);
        }
        if (range.until > previous!.range.until) {
          const entering = {
            since: Math.max(range.since, previous!.range.until + 1),
            until: range.until,
          };
          for (const point of read(entering, groupId)) {
            const [g, r] = JSON.parse(point.key) as [string, string];
            add(g, r);
          }
        }
        for (const [k, p] of points) {
          if (p.startedAt < range.since || p.startedAt > range.until) {
            points.delete(k);
          }
        }
        for (const [g, ids] of dirty) {
          const list = [...ids];
          for (let offset = 0; offset < list.length; offset += 400) {
            const chunk = list.slice(offset, offset + 400);
            for (const id of chunk) {
              points.delete(key(g, id));
            }
            // Re-read BOTH tables in the full current range: deleting one projection may expose the other.
            for (const point of read(range, g, chunk)) {
              points.set(point.key, point);
            }
          }
        }
      }
      if (points.size > MAX_REQUEST_TREND_POINTS) {
        throw new ResourceLimit();
      }
      const sorted = [...points.values()].sort(
        (a, b) => b.startedAt - a.startedAt || a.key.localeCompare(b.key),
      );
      const { buckets, bucketMs } = buildRequestTrendBuckets(
        range,
        availability,
        sorted,
      );
      const upserts = delta
        ? sorted.filter(
            (p) =>
              JSON.stringify(previous!.points.get(p.key)) !== JSON.stringify(p),
          )
        : sorted;
      const removals = delta
        ? [...previous!.points.keys()].filter((k) => !points.has(k)).sort()
        : [];
      db?.exec('COMMIT');
      const token = randomBytes(32).toString('hex');
      this.cache.set(token, {
        binding,
        db,
        epoch: meta?.epoch ?? null,
        revision: meta?.revision ?? 0,
        range: { ...range },
        expires: time + TREND_SYNC_TTL_MS,
        points,
      });
      let total = [...this.cache.values()].reduce(
        (sum, s) => sum + s.points.size,
        0,
      );
      while (
        this.cache.size > TREND_SYNC_MAX_SNAPSHOTS ||
        total > TREND_SYNC_MAX_CACHED_POINTS
      ) {
        const oldest = this.cache.keys().next().value!;
        total -= this.cache.get(oldest)!.points.size;
        this.cache.delete(oldest);
      }
      return {
        range,
        availability,
        bucketMs,
        buckets,
        mode: delta ? 'delta' : 'snapshot',
        cursor: token,
        upserts,
        removals,
      };
    } catch (error) {
      if (db?.isTransaction) {
        db.exec('ROLLBACK');
      }
      throw error;
    }
  }
}
