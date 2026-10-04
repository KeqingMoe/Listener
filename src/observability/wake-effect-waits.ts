import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { preparePrivateDatabase } from '../storage/private-file.ts';
import {
  VISIBLE_EFFECT_KINDS,
  type ConfirmedVisibleEffect,
  type EventOrigin,
  type VisibleEffectObserver,
} from '../contracts/visible-effect.ts';

export const WAKE_EFFECT_WAIT_SCHEMA_VERSION = 1;

const wallTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const monotonicTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** Never evaluate accessors or proxy traps while observing optional metadata. */
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value)
  ) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function originSnapshot(value: EventOrigin): EventOrigin | null {
  const origin = fields(value, ['selfId', 'groupId', 'turnId', 'receipt']);
  if (
    !origin ||
    !identifier(origin.selfId) ||
    !identifier(origin.groupId) ||
    !identifier(origin.turnId)
  ) {
    return null;
  }
  const receipt = fields(origin.receipt, ['receivedAt', 'receivedMonotonic']);
  if (
    !receipt ||
    !wallTime(receipt.receivedAt) ||
    !monotonicTime(receipt.receivedMonotonic)
  ) {
    return null;
  }
  return {
    selfId: origin.selfId,
    groupId: origin.groupId,
    turnId: origin.turnId,
    receipt: {
      receivedAt: receipt.receivedAt,
      receivedMonotonic: receipt.receivedMonotonic,
    },
  };
}

/**
 * One row per message-triggered logical listener wake. No message contents, tool
 * arguments, result text, or guessed historical measurements are stored here.
 * Completion is independent of confirmation: a late async ACK can update a
 * finished wake, but never creates a row or uses the currently active wake.
 */
export class WakeEffectWaitStore implements VisibleEffectObserver {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(
    path: string,
    private readonly options: { onError?: () => void } = {},
  ) {
    if (!path || path === ':memory:' || path.includes('\0')) {
      throw new Error('Invalid wake effect wait path');
    }
    preparePrivateDatabase(path, 'Invalid wake effect wait path');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=250; BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS wake_effect_wait_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          schema_version INTEGER NOT NULL,
          collection_started_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wake_effect_waits (
          group_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          self_id TEXT NOT NULL,
          trigger_received_at INTEGER NOT NULL,
          wake_started_at INTEGER NOT NULL,
          wake_finished_at INTEGER,
          wake_outcome TEXT,
          first_effect_at INTEGER,
          first_effect_wait_ms REAL,
          first_effect_kind TEXT,
          PRIMARY KEY(group_id,turn_id)
        );
        CREATE INDEX IF NOT EXISTS wake_effect_waits_received ON wake_effect_waits(trigger_received_at);
        CREATE INDEX IF NOT EXISTS wake_effect_waits_group_received ON wake_effect_waits(group_id,trigger_received_at);`);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO wake_effect_wait_meta(singleton,schema_version,collection_started_at) VALUES(1,?,?)',
        )
        .run(WAKE_EFFECT_WAIT_SCHEMA_VERSION, Date.now());
      if (
        this.db
          .prepare(
            'SELECT schema_version FROM wake_effect_wait_meta WHERE singleton=1',
          )
          .get()?.schema_version !== WAKE_EFFECT_WAIT_SCHEMA_VERSION
      ) {
        throw new Error('Unsupported wake effect wait schema');
      }
      this.db.exec('COMMIT; PRAGMA busy_timeout=0;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Opening may have failed before a transaction was started.
      }
      this.db.close();
      throw error;
    }
  }

  private observe(action: () => void): void {
    if (this.closed) {
      return;
    }
    try {
      action();
    } catch {
      try {
        this.options.onError?.();
      } catch {
        // Diagnostics must never become an execution failure.
      }
    }
  }

  /** Explicit single-bot startup recovery; opening an observer never interrupts another writer. */
  recoverInterrupted(): void {
    this.observe(() => {
      this.db
        .prepare(
          "UPDATE wake_effect_waits SET wake_outcome='interrupted' WHERE wake_outcome IS NULL AND wake_finished_at IS NULL",
        )
        .run();
    });
  }

  begin(value: EventOrigin, wakeStartedAt: number): void {
    this.observe(() => {
      const origin = originSnapshot(value);
      if (!origin || !wallTime(wakeStartedAt)) {
        return;
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO wake_effect_waits
        (group_id,turn_id,self_id,trigger_received_at,wake_started_at)
        VALUES(?,?,?,?,?)`,
        )
        .run(
          origin.groupId,
          origin.turnId,
          origin.selfId,
          origin.receipt.receivedAt,
          wakeStartedAt,
        );
    });
  }

  confirm(value: EventOrigin, event: ConfirmedVisibleEffect): void {
    this.observe(() => {
      const origin = originSnapshot(value);
      const effect = fields(event, [
        'kind',
        'confirmedAt',
        'confirmedMonotonic',
      ]);
      if (
        !origin ||
        !effect ||
        !wallTime(effect.confirmedAt) ||
        !monotonicTime(effect.confirmedMonotonic) ||
        !(VISIBLE_EFFECT_KINDS as readonly unknown[]).includes(effect.kind)
      ) {
        return;
      }
      // Wall-clock adjustment must not manufacture latency or reorder confirmations.
      const elapsed =
        effect.confirmedMonotonic - origin.receipt.receivedMonotonic;
      if (!Number.isFinite(elapsed) || elapsed < 0) {
        return;
      }
      this.db
        .prepare(
          `UPDATE wake_effect_waits
        SET first_effect_at=?,first_effect_wait_ms=?,first_effect_kind=?
        WHERE group_id=? AND turn_id=? AND self_id=? AND trigger_received_at=?
          AND (first_effect_wait_ms IS NULL OR first_effect_wait_ms>?)`,
        )
        .run(
          effect.confirmedAt,
          elapsed,
          effect.kind as string,
          origin.groupId,
          origin.turnId,
          origin.selfId,
          origin.receipt.receivedAt,
          elapsed,
        );
    });
  }

  finish(value: EventOrigin, outcome: string, wakeFinishedAt: number): void {
    this.observe(() => {
      const origin = originSnapshot(value);
      if (
        !origin ||
        !wallTime(wakeFinishedAt) ||
        !identifier(outcome) ||
        !/^[a-z][a-z0-9_]*$/.test(outcome)
      ) {
        return;
      }
      this.db
        .prepare(
          `UPDATE wake_effect_waits SET wake_finished_at=?,wake_outcome=?
        WHERE group_id=? AND turn_id=? AND self_id=? AND trigger_received_at=?
          AND wake_finished_at IS NULL AND wake_outcome IS NULL`,
        )
        .run(
          wakeFinishedAt,
          outcome,
          origin.groupId,
          origin.turnId,
          origin.selfId,
          origin.receipt.receivedAt,
        );
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.observe(() => this.db.close());
    this.closed = true;
  }
}
