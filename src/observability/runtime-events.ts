import { constants, openSync, closeSync, fstatSync, fchmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeLogFields, type ObservedLog } from './logger.ts';

const MAX_ROWS = 30000,
  RETENTION_MS = 7 * 86400000;

/** A bounded private index of structured runtime events; never a sink for raw chat or exceptions. */
export class RuntimeEventStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private lastCleanup = 0;
  constructor(path: string) {
    if (!path || path === ':memory:' || path.includes('\0')) {
      throw new Error('Invalid runtime event path');
    }
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error('Invalid runtime event path');
      }
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=250; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS runtime_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, event TEXT NOT NULL,
        group_id TEXT, turn_id TEXT, message_id TEXT, fields TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_events_group_time ON runtime_events(group_id,observed_at);
      CREATE INDEX IF NOT EXISTS runtime_events_turn ON runtime_events(turn_id,seq);
      CREATE INDEX IF NOT EXISTS runtime_events_event_time ON runtime_events(event,observed_at);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  record(record: ObservedLog): void {
    if (this.closed) {
      throw new Error('Runtime event store closed');
    }
    if (
      !Number.isSafeInteger(record.observedAt) ||
      record.observedAt < 0 ||
      !/^(app|onebot|message|trigger|turn|model|tool|image|forward|memory|moderation|command|send|logging|attention|session)\.[a-z][a-z0-9_]{0,39}$/.test(
        record.event,
      )
    ) {
      return;
    }
    const fields = sanitizeLogFields(record.fields),
      text = JSON.stringify({ ...fields, level: record.level });
    if (Buffer.byteLength(text) > 8192) {
      return;
    }
    const id = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;
    this.db
      .prepare(
        'INSERT INTO runtime_events(observed_at,event,group_id,turn_id,message_id,fields) VALUES(?,?,?,?,?,?)',
      )
      .run(
        record.observedAt,
        record.event,
        id(fields.group_id),
        id(fields.turn_id),
        id(fields.message_id),
        text,
      );
    if (record.observedAt - this.lastCleanup >= 60000) {
      this.lastCleanup = record.observedAt;
      this.db
        .prepare('DELETE FROM runtime_events WHERE observed_at<?')
        .run(Math.max(0, record.observedAt - RETENTION_MS));
      this.db
        .prepare(
          'DELETE FROM runtime_events WHERE seq < (SELECT seq FROM runtime_events ORDER BY seq DESC LIMIT 1 OFFSET ?)',
        )
        .run(MAX_ROWS - 1);
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
