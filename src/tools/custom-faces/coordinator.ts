import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { immediate } from '../../storage/transaction.ts';

const KIND = 'qqbot.custom-face-operations';
const TABLES = ['custom_face_operation_identity', 'custom_face_operations'];

export class CustomFaceCoordinationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new CustomFaceCoordinationError(code);
}

function inspect(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name,type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  if (
    tables.length !== TABLES.length ||
    tables.some((r) => r.type !== 'table' || !TABLES.includes(String(r.name)))
  ) {
    fail('operation_store_identity_mismatch');
  }
  const rows = db
    .prepare(
      'SELECT singleton,kind,version FROM custom_face_operation_identity',
    )
    .all();
  if (
    rows.length !== 1 ||
    rows[0]?.singleton !== 1 ||
    rows[0]?.kind !== KIND ||
    rows[0]?.version !== 1
  ) {
    fail('operation_store_identity_mismatch');
  }
  db.prepare(
    'SELECT id,account,targets,phase,state FROM custom_face_operations LIMIT 0',
  );
}

/**
 * 根级、持久化的预写式不确定性防护，不随模型wake重置。
 * 同一原生账号的操作串行执行，不同账号可以并发。上个进程遗留的pending记录保守地恢复为unknown。
 * 日志中除账号身份外不记录任何QQ ID，也不记录URL、路径、源消息或payload。
 */
export class CustomFaceCoordinator {
  private readonly db: DatabaseSync;
  private readonly tails = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(options: { path?: string } = {}) {
    const path = options.path ?? ':memory:';
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 4096 ||
      /[\u0000-\u001f]/.test(path)
    ) {
      fail('invalid_operation_store_path');
    }
    let fd: number | undefined, db: DatabaseSync | undefined;
    try {
      let existing = false,
        info: ReturnType<typeof fstatSync> | undefined;
      if (path !== ':memory:') {
        for (const suffix of ['-journal', '-wal', '-shm']) {
          try {
            const side = lstatSync(path + suffix);
            if (
              !side.isFile() ||
              side.isSymbolicLink() ||
              side.nlink !== 1 ||
              (process.getuid && side.uid !== process.getuid())
            ) {
              fail('unsafe_operation_store');
            }
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw e;
            }
          }
        }
        fd = openSync(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        info = fstatSync(fd);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (process.getuid && info.uid !== process.getuid())
        ) {
          fail('unsafe_operation_store');
        }
        existing = info.size > 0;
        if (existing) {
          const probe = new DatabaseSync(path, { readOnly: true });
          try {
            inspect(probe);
          } finally {
            probe.close();
          }
        }
        const now = lstatSync(path);
        if (
          now.isSymbolicLink() ||
          now.ino !== info.ino ||
          now.dev !== info.dev
        ) {
          fail('operation_store_changed');
        }
        fchmodSync(fd, 0o600);
      }
      db = new DatabaseSync(path);
      if (info) {
        const now = lstatSync(path);
        if (
          now.isSymbolicLink() ||
          now.ino !== info.ino ||
          now.dev !== info.dev
        ) {
          fail('operation_store_changed');
        }
      }
      db.exec(
        'PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;',
      );
      if (!existing) {
        const open = db;
        immediate(open, () => {
          open.exec(
            "CREATE TABLE custom_face_operation_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),kind TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE custom_face_operations(id TEXT PRIMARY KEY,account TEXT NOT NULL,targets TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','unknown','hold','done')));",
          );
          open
            .prepare('INSERT INTO custom_face_operation_identity VALUES(1,?,1)')
            .run(KIND);
        });
      }
      inspect(db);
      db.exec(
        "UPDATE custom_face_operations SET state='unknown' WHERE state='pending'",
      );
      this.db = db;
    } catch (e) {
      db?.close();
      throw e;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  private check(): void {
    if (this.closed) {
      fail('operation_store_closed');
    }
  }

  private validate(account: string, targets: readonly string[]): void {
    this.check();
    if (
      typeof account !== 'string' ||
      account.trim() !== account ||
      !/^[1-9]\d{0,31}$/.test(account) ||
      !Array.isArray(targets) ||
      !targets.length ||
      targets.length > 4 ||
      targets.some(
        (t) =>
          typeof t !== 'string' || t.length !== 64 || !/^[a-f0-9]{64}$/.test(t),
      )
    ) {
      fail('invalid_operation_scope');
    }
  }

  async run<T>(account: string, task: () => Promise<T>): Promise<T> {
    this.check();
    if (
      typeof account !== 'string' ||
      account.trim() !== account ||
      !/^[1-9]\d{0,31}$/.test(account)
    ) {
      fail('invalid_operation_scope');
    }
    const previous = this.tails.get(account) ?? Promise.resolve();
    const work = previous
      .catch(() => undefined)
      .then(() => {
        this.check();
        return task();
      });
    this.tails.set(account, work);
    try {
      return await work;
    } finally {
      if (this.tails.get(account) === work) {
        this.tails.delete(account);
      }
    }
  }

  assertAllowed(account: string, targets: readonly string[]): void {
    this.validate(account, targets);
    const rows = this.db
      .prepare(
        "SELECT targets,state FROM custom_face_operations WHERE account=? AND state!='done'",
      )
      .all(account);
    for (const row of rows) {
      const prior: unknown = JSON.parse(String(row.targets));
      if (
        !Array.isArray(prior) ||
        prior.some((t) => typeof t !== 'string' || !/^[a-f0-9]{64}$/.test(t))
      ) {
        fail('operation_store_corrupt');
      }
      if (row.state === 'pending' || prior.some((t) => targets.includes(t))) {
        fail('previous_operation_unresolved');
      }
    }
  }

  /**
   * 只有正常ACK、且两项原始内容证明都齐全的add才能参与只读对账。
   * unknown、pending、legacy或其他phase的记录，不能因为之后找到了图片就升级为正常提交。
   */
  recoverableAddHolds(account: string, proofs: readonly string[]): string[] {
    this.validate(account, proofs);
    if (proofs.length !== 2 || new Set(proofs).size !== 2) {
      fail('invalid_recovery_scope');
    }
    const rows = this.db
      .prepare(
        "SELECT id,targets,phase,state FROM custom_face_operations WHERE account=? AND state!='done' LIMIT 4097",
      )
      .all(account);
    if (rows.length > 4096) {
      fail('operation_store_corrupt');
    }
    const ids: string[] = [];
    for (const row of rows) {
      const target: unknown = JSON.parse(String(row.targets));
      if (
        !Array.isArray(target) ||
        target.some(
          (t) =>
            typeof t !== 'string' ||
            t.length !== 64 ||
            !/^[a-f0-9]{64}$/.test(t),
        )
      ) {
        fail('operation_store_corrupt');
      }
      if (row.state === 'pending') {
        fail('previous_operation_unresolved');
      }
      if (!target.some((t) => proofs.includes(t))) {
        continue;
      }
      if (
        row.phase !== 'add' ||
        row.state !== 'hold' ||
        target.length !== proofs.length ||
        !proofs.every((t) => target.includes(t))
      ) {
        fail('previous_operation_unresolved');
      }
      ids.push(String(row.id));
    }
    return ids;
  }

  /**
   * 调用方刚确证了源SHA256、候选字节、唯一的原生身份和登录账号。
   * 只对这些确切的正常add hold做CAS；即使回读期间状态有变，也不清除全部hold或任何unknown写入。
   */
  completeRecoveredAddHolds(
    account: string,
    proofs: readonly string[],
    ids: readonly string[],
  ): void {
    this.validate(account, proofs);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 4096 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || id.length > 64)
    ) {
      fail('invalid_recovery_scope');
    }
    immediate(this.db, () => {
      const current = this.recoverableAddHolds(account, proofs);
      if (
        current.length !== ids.length ||
        current.some((id) => !ids.includes(id))
      ) {
        fail('previous_operation_unresolved');
      }
      const update = this.db.prepare(
        "UPDATE custom_face_operations SET state='done' WHERE id=? AND account=? AND phase='add' AND state='hold'",
      );
      for (const id of ids) {
        if (Number(update.run(id, account).changes) !== 1) {
          fail('previous_operation_unresolved');
        }
      }
    });
  }

  /** 在调用原生API之前同步提交记录。 */
  begin(
    account: string,
    targets: readonly string[],
    phase: 'add' | 'description' | 'delete' | 'send',
  ): string {
    this.validate(account, targets);
    if (!['add', 'description', 'delete', 'send'].includes(phase)) {
      fail('invalid_operation_phase');
    }
    return immediate(this.db, () => {
      this.assertAllowed(account, targets);
      // 多阶段的add/description操作中保留各phase的回执。
      // 只淘汰有限数量的已完成旧记录，不确定的记录永不淘汰。
      const count = () =>
        Number(
          this.db
            .prepare('SELECT COUNT(*) AS n FROM custom_face_operations')
            .get()?.n,
        );
      if (count() >= 4096) {
        this.db.exec(
          "DELETE FROM custom_face_operations WHERE id IN (SELECT id FROM custom_face_operations WHERE state='done' ORDER BY rowid ASC LIMIT 512)",
        );
      }
      if (count() >= 4096) {
        fail('operation_resource_limit');
      }
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO custom_face_operations VALUES(?,?,?,?,'pending')")
        .run(id, account, JSON.stringify([...new Set(targets)]), phase);
      return id;
    });
  }

  /** hold会保留正常提交的记录，直到有了安全的绑定或本地投影。 */
  settle(id: string, state: 'unknown' | 'hold' | 'done'): void {
    this.check();
    if (!['unknown', 'hold', 'done'].includes(state)) {
      fail('invalid_operation_state');
    }
    const changed = this.db
      .prepare('UPDATE custom_face_operations SET state=? WHERE id=?')
      .run(state, id);
    if (Number(changed.changes) !== 1) {
      fail('operation_missing');
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
