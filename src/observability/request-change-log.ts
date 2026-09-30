import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const LIMIT = 50_000;
const metaSql = `CREATE TABLE request_change_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
  epoch TEXT NOT NULL, revision INTEGER NOT NULL, floor_revision INTEGER NOT NULL
)`;
const changesSql = `CREATE TABLE request_changes (
  revision INTEGER PRIMARY KEY, old_group_id TEXT, old_request_id TEXT,
  new_group_id TEXT, new_request_id TEXT
)`;
const triggers = ['model_requests', 'model_request_inspections'].flatMap(
  (table) =>
    (['INSERT', 'UPDATE', 'DELETE'] as const).map((event) => {
      const name = `request_changes_${table}_${event.toLowerCase()}`;
      const old =
        event === 'INSERT' ? 'NULL,NULL' : 'OLD.group_id,OLD.request_id';
      const next =
        event === 'DELETE' ? 'NULL,NULL' : 'NEW.group_id,NEW.request_id';
      return {
        name,
        sql: `CREATE TRIGGER ${name} AFTER ${event} ON ${table} BEGIN
      UPDATE request_change_meta SET revision=revision+1,
        floor_revision=MAX(0,revision+1-${LIMIT}) WHERE singleton=1;
      INSERT INTO request_changes(revision,old_group_id,old_request_id,new_group_id,new_request_id)
        SELECT revision,${old},${next} FROM request_change_meta WHERE singleton=1;
      DELETE FROM request_changes WHERE revision <= (SELECT floor_revision FROM request_change_meta WHERE singleton=1);
    END`,
      };
    }),
);
const canonical = (sql: unknown): string =>
  typeof sql === 'string'
    ? sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')
    : '';

/** 只读、开销固定的schema校验，与journal读取方共用。 */
export function requestChangeLogSchemaIntact(db: DatabaseSync): boolean {
  const objects = db
    .prepare(
      `SELECT name,sql FROM sqlite_schema WHERE name IN (${[metaSql, changesSql, ...triggers].map(() => '?').join(',')})`,
    )
    .all(
      'request_change_meta',
      'request_changes',
      ...triggers.map((t) => t.name),
    );
  const expected = [
    { name: 'request_change_meta', sql: metaSql },
    { name: 'request_changes', sql: changesSql },
    ...triggers,
  ];
  return expected.every((e) =>
    objects.some(
      (o) => o.name === e.name && canonical(o.sql) === canonical(e.sql),
    ),
  );
}

function intact(db: DatabaseSync): boolean {
  if (!requestChangeLogSchemaIntact(db)) {
    return false;
  }
  const rows = db.prepare('SELECT * FROM request_change_meta').all();
  const m = rows[0];
  if (
    rows.length !== 1 ||
    !m ||
    m.singleton !== 1 ||
    m.schema_version !== 1 ||
    typeof m.epoch !== 'string' ||
    !m.epoch.length ||
    typeof m.revision !== 'number' ||
    !Number.isSafeInteger(m.revision) ||
    m.revision < 0 ||
    m.floor_revision !== Math.max(0, m.revision - LIMIT)
  ) {
    return false;
  }
  const bounds = db
    .prepare(
      'SELECT COUNT(*) AS n,MIN(revision) AS lo,MAX(revision) AS hi FROM request_changes',
    )
    .get()!;
  return (
    bounds.n === m.revision - Number(m.floor_revision) &&
    (m.revision === 0
      ? bounds.lo === null && bounds.hi === null
      : bounds.lo === Number(m.floor_revision) + 1 && bounds.hi === m.revision)
  );
}

/**
 * 仅由写入方安装。任一组件缺失或变更都意味着旧的cursor epoch不再可靠，需要换新epoch重建。
 * 源表写入和对应的只含主键的日志条目由触发器写入，共享调用方的SQLite事务。
 * 安装失败不对外暴露，也不能导致已有的usage telemetry失效。
 */
export function installRequestChangeLog(db: DatabaseSync): boolean {
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const table of ['model_requests', 'model_request_inspections']) {
      const object = db
        .prepare('SELECT type FROM sqlite_schema WHERE name=?')
        .get(table);
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (
        object?.type !== 'table' ||
        !['request_id', 'group_id'].every((name) =>
          columns.some((c) => c.name === name),
        )
      ) {
        throw new Error('Request change sources unavailable');
      }
    }
    // 查询加速索引在单独升级时也会安装，但不属于读取方判断journal有效性的约定。
    db.exec(
      'CREATE INDEX IF NOT EXISTS model_request_inspections_group_started ON model_request_inspections(group_id,started_at)',
    );
    if (!intact(db)) {
      for (const trigger of triggers) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
      db.exec(
        'DROP TABLE IF EXISTS request_changes; DROP TABLE IF EXISTS request_change_meta;',
      );
      db.exec(metaSql);
      db.exec(changesSql);
      // 完整schema和全部六个触发器一起提交之前，读取方看不到这些变更。
      db.prepare('INSERT INTO request_change_meta VALUES(1,1,?,0,0)').run(
        randomUUID(),
      );
      for (const trigger of triggers) {
        db.exec(trigger.sql);
      }
    }
    db.exec('COMMIT');
    return true;
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* BEGIN本身可能就失败了。 */
    }
    // 只回滚可能留下看似有效的元数据和不完整的触发器。
    // 因此把自己的触发器也删掉，避免可选功能安装失败后破坏usage的INSERT。
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const trigger of triggers) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
      db.exec('DROP TABLE IF EXISTS request_change_meta; COMMIT;');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 数据库被锁或不可用：此时任何写入都无法进行。 */
      }
    }
    return false;
  }
}
