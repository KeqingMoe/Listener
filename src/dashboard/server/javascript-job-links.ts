import type { DatabaseSync } from 'node:sqlite';
import type { Range } from '../contracts/contracts.ts';
import type {
  JavascriptJobLink,
  JavascriptJobLinkLimitation,
  JavascriptJobLinksResponse,
} from '../contracts/javascript-jobs.ts';
import { sanitizeInspectionValue } from '../../observability/request-inspection.ts';
import type { Repository } from './repository.ts';

type Row = Record<string, unknown>;

const object = (v: unknown): Row =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const timestamp = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const statuses = [
  'ok',
  'error',
  'pending',
  'unknown',
  'executed',
  'success',
  'submitted',
  'confirmation_required',
  'staged',
  'duplicate',
  'cancelled',
  'skipped',
];
const tasks = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'timeout',
];
const states = ['pending', 'started', 'finished', 'unknown', 'skipped'];

// Static identifiers only; every value in data queries is parameter-bound.
function schema(db: DatabaseSync): boolean {
  const tables: Record<string, string[]> = {
    model_session_journal: [
      'seq',
      'session_id',
      'wake_id',
      'kind',
      'payload',
      'created_at',
    ],
    model_tool_ledger: [
      'ordinal',
      'session_id',
      'wake_id',
      'assistant_seq',
      'call_id',
      'name',
      'arguments',
      'state',
      'result',
    ],
    model_session_messages: [
      'seq',
      'session_id',
      'wake_id',
      'request_id',
      'message',
    ],
    model_external_events: [
      'event_id',
      'self_id',
      'payload',
      'received_at',
      'projected_at',
    ],
  };
  for (const [table, columns] of Object.entries(tables)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    if (
      info.some((r) =>
        ['rowid', '_rowid_', 'oid'].includes(String(r.name).toLowerCase()),
      ) ||
      !columns.every((c) => info.some((r) => r.name === c)) ||
      info.filter((r) => r.pk !== 0).length !== 1 ||
      !info.some(
        (r) =>
          r.name === columns[0] &&
          r.pk === 1 &&
          r.type === (table === 'model_external_events' ? 'TEXT' : 'INTEGER'),
      )
    ) {
      return false;
    }
  }
  const indexes = db.prepare('PRAGMA index_list(model_session_journal)').all();
  if (
    !indexes.some(
      (r) => r.name === 'model_session_journal_kind_time' && r.partial === 0,
    )
  ) {
    return false;
  }
  const keys = db
    .prepare('PRAGMA index_xinfo(model_session_journal_kind_time)')
    .all()
    .filter((r) => r.key === 1);
  return (
    keys.length === 3 &&
    keys.every(
      (r, index) =>
        r.name === ['kind', 'created_at', 'wake_id'][index] &&
        r.coll === 'BINARY' &&
        r.desc === 0,
    )
  );
}

/** Bounded read-only observations; never reconstructs a current job state. */
export function javascriptJobLinks(
  base: Repository,
  groupId: string,
  jobId: string,
  range: Range,
  anchorOrdinal?: number,
): JavascriptJobLinksResponse {
  const response: JavascriptJobLinksResponse = {
    groupId,
    jobId,
    range,
    items: [],
    truncated: false,
    unavailable: false,
  };
  const limitations: JavascriptJobLinkLimitation[] = [];
  response.limitations = limitations;
  const limit = (code: JavascriptJobLinkLimitation) => {
    if (!limitations.includes(code)) {
      limitations.push(code);
    }
    response.truncated = true;
  };
  const db = base.session(groupId);
  let bytes = 0;
  const safe = (v: unknown): string | null => {
    if (v === null || v === undefined) {
      return null;
    }
    if (
      typeof v !== 'string' ||
      !v ||
      v.length > 256 ||
      /[\x00-\x1f]/.test(v)
    ) {
      limit('identifier_redacted');
      return null;
    }
    const clean = sanitizeInspectionValue(v, base.sources.inspectionSecrets);
    if (clean.truncated || clean.value !== v) {
      limit('identifier_redacted');
      return null;
    }
    return v;
  };
  // A redacted identifier cannot remain a reliable navigation target.
  if (!safe(groupId) || !safe(jobId)) {
    return {
      ...response,
      groupId: safe(groupId) ?? '',
      jobId: safe(jobId) ?? '',
      truncated: true,
    };
  }
  if (!db) {
    return { ...response, unavailable: true };
  }
  const allowed = (v: unknown, list: string[]) =>
    typeof v === 'string' && list.includes(v) ? safe(v) : null;
  const parse = (v: unknown): Row => {
    if (typeof v !== 'string') {
      if (v !== null) {
        limit('candidate_record_unreadable');
      }
      return {};
    }
    const size = Buffer.byteLength(v);
    if (size > 1024 * 1024 || bytes + size > 8 * 1024 * 1024) {
      if (bytes + size > 8 * 1024 * 1024) {
        bytes = 8 * 1024 * 1024;
        limit('byte_limit');
      }
      if (size > 1024 * 1024) {
        limit('record_size_limit');
      }
      return {};
    }
    bytes += size;
    try {
      const parsed: unknown = JSON.parse(v);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        limit('candidate_record_unreadable');
      }
      return object(parsed);
    } catch {
      limit('candidate_record_unreadable');
      return {};
    }
  };
  const capped = (column: string, limit = 1024 * 1024) =>
    `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE NULL END AS ${column}, length(CAST(${column} AS BLOB)) AS ${column}_bytes`;
  const parsed = (row: Row, column: string, maxSize = 1024 * 1024) => {
    if (
      typeof row[`${column}_bytes`] === 'number' &&
      (row[`${column}_bytes`] as number) > maxSize
    ) {
      limit('record_size_limit');
      return {};
    }
    if (column !== 'result' && typeof row[column] !== 'string') {
      limit('candidate_record_unreadable');
    }
    return parse(row[column]);
  };
  const empty = (
    key: string,
    kind: JavascriptJobLink['kind'],
    time: number | null,
  ): JavascriptJobLink => ({
    key,
    kind,
    time,
    wakeId: null,
    requestId: null,
    callId: null,
    ordinal: null,
    state: null,
    status: null,
    taskStatus: null,
  });
  const match = (v: Row) => (v.job_id ?? v.jobId) === jobId;
  const items = new Map<string, JavascriptJobLink>();
  try {
    if (!schema(db)) {
      return { ...response, unavailable: true };
    }
    const wakeKeys = db
      .prepare('PRAGMA index_xinfo(model_session_journal_wake)')
      .all()
      .filter((r) => r.key === 1);
    const wakeAvailable =
      db
        .prepare('PRAGMA index_list(model_session_journal)')
        .all()
        .some(
          (r) => r.name === 'model_session_journal_wake' && r.partial === 0,
        ) &&
      wakeKeys.length === 2 &&
      wakeKeys.every(
        (r, i) =>
          r.name === ['wake_id', 'seq'][i] &&
          r.coll === 'BINARY' &&
          r.desc === 0,
      );
    const wakeLookup = wakeAvailable
      ? db.prepare(
          'SELECT session_id,kind FROM model_session_journal INDEXED BY model_session_journal_wake WHERE wake_id COLLATE BINARY=? ORDER BY seq COLLATE BINARY LIMIT 501',
        )
      : null;
    const wakeCache = new Map<string, string | null>();
    const wake = (r: Row): string | null => {
      const key = JSON.stringify([r.session_id, r.wake_id]);
      if (wakeCache.has(key)) {
        return wakeCache.get(key)!;
      }
      if (!wakeLookup) {
        limit('wake_lookup_unavailable');
        return null;
      }
      let count = 0;
      for (const proof of wakeLookup.iterate(r.wake_id as string)) {
        if (++count > 500) {
          limit('wake_lookup_limit');
          break;
        }
        if (proof.session_id === r.session_id && proof.kind === 'wake_begin') {
          const id = safe(r.wake_id);
          wakeCache.set(key, id);
          return id;
        }
      }
      wakeCache.set(key, null);
      return null;
    };
    const inbox = db.prepare(
      `SELECT rowid AS event_rowid,event_id,self_id,received_at,projected_at,${capped('payload')} FROM model_external_events WHERE event_id=?`,
    );
    const events = new Map<string, Row | null>();
    const event = (id: unknown): Row | null => {
      if (
        typeof id !== 'string' ||
        id.length > 1024 ||
        !id.endsWith(`:${jobId}`) ||
        !/^[1-9]\d{0,31}$/.test(id.slice(0, -(jobId.length + 1)))
      ) {
        return null;
      }
      if (events.has(id)) {
        return events.get(id)!;
      }
      events.set(id, null);
      if (bytes >= 8 * 1024 * 1024) {
        limit('byte_limit');
        return null;
      }
      const r = inbox.get(id);
      if (!r) {
        limit('linked_record_missing');
        return null;
      }
      if (
        typeof r.self_id !== 'string' ||
        !r.self_id ||
        `${r.self_id}:${jobId}` !== id
      ) {
        limit('candidate_record_unreadable');
        return null;
      }
      const payload = parsed(r, 'payload');
      if (payload.job_id !== jobId) {
        limit('candidate_record_unreadable');
        return null;
      }
      const linked = { ...r, taskStatus: allowed(payload.status, tasks) };
      events.set(id, linked);
      return linked;
    };
    const received = (r: Row) => {
      const time = timestamp(r.received_at);
      if (time === null) {
        limit('candidate_record_unreadable');
        return;
      }
      if (time < range.since || time > range.until) {
        return;
      }
      // Event ids contain account ids: use an opaque per-response position instead.
      const key = `notification_received:${String(r.event_id)}`;
      if (!items.has(key)) {
        items.set(key, {
          ...empty(
            `received:${String(r.event_rowid)}`,
            'notification_received',
            time,
          ),
          taskStatus: r.taskStatus as string | null,
        });
      }
    };
    const ledgerColumns = db
      .prepare('PRAGMA table_info(model_tool_ledger)')
      .all();
    const times = ['finished_at', 'started_at', 'proposed_at']
      .map((name) =>
        ledgerColumns.some((r) => r.name === name) ? name : `NULL AS ${name}`,
      )
      .join(',');
    const ledger = db.prepare(
      `SELECT ordinal,session_id,wake_id,assistant_seq,call_id,name,state,${times} FROM model_tool_ledger WHERE ordinal=?`,
    );
    const ledgerBody = db.prepare(
      `SELECT ${capped('arguments')},${capped('result')} FROM model_tool_ledger WHERE ordinal=?`,
    );
    const executionBody = db.prepare(
      `SELECT ${capped('result')} FROM model_tool_ledger WHERE ordinal=?`,
    );
    const message = db.prepare(
      `SELECT session_id,wake_id,request_id,${capped('message')} FROM model_session_messages WHERE seq=?`,
    );
    const seen = new Set<number>();
    const linkTool = (ordinal: unknown, row?: Row) => {
      if (!positive(ordinal)) {
        limit('candidate_record_unreadable');
        return;
      }
      if (seen.has(ordinal)) {
        return;
      }
      const r = ledger.get(ordinal);
      if (
        !r ||
        (row && (r.session_id !== row.session_id || r.wake_id !== row.wake_id))
      ) {
        limit(row ? 'candidate_record_unreadable' : 'anchor_unmatched');
        return;
      }
      seen.add(ordinal);
      if (
        ![
          'execute_javascript',
          'query_javascript_jobs',
          'cancel_javascript_job',
        ].includes(String(r.name))
      ) {
        return;
      }
      const body = (
        r.name === 'execute_javascript' ? executionBody : ledgerBody
      ).get(ordinal);
      if (!body) {
        limit('candidate_record_unreadable');
        return;
      }
      const result = parsed(body, 'result');
      const args =
        r.name === 'execute_javascript' ? {} : parsed(body, 'arguments');
      const observed = object(result.job);
      const list =
        r.name === 'query_javascript_jobs' && Array.isArray(result.jobs)
          ? result.jobs.find((raw: unknown) => match(object(raw)))
          : undefined;
      const linked =
        r.name === 'execute_javascript'
          ? match(result)
          : args.job_id === jobId ||
            match(observed) ||
            (r.name === 'query_javascript_jobs' && !!list);
      if (!linked) {
        return;
      }
      let requestId: string | null = null;
      if (positive(r.assistant_seq)) {
        const m = message.get(r.assistant_seq);
        if (
          m &&
          m.session_id === r.session_id &&
          m.wake_id === r.wake_id &&
          parsed(m, 'message').role === 'assistant'
        ) {
          requestId = safe(m.request_id);
        }
      }
      const task =
        r.name === 'execute_javascript'
          ? result
          : match(observed)
            ? observed
            : object(list);
      const key = `tool:${ordinal}`;
      items.set(key, {
        ...empty(
          key,
          r.name === 'execute_javascript'
            ? 'execution'
            : r.name === 'query_javascript_jobs'
              ? 'query'
              : 'cancellation',
          row
            ? timestamp(row.created_at)
            : (timestamp(r.finished_at) ??
                timestamp(r.started_at) ??
                timestamp(r.proposed_at)),
        ),
        ...(row ? {} : { anchor: true }),
        ordinal,
        wakeId: wake(r),
        requestId,
        callId: safe(r.call_id),
        state: allowed(r.state, states),
        status: allowed(result.status, statuses),
        taskStatus: allowed(
          r.name === 'execute_javascript'
            ? (task.task_status ?? task.taskStatus)
            : task.status,
          tasks,
        ),
      });
    };
    // The primary-key anchor gets first use of the shared byte and output budgets.
    if (anchorOrdinal !== undefined) {
      linkTool(anchorOrdinal);
      if (!items.has(`tool:${anchorOrdinal}`)) {
        limit('anchor_unmatched');
      }
    }
    const scanJournal = (
      kind: 'tool_result' | 'tool_intent' | 'external_event_received',
    ) => {
      const rows = db
        .prepare(
          `SELECT seq,session_id,wake_id,created_at,${capped('payload', 8192)} FROM model_session_journal INDEXED BY model_session_journal_kind_time WHERE kind COLLATE BINARY=? AND created_at COLLATE BINARY>=? AND created_at COLLATE BINARY<=? ORDER BY created_at COLLATE BINARY DESC,wake_id COLLATE BINARY DESC LIMIT 2001`,
        )
        .iterate(kind, range.since, range.until);
      let count = 0;
      for (const row of rows) {
        if (++count > 2000) {
          limit(
            kind === 'tool_result'
              ? 'tool_result_limit'
              : kind === 'tool_intent'
                ? 'tool_intent_limit'
                : 'notification_journal_limit',
          );
          break;
        }
        if (bytes >= 8 * 1024 * 1024) {
          limit('byte_limit');
          break;
        }
        const payload = parsed(row, 'payload', 8192);
        if (kind !== 'external_event_received') {
          linkTool(payload.ordinal, row);
          continue;
        }
        const id = payload.event_id;
        if (
          typeof id !== 'string' ||
          id.length > 1024 ||
          !id.endsWith(`:${jobId}`) ||
          !/^[1-9]\d{0,31}$/.test(id.slice(0, -(jobId.length + 1)))
        ) {
          continue;
        }
        const r = event(id);
        if (r) {
          received(r);
        }
        const key = `notification_projected:${id}`;
        if (!items.has(key)) {
          items.set(key, {
            ...empty(
              `projection:${String(row.seq)}`,
              'notification_projected',
              timestamp(row.created_at),
            ),
            wakeId: wake(row),
            taskStatus: (r?.taskStatus as string | null) ?? null,
          });
        }
      }
    };
    // Retain notification evidence before unrelated tool bodies consume the budget.
    scanJournal('external_event_received');
    const metadata = db
      .prepare(
        'SELECT event_id,self_id,received_at,projected_at FROM model_external_events ORDER BY rowid DESC LIMIT 501',
      )
      .all();
    if (metadata.length > 500) {
      limit('inbox_limit');
    }
    for (const row of metadata.slice(0, 500)) {
      const time = timestamp(row.received_at);
      if (time === null) {
        limit('candidate_record_unreadable');
        continue;
      }
      if (
        time < range.since ||
        time > range.until ||
        typeof row.self_id !== 'string' ||
        row.event_id !== `${row.self_id}:${jobId}`
      ) {
        continue;
      }
      const r = event(row.event_id);
      if (r) {
        received(r);
      }
    }
    scanJournal('tool_result');
    scanJournal('tool_intent');
    response.items = [...items.values()].sort(
      (a, b) => (a.time ?? 0) - (b.time ?? 0) || a.key.localeCompare(b.key),
    );
    if (response.items.length > 200) {
      limit('output_limit');
      const anchor = response.items.find((item) => item.anchor);
      const retained = response.items
        .filter((item) => !item.anchor)
        .slice(anchor ? -199 : -200);
      if (anchor) {
        retained.push(anchor);
      }
      response.items = retained.sort(
        (a, b) => (a.time ?? 0) - (b.time ?? 0) || a.key.localeCompare(b.key),
      );
    }
  } catch {
    response.unavailable = true;
  }
  return response;
}
