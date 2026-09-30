import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isExecutionDiagnostic, type ExecutionDiagnostic } from './protocol.ts';

export type JobMode = 'sync' | 'async' | 'auto';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timeout';

export interface JobScope {
  selfId: string;
  groupId: string;
}

export interface JobInput extends JobScope {
  description: string;
  code: string;
  mode: JobMode;
  waitMs?: number;
}

export interface Job extends JobScope {
  toolCalls?: ToolCallSummary;
  job_id: string;
  description: string;
  mode: JobMode;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  background: boolean;
  deliveredAt: number | null;
  value?: string;
  error?: string;
  logs: string[];
  diagnostic?: ExecutionDiagnostic;
}

export type JobSummary = Omit<
  Job,
  'value' | 'error' | 'logs' | 'diagnostic' | 'toolCalls'
>;

export interface JobQuery {
  jobId?: string;
  status?: JobStatus;
  offset?: number;
  limit?: number;
}

export type ToolCallStatus =
  'ok' | 'error' | 'unknown' | 'confirmation_required';

export interface ToolCallRecord {
  seq: number;
  tool: string;
  status: ToolCallStatus;
  error?: string;
  ids: Record<string, string>;
  argsBytes: number;
  argsHash: string;
  startedAt: number;
  finishedAt: number;
}

/** Mandatory model-visible digest: per-tool status counts plus every non-ok call. */
export interface ToolCallSummary {
  counts: Record<string, Partial<Record<ToolCallStatus, number>>>;
  abnormal: {
    seq: number;
    tool: string;
    status: ToolCallStatus;
    error?: string;
  }[];
  abnormal_omitted: number;
}

const ABNORMAL_LIMIT = 32;
export const JOB_BOUNDS = {
  code: 65536,
  description: 1024,
  result: 65536,
  logs: 16384,
};
const states: JobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'timeout',
];

export function validateScope(s: JobScope): void {
  if (
    !s ||
    ![s.selfId, s.groupId].every(
      (v) => typeof v === 'string' && /^[1-9]\d{0,31}$/.test(v),
    )
  ) {
    throw new Error('invalid_scope');
  }
}

export function validateInput(i: JobInput): void {
  validateScope(i);
  if (
    !['sync', 'async', 'auto'].includes(i.mode) ||
    typeof i.description !== 'string' ||
    !i.description.trim() ||
    Buffer.byteLength(i.description) > JOB_BOUNDS.description ||
    typeof i.code !== 'string' ||
    Buffer.byteLength(i.code) > JOB_BOUNDS.code
  ) {
    throw new Error('invalid_arguments');
  }
  const ownsWait = Object.hasOwn(i, 'waitMs');
  if (
    i.mode === 'async'
      ? ownsWait
      : !ownsWait ||
        typeof i.waitMs !== 'number' ||
        !Number.isSafeInteger(i.waitMs) ||
        i.waitMs < 1 ||
        i.waitMs > 2147483647
  ) {
    throw new Error('invalid_arguments');
  }
}

function privateFile(path: string) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      const s = lstatSync(path + suffix);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1 ||
        s.uid !== process.getuid?.() ||
        (s.mode & 0o077) !== 0
      ) {
        throw new Error('unsafe_database');
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
  }
  const fd = openSync(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const s = fstatSync(fd),
      p = lstatSync(path);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid?.() ||
      p.isSymbolicLink() ||
      s.ino !== p.ino ||
      s.dev !== p.dev
    ) {
      throw new Error('unsafe_database');
    }
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQLite行的列由本模块建表语句保证
function decode(r: any): Job | undefined {
  return r
    ? {
        job_id: r.id,
        selfId: r.self_id,
        groupId: r.group_id,
        description: r.description,
        mode: r.mode,
        status: r.status,
        createdAt: r.created_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        background: !!r.background,
        deliveredAt: r.delivered_at,
        ...(r.value !== null ? { value: r.value } : {}),
        ...(r.error !== null ? { error: r.error } : {}),
        logs: JSON.parse(r.logs),
        ...(r.diagnostic !== null
          ? { diagnostic: readDiagnostic(r.diagnostic) }
          : {}),
      }
    : undefined;
}

function readDiagnostic(encoded: unknown): ExecutionDiagnostic {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 8192) {
    throw new Error('invalid_database');
  }
  const value: unknown = JSON.parse(encoded);
  if (!isExecutionDiagnostic(value)) {
    throw new Error('invalid_database');
  }
  return value;
}

export function jobSummary(job: Job): JobSummary {
  const { value, error, logs, diagnostic, toolCalls, ...summary } = job;
  return summary;
}

/** Dedicated private database; code is never persisted. One live service owns each database. */
export class SandboxJobStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(options: { path: string }) {
    if (!options.path || options.path.includes('\0')) {
      throw new Error('invalid_path');
    }
    if (options.path !== ':memory:') {
      privateFile(options.path);
    }
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec(
        'PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;',
      );
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (
        tables.length &&
        (tables.length !== 3 ||
          !tables.every((t) =>
            ['sandbox_identity', 'sandbox_jobs', 'sandbox_tool_calls'].includes(
              String(t.name),
            ),
          ))
      ) {
        throw new Error('invalid_database');
      }
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS sandbox_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO sandbox_identity VALUES(1,1);`,
      );
      if (
        this.db
          .prepare('SELECT version FROM sandbox_identity WHERE singleton=1')
          .get()?.version !== 1
      ) {
        throw new Error('invalid_database');
      }
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS sandbox_jobs(id TEXT PRIMARY KEY,self_id TEXT NOT NULL,group_id TEXT NOT NULL,description TEXT NOT NULL CHECK(length(CAST(description AS BLOB))<=1024),code_hash TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('sync','async','auto')),status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted','timeout')),created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,background INTEGER NOT NULL,delivered_at INTEGER,value TEXT CHECK(value IS NULL OR length(CAST(value AS BLOB))<=65536),error TEXT,logs TEXT NOT NULL,diagnostic TEXT CHECK(diagnostic IS NULL OR length(CAST(diagnostic AS BLOB))<=8192));
 CREATE INDEX IF NOT EXISTS sandbox_scope ON sandbox_jobs(self_id,group_id,created_at,id);
 CREATE INDEX IF NOT EXISTS sandbox_pending ON sandbox_jobs(self_id,background,delivered_at,finished_at);
 CREATE TABLE IF NOT EXISTS sandbox_tool_calls(job_id TEXT NOT NULL,seq INTEGER NOT NULL,tool TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('ok','error','unknown','confirmation_required')),error TEXT,ids TEXT NOT NULL,args_bytes INTEGER NOT NULL,args_hash TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER NOT NULL,PRIMARY KEY(job_id,seq));`);
      this.db
        .prepare(
          "UPDATE sandbox_jobs SET status='interrupted',error='service_restarted',finished_at=?,background=1 WHERE status IN ('running','queued')",
        )
        .run(Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      this.db.close();
      throw e;
    }
  }

  create(input: JobInput): Job {
    validateInput(input);
    const expired = this.db
      .prepare(
        "SELECT id FROM sandbox_jobs WHERE status NOT IN ('queued','running') AND (background=0 OR delivered_at IS NOT NULL) AND finished_at<? LIMIT 100",
      )
      .all(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .map((r) => String(r.id));
    for (const old of expired) {
      this.db.prepare('DELETE FROM sandbox_tool_calls WHERE job_id=?').run(old);
      this.db.prepare('DELETE FROM sandbox_jobs WHERE id=?').run(old);
    }
    const id = `js_${randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO sandbox_jobs VALUES(?,?,?,?,?,?,'queued',?,NULL,NULL,?,NULL,NULL,NULL,'[]',NULL)",
      )
      .run(
        id,
        input.selfId,
        input.groupId,
        input.description,
        createHash('sha256').update(input.code).digest('hex'),
        input.mode,
        Date.now(),
        input.mode === 'async' ? 1 : 0,
      );
    return this.get(input, id)!;
  }

  get(s: JobScope, id: string): Job | undefined {
    validateScope(s);
    return this.withCalls(
      decode(
        this.db
          .prepare(
            'SELECT * FROM sandbox_jobs WHERE self_id=? AND group_id=? AND id=?',
          )
          .get(s.selfId, s.groupId, id),
      ),
    );
  }

  private withCalls(job: Job | undefined): Job | undefined {
    if (!job) {
      return job;
    }
    const summary = this.callSummary(job.job_id);
    return summary ? { ...job, toolCalls: summary } : job;
  }

  recordCall(s: JobScope, jobId: string, record: ToolCallRecord): void {
    validateScope(s);
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM sandbox_jobs WHERE self_id=? AND group_id=? AND id=?',
        )
        .get(s.selfId, s.groupId, jobId)
    ) {
      return;
    }
    this.db
      .prepare('INSERT INTO sandbox_tool_calls VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        jobId,
        record.seq,
        record.tool,
        record.status,
        record.error ?? null,
        JSON.stringify(record.ids),
        record.argsBytes,
        record.argsHash,
        record.startedAt,
        record.finishedAt,
      );
  }

  calls(
    s: JobScope,
    jobId: string,
    offset = 0,
    limit = 100,
  ): { calls: ToolCallRecord[]; hasMore: boolean } {
    validateScope(s);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error('invalid_arguments');
    }
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM sandbox_jobs WHERE self_id=? AND group_id=? AND id=?',
        )
        .get(s.selfId, s.groupId, jobId)
    ) {
      return { calls: [], hasMore: false };
    }
    const rows = this.db
      .prepare(
        'SELECT * FROM sandbox_tool_calls WHERE job_id=? ORDER BY seq LIMIT ? OFFSET ?',
      )
      .all(jobId, limit + 1, offset);
    return {
      calls: rows.slice(0, limit).map((r) => ({
        seq: Number(r.seq),
        tool: String(r.tool),
        status: r.status as ToolCallStatus,
        ...(r.error !== null ? { error: String(r.error) } : {}),
        ids: JSON.parse(String(r.ids)),
        argsBytes: Number(r.args_bytes),
        argsHash: String(r.args_hash),
        startedAt: Number(r.started_at),
        finishedAt: Number(r.finished_at),
      })),
      hasMore: rows.length > limit,
    };
  }

  callSummary(jobId: string): ToolCallSummary | undefined {
    const counts: ToolCallSummary['counts'] = {};
    let total = 0;
    for (const r of this.db
      .prepare(
        'SELECT tool,status,count(*) AS n FROM sandbox_tool_calls WHERE job_id=? GROUP BY tool,status ORDER BY tool,status',
      )
      .all(jobId)) {
      const tool = String(r.tool),
        status = r.status as ToolCallStatus;
      (counts[tool] ??= {})[status] = Number(r.n);
      total += Number(r.n);
    }
    if (!total) {
      return undefined;
    }
    const rows = this.db
      .prepare(
        "SELECT seq,tool,status,error FROM sandbox_tool_calls WHERE job_id=? AND status!='ok' ORDER BY seq LIMIT ?",
      )
      .all(jobId, ABNORMAL_LIMIT);
    const abnormalTotal = Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM sandbox_tool_calls WHERE job_id=? AND status!='ok'",
        )
        .get(jobId)!.n,
    );
    return {
      counts,
      abnormal: rows.map((r) => ({
        seq: Number(r.seq),
        tool: String(r.tool),
        status: r.status as ToolCallStatus,
        ...(r.error !== null ? { error: String(r.error) } : {}),
      })),
      abnormal_omitted: abnormalTotal - rows.length,
    };
  }

  query(
    s: JobScope,
    q: JobQuery = {},
  ):
    Job | undefined | { jobs: JobSummary[]; offset: number; hasMore: boolean } {
    validateScope(s);
    if (q.jobId !== undefined) {
      if (typeof q.jobId !== 'string' || q.jobId.length > 128) {
        throw new Error('invalid_arguments');
      }
      return this.get(s, q.jobId);
    }
    const offset = q.offset ?? 0,
      limit = q.limit ?? 20;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (q.status !== undefined && !states.includes(q.status))
    ) {
      throw new Error('invalid_arguments');
    }
    const filter = q.status
      ? ' AND status=?'
      : " AND (status IN ('queued','running') OR (background=1 AND delivered_at IS NULL))";
    const rows = this.db
      .prepare(
        `SELECT * FROM sandbox_jobs WHERE self_id=? AND group_id=?${filter} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(
        s.selfId,
        s.groupId,
        ...(q.status ? [q.status] : []),
        limit + 1,
        offset,
      )
      .map((r) => {
        const j = jobSummary(decode(r)!);
        return { ...j, description: j.description.slice(0, 160) };
      });
    const jobs: JobSummary[] = [];
    let bytes = 128;
    for (const r of rows.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(r)) + 1;
      if (bytes + size > 24 * 1024) {
        break;
      }
      jobs.push(r);
      bytes += size;
    }
    return { jobs, offset, hasMore: rows.length > jobs.length };
  }

  start(s: JobScope, id: string): boolean {
    validateScope(s);
    return !!this.db
      .prepare(
        "UPDATE sandbox_jobs SET status='running',started_at=? WHERE self_id=? AND group_id=? AND id=? AND status='queued'",
      )
      .run(Date.now(), s.selfId, s.groupId, id).changes;
  }

  detach(s: JobScope, id: string): void {
    validateScope(s);
    this.db
      .prepare(
        'UPDATE sandbox_jobs SET background=1 WHERE self_id=? AND group_id=? AND id=? AND delivered_at IS NULL',
      )
      .run(s.selfId, s.groupId, id);
  }

  settle(
    s: JobScope,
    id: string,
    result: {
      status: Exclude<JobStatus, 'queued' | 'running'>;
      value?: string;
      error?: string;
      logs?: string[];
      diagnostic?: ExecutionDiagnostic;
    },
  ): Job | undefined {
    validateScope(s);
    if (
      !states.includes(result.status) ||
      ['queued', 'running'].includes(result.status)
    ) {
      throw new Error('invalid_result');
    }
    let { status, value, error, diagnostic } = result;
    let logs = result.logs ?? [];
    if (diagnostic !== undefined && !isExecutionDiagnostic(diagnostic)) {
      status = 'failed';
      value = undefined;
      error = 'invalid_executor_result';
      diagnostic = undefined;
    }
    if (
      (status === 'completed' &&
        (typeof value !== 'string' ||
          Buffer.byteLength(value) > JOB_BOUNDS.result)) ||
      !Array.isArray(logs) ||
      logs.some((v) => typeof v !== 'string') ||
      logs.reduce((n, v) => n + Buffer.byteLength(v) + 1, 0) >
        JOB_BOUNDS.logs ||
      logs.length > 4096
    ) {
      status = 'failed';
      value = undefined;
      error = 'invalid_executor_result';
      logs = [];
      diagnostic = undefined;
    }
    if (
      error !== undefined &&
      (typeof error !== 'string' || !/^[-a-zA-Z0-9_]{1,128}$/.test(error))
    ) {
      error = 'execution_failed';
    }
    this.db
      .prepare(
        "UPDATE sandbox_jobs SET status=?,finished_at=?,value=?,error=?,logs=?,diagnostic=? WHERE self_id=? AND group_id=? AND id=? AND status IN ('queued','running')",
      )
      .run(
        status,
        Date.now(),
        status === 'completed' ? value! : null,
        error ?? null,
        JSON.stringify(logs),
        diagnostic === undefined ? null : JSON.stringify(diagnostic),
        s.selfId,
        s.groupId,
        id,
      );
    return this.get(s, id);
  }

  pendingResults(
    selfId: string,
    limit = 100,
    cursor = 0,
  ): { jobs: Job[]; nextCursor: number | null } {
    validateScope({ selfId, groupId: '1' });
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    ) {
      throw new Error('invalid_limit');
    }
    const rows = this.db
      .prepare(
        "SELECT rowid AS cursor_id,* FROM sandbox_jobs WHERE self_id=? AND rowid>? AND background=1 AND delivered_at IS NULL AND status NOT IN ('queued','running') ORDER BY rowid LIMIT ?",
      )
      .all(selfId, cursor, limit + 1);
    return {
      jobs: rows.slice(0, limit).map((r) => this.withCalls(decode(r))!),
      nextCursor:
        rows.length > limit ? Number(rows[limit - 1]!.cursor_id) : null,
    };
  }

  markDelivered(s: JobScope, id: string): boolean {
    validateScope(s);
    return !!this.db
      .prepare(
        "UPDATE sandbox_jobs SET delivered_at=? WHERE self_id=? AND group_id=? AND id=? AND background=1 AND delivered_at IS NULL AND status NOT IN ('queued','running')",
      )
      .run(Date.now(), s.selfId, s.groupId, id).changes;
  }

  summary(selfId: string, groupId: string): JobSummary[] {
    validateScope({ selfId, groupId });
    return this.db
      .prepare(
        "SELECT * FROM sandbox_jobs WHERE self_id=? AND group_id=? AND status IN ('queued','running') ORDER BY created_at,id LIMIT 32",
      )
      .all(selfId, groupId)
      .map((r) => {
        const j = jobSummary(decode(r)!);
        return { ...j, description: j.description.slice(0, 160) };
      });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
