import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const REMINDER_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_TIME = 8_640_000_000_000_000;

export type ReminderState =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'unknown'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type ReminderReason =
  | 'restart_during_send'
  | 'dispatch_unknown'
  | 'not_dispatched'
  | 'delivery_failed'
  | 'grace_expired';

export type DeliveryOutcome =
  | { state: 'sent'; messageId: string }
  | { state: 'unknown' | 'failed'; reason?: ReminderReason };

export interface ReminderInput {
  selfId: string;
  groupId: string;
  creatorId: string;
  sourceMessageId: string;
  text: string;
  dueAt: number;
  timeZone: string;
}

export interface Reminder extends ReminderInput {
  id: string;
  expiresAt: number;
  state: ReminderState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  messageId?: string;
  reason?: ReminderReason;
}

export interface ReminderScope {
  selfId: string;
  groupId: string;
  id: string;
  expectedRevision: number;
}

export type ReminderPatch = Partial<
  Pick<ReminderInput, 'text' | 'dueAt' | 'timeZone'>
>;

const states: ReminderState[] = [
  'pending',
  'sending',
  'sent',
  'unknown',
  'failed',
  'cancelled',
  'expired',
];
const reasons: ReminderReason[] = [
  'restart_during_send',
  'dispatch_unknown',
  'not_dispatched',
  'delivery_failed',
  'grace_expired',
];

function fail(): never {
  throw new Error('Invalid reminder operation');
}

function identity(value: string): void {
  if (typeof value !== 'string' || !/^[1-9]\d{0,31}$/.test(value)) {
    fail();
  }
}

function message(value: string): void {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,31})$/.test(value)) {
    fail();
  }
}

function time(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIME) {
    fail();
  }
}

function body(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  ) {
    fail();
  }
}

function zone(value: string): void {
  if (typeof value !== 'string' || !value) {
    fail();
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    fail();
  }
}

function scope(value: ReminderScope): void {
  identity(value.selfId);
  identity(value.groupId);
  if (
    typeof value.id !== 'string' ||
    !/^rem_[a-f0-9-]{36}$/.test(value.id) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1
  ) {
    fail();
  }
}

function privateFile(path: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      const stat = lstatSync(path + suffix);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      ) {
        fail();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
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
    const stat = fstatSync(fd),
      current = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      current.isSymbolicLink() ||
      stat.ino !== current.ino ||
      stat.dev !== current.dev
    ) {
      fail();
    }
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function row(value: unknown): Reminder | undefined {
  if (!value) {
    return;
  }
  const r = value as Record<string, any>;
  return {
    id: r.id,
    selfId: r.self_id,
    groupId: r.group_id,
    creatorId: r.creator_id,
    sourceMessageId: r.source_message_id,
    text: r.text,
    dueAt: r.due_at,
    expiresAt: r.expires_at,
    timeZone: r.time_zone,
    state: r.state,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.message_id !== null ? { messageId: r.message_id } : {}),
    ...(r.reason !== null ? { reason: r.reason } : {}),
  };
}

/** Account/group-scoped one-shot reminders. Opening a store recovers uncertain sends, never retries them. */
export class ReminderStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(options: { path: string }) {
    if (
      typeof options.path !== 'string' ||
      !options.path ||
      options.path.includes('\0')
    ) {
      fail();
    }
    if (options.path !== ':memory:') {
      privateFile(options.path);
    }
    this.db = new DatabaseSync(options.path);
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (
        tables.length &&
        (tables.length !== 2 ||
          !tables.every(
            (t) => t.name === 'reminder_identity' || t.name === 'reminders',
          ))
      ) {
        fail();
      }
      if (
        tables.length &&
        this.db
          .prepare('SELECT version FROM reminder_identity WHERE singleton=1')
          .get()?.version !== 1
      ) {
        fail();
      }
      this.db
        .exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS reminder_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
        INSERT OR IGNORE INTO reminder_identity VALUES(1,1);`);
      if (
        this.db
          .prepare('SELECT version FROM reminder_identity WHERE singleton=1')
          .get()?.version !== 1
      ) {
        fail();
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, self_id TEXT NOT NULL, group_id TEXT NOT NULL, creator_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        time_zone TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, message_id TEXT, reason TEXT);
        CREATE INDEX IF NOT EXISTS reminders_due ON reminders(self_id,state,due_at);
        CREATE INDEX IF NOT EXISTS reminders_scope ON reminders(self_id,group_id,created_at);
        UPDATE reminders SET state='unknown', reason='restart_during_send', revision=revision+1 WHERE state='sending';
        COMMIT;`);
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      this.db.close();
      throw error;
    }
  }

  private open(): void {
    if (this.closed) {
      throw new Error('Reminder store is closed');
    }
  }

  create(input: ReminderInput, now = Date.now()): Reminder {
    this.open();
    identity(input.selfId);
    identity(input.groupId);
    identity(input.creatorId);
    message(input.sourceMessageId);
    body(input.text);
    zone(input.timeZone);
    time(input.dueAt);
    time(now);
    if (input.dueAt <= now || input.dueAt > MAX_TIME - REMINDER_GRACE_MS) {
      fail();
    }
    const id = `rem_${randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO reminders VALUES(?,?,?,?,?,?,?,?,?,'pending',1,?,?,NULL,NULL)",
      )
      .run(
        id,
        input.selfId,
        input.groupId,
        input.creatorId,
        input.sourceMessageId,
        input.text,
        input.dueAt,
        input.dueAt + REMINDER_GRACE_MS,
        input.timeZone,
        now,
        now,
      );
    return this.get(input.selfId, input.groupId, id)!;
  }

  get(selfId: string, groupId: string, id: string): Reminder | undefined {
    this.open();
    identity(selfId);
    identity(groupId);
    return row(
      this.db
        .prepare(
          'SELECT * FROM reminders WHERE self_id=? AND group_id=? AND id=?',
        )
        .get(selfId, groupId, id),
    );
  }

  list(
    selfId: string,
    groupId: string,
    options: { limit: number; offset?: number; state?: ReminderState },
  ): Reminder[] {
    this.open();
    identity(selfId);
    identity(groupId);
    const offset = options.offset ?? 0;
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (options.state !== undefined && !states.includes(options.state))
    ) {
      fail();
    }
    const filter = options.state === undefined ? '' : ' AND state=?';
    return this.db
      .prepare(
        `SELECT * FROM reminders WHERE self_id=? AND group_id=?${filter} ORDER BY due_at,id LIMIT ? OFFSET ?`,
      )
      .all(
        selfId,
        groupId,
        ...(options.state === undefined ? [] : [options.state]),
        options.limit,
        offset,
      )
      .map((r) => row(r)!);
  }

  update(
    s: ReminderScope,
    patch: ReminderPatch,
    now = Date.now(),
  ): Reminder | undefined {
    this.open();
    scope(s);
    time(now);
    if (
      !patch ||
      Object.keys(patch).some(
        (k) => !['text', 'dueAt', 'timeZone'].includes(k),
      ) ||
      !Object.keys(patch).length
    ) {
      fail();
    }
    const current = this.get(s.selfId, s.groupId, s.id);
    if (!current) {
      return;
    }
    const text = patch.text === undefined ? current.text : patch.text,
      dueAt = patch.dueAt === undefined ? current.dueAt : patch.dueAt,
      timeZone =
        patch.timeZone === undefined ? current.timeZone : patch.timeZone;
    body(text);
    time(dueAt);
    zone(timeZone);
    if (
      (patch.dueAt !== undefined && dueAt <= now) ||
      dueAt > MAX_TIME - REMINDER_GRACE_MS
    ) {
      fail();
    }
    const result = this.db
      .prepare(
        "UPDATE reminders SET text=?,due_at=?,expires_at=?,time_zone=?,revision=revision+1,updated_at=? WHERE self_id=? AND group_id=? AND id=? AND revision=? AND state='pending' AND expires_at>?",
      )
      .run(
        text,
        dueAt,
        dueAt + REMINDER_GRACE_MS,
        timeZone,
        now,
        s.selfId,
        s.groupId,
        s.id,
        s.expectedRevision,
        now,
      );
    return result.changes ? this.get(s.selfId, s.groupId, s.id) : undefined;
  }

  cancel(s: ReminderScope, now = Date.now()): Reminder | undefined {
    this.open();
    scope(s);
    time(now);
    const result = this.db
      .prepare(
        "UPDATE reminders SET state='cancelled',revision=revision+1,updated_at=? WHERE self_id=? AND group_id=? AND id=? AND revision=? AND state='pending' AND expires_at>?",
      )
      .run(now, s.selfId, s.groupId, s.id, s.expectedRevision, now);
    return result.changes ? this.get(s.selfId, s.groupId, s.id) : undefined;
  }

  due(selfId: string, now: number, limit = 64, offset = 0): Reminder[] {
    this.open();
    identity(selfId);
    time(now);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      fail();
    }
    return this.db
      .prepare(
        "SELECT * FROM reminders WHERE self_id=? AND state='pending' AND due_at<=? AND expires_at>? ORDER BY due_at,id LIMIT ? OFFSET ?",
      )
      .all(selfId, now, now, limit, offset)
      .map((r) => row(r)!);
  }

  claim(
    id: string,
    revision: number,
    selfId: string,
    groupId: string,
    now: number,
  ): boolean {
    this.open();
    scope({ id, expectedRevision: revision, selfId, groupId });
    time(now);
    return !!this.db
      .prepare(
        "UPDATE reminders SET state='sending',revision=revision+1,updated_at=? WHERE self_id=? AND group_id=? AND id=? AND revision=? AND state='pending' AND due_at<=? AND expires_at>?",
      )
      .run(now, selfId, groupId, id, revision, now, now).changes;
  }

  settle(
    s: ReminderScope,
    outcome: DeliveryOutcome,
    now = Date.now(),
  ): Reminder | undefined {
    this.open();
    scope(s);
    time(now);
    if (!outcome || !['sent', 'unknown', 'failed'].includes(outcome.state)) {
      fail();
    }
    if (outcome.state === 'sent') {
      message(outcome.messageId);
    } else if (
      outcome.reason !== undefined &&
      !reasons.includes(outcome.reason)
    ) {
      fail();
    }
    const reason =
      outcome.state === 'sent'
        ? null
        : (outcome.reason ??
          (outcome.state === 'unknown'
            ? 'dispatch_unknown'
            : 'delivery_failed'));
    const result = this.db
      .prepare(
        "UPDATE reminders SET state=?,message_id=?,reason=?,revision=revision+1,updated_at=? WHERE self_id=? AND group_id=? AND id=? AND revision=? AND state='sending'",
      )
      .run(
        outcome.state,
        outcome.state === 'sent' ? outcome.messageId : null,
        reason,
        now,
        s.selfId,
        s.groupId,
        s.id,
        s.expectedRevision,
      );
    return result.changes ? this.get(s.selfId, s.groupId, s.id) : undefined;
  }

  /** Maintenance is scoped to an account, or all accounts when explicitly omitted at startup. */
  expire(now = Date.now(), selfId?: string): number {
    this.open();
    time(now);
    if (selfId !== undefined) {
      identity(selfId);
    }
    return Number(
      this.db
        .prepare(
          `UPDATE reminders SET state='expired',reason='grace_expired',revision=revision+1,updated_at=? WHERE state='pending' AND expires_at<=?${selfId === undefined ? '' : ' AND self_id=?'}`,
        )
        .run(now, now, ...(selfId === undefined ? [] : [selfId])).changes,
    );
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
