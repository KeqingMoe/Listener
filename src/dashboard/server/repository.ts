import { DatabaseSync } from 'node:sqlite';
import {
  performanceMetrics,
  intervalDuration,
  requestDuration,
  type MetricTool,
} from '../contracts/metrics.ts';
import { lstatSync } from 'node:fs';
import { normalizeModelRequestDiagnostics } from '../../observability/model-diagnostics.ts';
import { normalizeWakeDiagnostics } from '../../observability/wake-diagnostics.ts';
import {
  requestOutcome,
  requestReason,
  toolOutcome,
  toolReason,
} from '../contracts/outcomes.ts';

const parse = (value: unknown): unknown => {
  try {
    return typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
};
const toolProjection = ['status', 'error', 'reason', 'reason_code']
  .map(
    (key) =>
      `CASE WHEN json_valid(result) THEN json_extract(result,'$.${key}') ELSE NULL END AS ${key}`,
  )
  .join(',');
import type {
  Availability,
  Range,
  UsageSummary,
  WakeItem,
  RequestItem,
  ToolItem,
  ToolSummary,
} from '../contracts/contracts.ts';

export interface GroupSource {
  groupId: string;
  sessionPath: string;
  worldPath?: string;
}

export interface Sources {
  /** Static sources for embedded callers/tests; production uses getGroups exclusively. */
  groups?: GroupSource[];
  /** Returns current, policy-filtered and membership-proven sources. Failure closes access. */
  getGroups?: () => GroupSource[];
  telemetryPath: string;
  inspectionSecrets?: readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQLite行的列由本模块建表语句保证
type Row = Record<string, any>;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const allowed = (v: unknown, values: string[]) =>
  typeof v === 'string' && values.includes(v) ? v : null;
const toolName = (v: unknown) =>
  typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : 'unknown';
const percentile = (a: number[], p: number) =>
  a.length
    ? a.sort((a, b) => a - b)[Math.max(0, Math.ceil(a.length * p) - 1)]!
    : null;

export class ResourceLimit extends Error {}

export function summarize(rows: Row[], tools?: MetricTool[]): UsageSummary {
  const performance = performanceMetrics(rows, { tools });
  const sum = (key: string) => {
    const values = rows
      .map((r) => num(r[key]))
      .filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const known = rows.filter((r) => num(r.input_tokens) !== null),
    cached = known.filter(
      (r) =>
        num(r.cached_input_tokens) !== null &&
        r.cached_input_tokens <= r.input_tokens,
    );
  const denominator = cached.reduce((n, r) => n + r.input_tokens, 0),
    numerator = cached.reduce((n, r) => n + r.cached_input_tokens, 0),
    durations = rows
      .map((r) => requestDuration(r))
      .filter((n): n is number => n !== null);
  return {
    requests: rows.length,
    successes: rows.filter(
      (r) => requestOutcome(r.status, r.error_code) === 'success',
    ).length,
    errors: rows.filter(
      (r) => requestOutcome(r.status, r.error_code) === 'failed',
    ).length,
    timeouts: rows.filter(
      (r) => requestOutcome(r.status, r.error_code) === 'timeout',
    ).length,
    cancelled: rows.filter(
      (r) => requestOutcome(r.status, r.error_code) === 'cancelled',
    ).length,
    running: rows.filter((r) => r.status === 'running').length,
    interrupted: rows.filter((r) => r.status === 'interrupted').length,
    unknown: rows.filter(
      (r) =>
        r.status !== 'running' &&
        r.status !== 'interrupted' &&
        requestOutcome(r.status, r.error_code) === 'unknown',
    ).length,
    inputTokens: sum('input_tokens'),
    outputTokens: sum('output_tokens'),
    cachedInputTokens: cached.length ? numerator : null,
    uncachedInputTokens: cached.length ? denominator - numerator : null,
    cacheHitRate: denominator ? numerator / denominator : null,
    durationP50Ms: percentile([...durations], 0.5),
    durationP95Ms: percentile([...durations], 0.95),
    tps: performance.tps,
    ttftMs: performance.ttftMs,
    performance,
  };
}

export class Repository {
  private handles = new Map<
    string,
    { db: DatabaseSync; path: string; groupId?: string; identity: string }
  >();

  private currentGroups: GroupSource[] = [];
  constructor(readonly sources: Sources) {
    this.refreshGroups();
  }

  get groups(): readonly GroupSource[] {
    return this.currentGroups;
  }

  /** Called once at the start of each synchronous API read, never mid-query. */
  refreshGroups(): void {
    let groups: GroupSource[];
    try {
      const input = this.sources.getGroups
        ? this.sources.getGroups()
        : (this.sources.groups ?? []);
      const ids = new Set<string>();
      if (!Array.isArray(input)) {
        throw new Error('invalid_sources');
      }
      groups = input.map((source) => {
        if (
          !source ||
          typeof source.groupId !== 'string' ||
          !/^[1-9]\d{0,31}$/.test(source.groupId) ||
          typeof source.sessionPath !== 'string' ||
          !source.sessionPath ||
          source.sessionPath.includes('\0') ||
          ids.has(source.groupId)
        ) {
          throw new Error('invalid_sources');
        }
        ids.add(source.groupId);
        return {
          groupId: source.groupId,
          sessionPath: source.sessionPath,
          ...(typeof source.worldPath === 'string' &&
          source.worldPath &&
          !source.worldPath.includes('\0')
            ? { worldPath: source.worldPath }
            : {}),
        };
      });
    } catch {
      groups = [];
    }
    this.currentGroups = groups;
    for (const [key, handle] of this.handles) {
      if (
        handle.groupId &&
        !groups.some(
          (group) =>
            group.groupId === handle.groupId &&
            group.sessionPath === handle.path,
        )
      ) {
        this.drop(key);
      }
    }
  }

  private drop(key: string): void {
    const handle = this.handles.get(key);
    this.handles.delete(key);
    try {
      handle?.db.close();
    } catch {
      /* Already unavailable; never retain it. */
    }
  }

  private open(path: string, groupId?: string): DatabaseSync | null {
    const key = JSON.stringify([groupId ?? null, path]);
    let db: DatabaseSync | undefined;
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile()) {
        this.drop(key);
        return null;
      }
      const identity = `${stat.dev}:${stat.ino}`;
      let cached = this.handles.get(key);
      if (cached && cached.identity !== identity) {
        this.drop(key);
        cached = undefined;
      }
      db = cached?.db ?? new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
      if (groupId) {
        if (
          db
            .prepare(
              'SELECT group_id FROM model_session_meta WHERE singleton=1',
            )
            .get()?.group_id !== groupId
        ) {
          db.close();
          this.handles.delete(key);
          return null;
        }
        db.prepare('SELECT seq FROM model_session_journal LIMIT 0').all();
        db.prepare('SELECT ordinal FROM model_tool_ledger LIMIT 0').all();
        db.prepare(
          'SELECT request_id FROM model_session_messages LIMIT 0',
        ).all();
      } else {
        db.prepare('SELECT request_id FROM model_requests LIMIT 0').all();
      }
      this.handles.set(key, { db, path, groupId, identity });
      return db;
    } catch {
      try {
        db?.close();
      } catch {}
      this.handles.delete(key);
      return null;
    }
  }

  private readonly syncConnections = new WeakMap<DatabaseSync, number>();
  private syncConnectionSequence = 0;
  /** Cheap resource invalidation, NOT a SQL row change feed. Versions are meaningful
   * only on the same live SQLite connection; file/WAL identities cover replacement.
   * World DBs are read only by health, which resource sync always recomputes. */
  resourceVersion(): string | null {
    const files = (path: string) =>
      [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].map((file) => {
        try {
          const s = lstatSync(file, { bigint: true });
          return [
            String(s.dev),
            String(s.ino),
            String(s.size),
            String(s.mtimeNs),
            String(s.ctimeNs),
            s.isFile(),
          ];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
          }
          throw error;
        }
      });
    try {
      const sources = [
        { path: this.sources.telemetryPath, db: this.telemetry() },
        ...this.groups.map((g) => ({
          path: g.sessionPath,
          db: this.session(g.groupId),
        })),
      ];
      return JSON.stringify(
        sources.map(({ path, db }) => {
          const identities = files(path);
          if (!db) {
            // A truly absent file is observable on every poll; schema/permission/
            // transient failures of an existing file cannot be proven unchanged.
            if (identities[0] !== null) {
              throw new Error('unavailable_source');
            }
            return [path, 'missing', identities];
          }
          if (!this.syncConnections.has(db)) {
            this.syncConnections.set(db, ++this.syncConnectionSequence);
          }
          return [
            path,
            this.syncConnections.get(db),
            db.prepare('PRAGMA data_version').get()?.data_version,
            identities,
          ];
        }),
      );
    } catch {
      return null;
    }
  }

  telemetry(): DatabaseSync | null {
    return this.open(this.sources.telemetryPath);
  }

  session(groupId: string) {
    const source = this.groups.find((g) => g.groupId === groupId);
    return source ? this.open(source.sessionPath, groupId) : null;
  }

  availability(): Availability {
    return {
      telemetry: this.open(this.sources.telemetryPath) !== null,
      sessions: this.groups.map((g) => ({
        groupId: g.groupId,
        available: this.session(g.groupId) !== null,
      })),
    };
  }

  close() {
    for (const key of this.handles.keys()) {
      this.drop(key);
    }
  }

  private bounded(rows: Row[], cap = 10000) {
    if (rows.length > cap) {
      throw new ResourceLimit('Narrow query range');
    }
    return rows;
  }

  private requestColumns(db: DatabaseSync): string {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(model_requests)')
        .all()
        .map((r) => r.name),
    );
    return ['error_code', 'http_status', 'diagnostics']
      .map((key) => (columns.has(key) ? key : `NULL AS ${key}`))
      .join(',');
  }

  requests(range: Range, groupId?: string): Row[] {
    const db = this.open(this.sources.telemetryPath);
    if (!db) {
      return [];
    }
    const ids = this.groups
      .filter((g) => !groupId || g.groupId === groupId)
      .map((g) => g.groupId);
    const result: Row[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      result.push(
        ...(db
          .prepare(
            `SELECT request_id,group_id,started_at,ended_at,duration_ms,status,transport,input_tokens,output_tokens,cached_input_tokens,${this.requestColumns(db)} FROM model_requests WHERE started_at>=? AND started_at<=? AND group_id IN (${batch.map(() => '?').join(',')}) ORDER BY started_at,request_id LIMIT 10001`,
          )
          .all(range.since, range.until, ...batch) as Row[]),
      );
      this.bounded(result);
    }
    return result.sort(
      (a, b) =>
        a.started_at - b.started_at ||
        String(a.request_id).localeCompare(String(b.request_id)),
    );
  }

  private finish(db: DatabaseSync, wakeId: string) {
    const row = db
      .prepare(
        "SELECT created_at,payload,CASE WHEN json_valid(payload) THEN json_extract(payload,'$.reason') ELSE NULL END AS reason FROM model_session_journal WHERE wake_id=? AND kind='wake_finish' ORDER BY seq DESC LIMIT 1",
      )
      .get(wakeId);
    const safe = normalizeWakeDiagnostics(parse(row?.payload));
    const diagnostics: Record<string, number> = {};
    for (const [key, value] of Object.entries(safe)) {
      if (typeof value === 'number') {
        diagnostics[key] = value;
      }
    }
    return {
      reasonCode:
        typeof safe.reason_code === 'string' ? safe.reason_code : null,
      diagnostics,
      finishedAt: num(row?.created_at),
      outcome: allowed(row?.reason, [
        'finish',
        'finished',
        'session_reset',
        'silent',
        'replied',
        'prose_suppressed',
        'cancelled',
        'model_failed',
        'delivery_unknown',
        'tool_budget_exhausted',
        'wake_timeout',
        'budget_exhausted',
        'completed',
        'response_state_expired',
        'error',
        'failed',
        'operation_submitted',
        'message_submitted',
        'reaction_submitted',
        'reaction_unknown',
        'reacted',
        'reaction_failed',
        'partial_reply_cancelled',
        'partial_reaction_cancelled',
        'partial_management_cancelled',
      ]),
    };
  }

  private wake(
    db: DatabaseSync,
    groupId: string,
    row: Row,
    requests: Row[],
  ): WakeItem {
    const finish = this.finish(db, row.wake_id),
      ids = new Set(
        db
          .prepare(
            'SELECT request_id FROM model_session_messages WHERE wake_id=? AND request_id IS NOT NULL LIMIT 10001',
          )
          .all(row.wake_id)
          .map((r) => r.request_id),
      );
    if (ids.size > 10000) {
      throw new ResourceLimit();
    }
    const usage = summarize(
      requests.filter((r) => r.group_id === groupId && ids.has(r.request_id)),
    );
    return {
      wakeId: row.wake_id,
      groupId,
      sessionId: row.session_id,
      startedAt: row.created_at,
      ...finish,
      durationMs: intervalDuration(row.created_at, finish.finishedAt),
      tps: usage.tps,
      ttftMs: usage.ttftMs,
      cacheHitRate: usage.cacheHitRate,
      performance: performanceMetrics(
        requests.filter((r) => r.group_id === groupId && ids.has(r.request_id)),
        {
          attribution: 'wake',
          startedAt: row.created_at,
          finishedAt: finish.finishedAt,
          tools: this.toolTimings(undefined, groupId, row.wake_id),
          sourceComplete: false,
        },
      ),
      trigger: null,
      modelRequests: usage.requests,
      toolCalls: Number(
        db
          .prepare('SELECT COUNT(*) n FROM model_tool_ledger WHERE wake_id=?')
          .get(row.wake_id)!.n,
      ),
      inputTokens: usage.inputTokens,
      uncachedInputTokens: usage.uncachedInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
    };
  }

  private wakeRequests(
    db: DatabaseSync,
    groupId: string,
    wakeId: string,
  ): Row[] {
    const telemetry = this.open(this.sources.telemetryPath);
    if (!telemetry) {
      return [];
    }
    const ids = this.bounded(
      db
        .prepare(
          'SELECT DISTINCT request_id FROM model_session_messages WHERE wake_id=? AND request_id IS NOT NULL LIMIT 10001',
        )
        .all(wakeId) as Row[],
    ).map((r) => r.request_id);
    const result: Row[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      result.push(
        ...(telemetry
          .prepare(
            `SELECT request_id,group_id,started_at,ended_at,duration_ms,status,transport,input_tokens,output_tokens,cached_input_tokens,${this.requestColumns(telemetry)} FROM model_requests WHERE group_id=? AND request_id IN (${batch.map(() => '?').join(',')}) ORDER BY started_at,request_id`,
          )
          .all(groupId, ...batch) as Row[]),
      );
    }
    return result.sort((a, b) => a.started_at - b.started_at);
  }

  wakes(
    range: Range,
    groupId: string | undefined,
    offset: number,
    limit: number,
    filters: { q?: string; outcome?: string } = {},
  ) {
    const result: Array<{ groupId: string; row: Row; db: DatabaseSync }> = [];
    for (const g of this.groups.filter(
      (g) => !groupId || g.groupId === groupId,
    )) {
      const db = this.session(g.groupId);
      if (!db) {
        continue;
      }
      const rows = db
        .prepare(
          "SELECT seq,wake_id,session_id,created_at FROM model_session_journal WHERE kind='wake_begin' AND created_at>=? AND created_at<=? ORDER BY created_at DESC,wake_id ASC LIMIT ?",
        )
        .all(
          range.since,
          range.until,
          filters.q || filters.outcome ? 10001 : offset + limit + 1,
        ) as Row[];
      for (const row of rows) {
        result.push({ groupId: g.groupId, row, db });
      }
      if (result.length > 10000) {
        throw new ResourceLimit();
      }
    }
    result.sort(
      (a, b) =>
        b.row.created_at - a.row.created_at ||
        a.groupId.localeCompare(b.groupId) ||
        a.row.wake_id.localeCompare(b.row.wake_id),
    );
    const filtered = result.filter(({ groupId, row, db }) => {
      if (!filters.q && !filters.outcome) {
        return true;
      }
      const finish = this.finish(db, row.wake_id);
      const search = filters.q?.toLowerCase();
      if (
        search &&
        ![
          groupId,
          row.wake_id,
          row.session_id,
          finish.outcome,
          finish.reasonCode,
        ].some((v) => typeof v === 'string' && v.toLowerCase().includes(search))
      ) {
        return false;
      }
      if (!filters.outcome) {
        return true;
      }
      if (filters.outcome === 'running') {
        return finish.finishedAt === null;
      }
      if (filters.outcome === 'failed') {
        return [
          'model_failed',
          'failed',
          'error',
          'delivery_unknown',
          'reaction_failed',
        ].includes(finish.outcome ?? '');
      }
      if (filters.outcome === 'cancelled') {
        return [
          'cancelled',
          'partial_reply_cancelled',
          'partial_reaction_cancelled',
          'partial_management_cancelled',
        ].includes(finish.outcome ?? '');
      }
      return finish.outcome === filters.outcome;
    });
    return {
      items: filtered
        .slice(offset, offset + limit)
        .map(({ groupId, row, db }) =>
          this.wake(
            db,
            groupId,
            row,
            this.wakeRequests(db, groupId, row.wake_id),
          ),
        ),
      hasMore: filtered.length > offset + limit,
    };
  }

  detail(groupId: string, wakeId: string) {
    const db = this.session(groupId);
    if (!db) {
      return null;
    }
    const row = db
      .prepare(
        "SELECT wake_id,session_id,created_at FROM model_session_journal WHERE kind='wake_begin' AND wake_id=? LIMIT 1",
      )
      .get(wakeId) as Row | undefined;
    if (!row) {
      return null;
    }
    const raw = this.wakeRequests(db, groupId, wakeId),
      wake = this.wake(db, groupId, row, raw),
      ids = new Set(
        db
          .prepare(
            'SELECT request_id FROM model_session_messages WHERE wake_id=? AND request_id IS NOT NULL LIMIT 10001',
          )
          .all(wakeId)
          .map((r) => r.request_id),
      );
    const allRequests = raw.filter((r) => ids.has(r.request_id));
    const requests: RequestItem[] = allRequests.slice(0, 500).map((r) => ({
      ...(() => {
        const u = summarize([r]);
        return {
          tps: u.tps,
          ttftMs: u.ttftMs,
          cacheHitRate: u.cacheHitRate,
          performance: performanceMetrics([r], { attribution: 'request' }),
        };
      })(),
      requestId: r.request_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms,
      outcome: requestOutcome(r.status, r.error_code),
      errorCode: requestReason(r.error_code),
      httpStatus:
        Number.isInteger(r.http_status) &&
        r.http_status >= 100 &&
        r.http_status <= 599
          ? r.http_status
          : null,
      diagnostics:
        normalizeModelRequestDiagnostics(parse(r.diagnostics)) ?? null,
      status: (allowed(r.status, ['success', 'error']) ??
        'unknown') as RequestItem['status'],
      transport: (allowed(r.transport, ['chat', 'responses']) ??
        'unknown') as RequestItem['transport'],
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cachedInputTokens: num(r.cached_input_tokens),
    }));
    const rows = db
      .prepare(
        `SELECT ordinal,name,state,proposed_at,started_at,finished_at,${toolProjection} FROM model_tool_ledger WHERE wake_id=? ORDER BY ordinal LIMIT 501`,
      )
      .all(wakeId) as Row[];
    const tools: ToolItem[] = rows.slice(0, 500).map((r) => ({
      ordinal: r.ordinal,
      outcome: toolOutcome(r),
      reasonCode: toolReason(r),
      name: toolName(r.name),
      state:
        allowed(r.state, [
          'pending',
          'started',
          'finished',
          'unknown',
          'skipped',
        ]) ?? 'unknown',
      proposedAt: r.proposed_at,
      startedAt: num(r.started_at),
      finishedAt: num(r.finished_at),
      durationMs:
        num(r.started_at) !== null && num(r.finished_at) !== null
          ? intervalDuration(r.started_at, r.finished_at)
          : null,
      status: allowed(r.status, [
        'ok',
        'error',
        'unknown',
        'skipped',
        'staged',
        'executed',
        'pending',
        'confirmation_required',
        'duplicate',
        'success',
        'cancelled',
        'submitted',
      ]),
    }));
    return {
      wake,
      requests,
      tools,
      truncated: rows.length > 500 || allRequests.length > 500,
      availability: this.availability(),
    };
  }

  /** Bounded scalar metadata only: never arguments/results or historical bodies. */
  toolTimings(range?: Range, groupId?: string, wakeId?: string): Row[] {
    if (!range && !wakeId) {
      throw new ResourceLimit('Tool timing scope required');
    }
    const result: Row[] = [];
    for (const g of this.groups.filter(
      (g) => !groupId || g.groupId === groupId,
    )) {
      const db = this.session(g.groupId);
      if (!db) {
        continue;
      }
      result.push(
        ...db
          .prepare(
            `SELECT ordinal,wake_id,proposed_at,started_at,finished_at FROM model_tool_ledger WHERE ${wakeId ? 'wake_id=?' : 'proposed_at BETWEEN ? AND ?'} LIMIT 10001`,
          )
          .all(...(wakeId ? [wakeId] : [range!.since, range!.until]))
          .map((r) => ({ ...r, group_id: g.groupId })),
      );
      this.bounded(result);
    }
    return result;
  }

  tools(range: Range, groupId?: string): ToolSummary[] {
    const byName = new Map<string, Row[]>();
    let count = 0;
    for (const g of this.groups.filter(
      (g) => !groupId || g.groupId === groupId,
    )) {
      const db = this.session(g.groupId);
      if (!db) {
        continue;
      }
      const rows = this.bounded(
        db
          .prepare(
            `SELECT name,state,started_at,finished_at,${toolProjection} FROM model_tool_ledger WHERE proposed_at>=? AND proposed_at<=? LIMIT 10001`,
          )
          .all(range.since, range.until) as Row[],
      );
      count += rows.length;
      if (count > 10000) {
        throw new ResourceLimit();
      }
      for (const row of rows) {
        const name = toolName(row.name);
        const a = byName.get(name) ?? [];
        a.push(row);
        byName.set(name, a);
      }
    }
    return [...byName]
      .map(([name, rows]) => {
        const durations = rows
          .map((r) => intervalDuration(r.started_at, r.finished_at))
          .filter((duration): duration is number => duration !== null);
        const n = (state: string) =>
          rows.filter((r) => r.state === state).length;
        return {
          name,
          calls: rows.length,
          finished: n('finished'),
          pending: n('pending'),
          started: n('started'),
          unknown: rows.filter((r) => toolOutcome(r) === 'unknown').length,
          skipped: rows.filter((r) => toolOutcome(r) === 'skipped').length,
          errors: rows.filter((r) => toolOutcome(r) === 'failed').length,
          handled: rows.filter((r) => toolOutcome(r) === 'handled').length,
          rejected: rows.filter((r) => toolOutcome(r) === 'rejected').length,
          deferred: rows.filter((r) => toolOutcome(r) === 'deferred').length,
          cancelled: rows.filter((r) => toolOutcome(r) === 'cancelled').length,
          durationP50Ms: percentile([...durations], 0.5),
          durationP95Ms: percentile([...durations], 0.95),
        };
      })
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  }
}
