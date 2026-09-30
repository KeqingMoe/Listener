import type { DatabaseSync } from 'node:sqlite';

/**
 * 在BEGIN IMMEDIATE事务中执行work，成功则COMMIT。
 * 失败时尽力ROLLBACK；回滚本身的错误被忽略，始终抛出原始错误。
 */
export function immediate<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 连接已断开或事务已被SQLite自动回滚时，保留原始错误。
    }
    throw error;
  }
}
