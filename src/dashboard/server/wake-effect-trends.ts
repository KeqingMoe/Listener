import type { Range } from '../contracts/contracts.ts';
import type {
  WakeEffectTrendPoint,
  WakeEffectTrendsResponse,
} from '../contracts/wake-effect-trends.ts';
import { VISIBLE_EFFECT_KINDS } from '../../contracts/visible-effect.ts';
import { type Repository, ResourceLimit } from './repository.ts';
import { requestTrendBucketMs } from './request-trends.ts';

export const MAX_WAKE_EFFECT_TREND_POINTS = 10000;

const time = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Metadata-only snapshot; wake updates do not belong to the model-request change log. */
export function wakeEffectTrends(
  repository: Repository,
  range: Range,
  groupId?: string,
): WakeEffectTrendsResponse {
  const availability = repository.availability();
  const db = repository.telemetry();
  availability.telemetry = db !== null;
  const response: WakeEffectTrendsResponse = {
    range,
    availability,
    bucketMs: requestTrendBucketMs(range),
    collectionStartedAt: null,
    points: [],
  };
  if (!db) {
    return response;
  }
  db.exec('BEGIN');
  try {
    const tables = new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('wake_effect_waits','wake_effect_wait_meta')",
        )
        .all()
        .map((row) => row.name),
    );
    if (!tables.size) {
      return response;
    }
    if (tables.size !== 2) {
      throw new Error('Incomplete wake effect telemetry schema');
    }
    const meta = db
      .prepare(
        'SELECT schema_version,collection_started_at FROM wake_effect_wait_meta WHERE singleton=1',
      )
      .get();
    if (meta?.schema_version !== 1 || !time(meta.collection_started_at)) {
      throw new Error('Unsupported wake effect telemetry schema');
    }
    response.collectionStartedAt = meta.collection_started_at;
    const read =
      db.prepare(`SELECT turn_id,trigger_received_at,wake_finished_at,wake_outcome,
      first_effect_at,first_effect_wait_ms,first_effect_kind
      FROM wake_effect_waits WHERE group_id=? AND trigger_received_at BETWEEN ? AND ? LIMIT ?`);
    for (const group of repository.groups) {
      if (groupId !== undefined && group.groupId !== groupId) {
        continue;
      }
      const rows = read.all(
        group.groupId,
        range.since,
        range.until,
        MAX_WAKE_EFFECT_TREND_POINTS - response.points.length + 1,
      );
      if (response.points.length + rows.length > MAX_WAKE_EFFECT_TREND_POINTS) {
        throw new ResourceLimit('Narrow wake metric query range');
      }
      for (const row of rows) {
        if (typeof row.turn_id !== 'string' || !time(row.trigger_received_at)) {
          throw new Error('Invalid wake effect observation');
        }
        const confirmed =
          time(row.first_effect_at) &&
          duration(row.first_effect_wait_ms) &&
          VISIBLE_EFFECT_KINDS.some((kind) => kind === row.first_effect_kind);
        const point: WakeEffectTrendPoint = {
          key: JSON.stringify([group.groupId, row.turn_id]),
          receivedAt: row.trigger_received_at,
          firstEffectWaitMs: confirmed
            ? (row.first_effect_wait_ms as number)
            : null,
          outcome: confirmed
            ? 'confirmed'
            : row.wake_outcome === 'interrupted'
              ? 'interrupted'
              : row.wake_finished_at !== null || row.wake_outcome !== null
                ? 'unconfirmed'
                : 'pending',
        };
        response.points.push(point);
      }
    }
    response.points.sort(
      (a, b) => a.receivedAt - b.receivedAt || a.key.localeCompare(b.key),
    );
    return response;
  } finally {
    db.exec('ROLLBACK');
  }
}
