import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig, ResolvedGroupConfig } from './app.ts';
import { assertStoragePaths } from './storage-paths.ts';
import { resolveGroupId } from '../contracts/identity.ts';

interface RegisteredGroup {
  groupId: string;
  databasePath: string;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_AGE_MS = 120000;

/**
 * 定期原子写出当前已启用群及其数据库路径，供其他进程发现。
 * 只含私有部署元数据，不含消息正文、persona、模型设置或凭据。
 */
export class GroupRegistry {
  private groups: RegisteredGroup[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private readonly app: AppConfig,
    private readonly onError: () => void = () => {},
  ) {
    mkdirSync(dirname(app.storage.registryPath), {
      recursive: true,
      mode: 0o700,
    });
    this.write();
    this.timer = setInterval(() => {
      try {
        this.write();
      } catch {
        this.onError();
      }
    }, 30000);
    this.timer.unref();
  }

  update(groupIds: readonly string[]): void {
    if (this.closed) {
      return;
    }
    const configs = groupIds
      .map((groupId) => this.app.resolveGroup(groupId))
      .filter((group) => group.enabled);
    assertStoragePaths(this.app.storage, configs);
    this.groups = configs.map((group) => ({
      groupId: group.groupId,
      databasePath: group.storage.databasePath,
    }));
    // 发布失败不能撤销已认证的退群，也不能让对应Listener继续存活。保留目标快照
    // 由定时心跳重试；若文件系统一直不可用，读取方在过期后按失败关闭处理。
    try {
      this.write();
    } catch {
      this.onError();
    }
  }

  private write(): void {
    if (this.closed) {
      return;
    }
    const text = JSON.stringify({ updatedAt: Date.now(), groups: this.groups });
    if (Buffer.byteLength(text) > MAX_BYTES) {
      throw new Error('Group registry exceeds resource limit');
    }
    const path = this.app.storage.registryPath,
      temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    clearInterval(this.timer);
    try {
      this.groups = [];
      this.write();
    } finally {
      this.closed = true;
    }
  }
}

/**
 * registry只是发现线索，不能作为文件路径的依据：所有路径都按当前可信配置重新推导，
 * SQL读取方还会核对每个数据库的群号。任何异常、过期或不一致都返回空列表。
 */
export function readGroupRegistry(app: AppConfig): RegisteredGroup[] {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      app.storage.registryPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      return [];
    }
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.updatedAt !== 'number' ||
      !Number.isFinite(raw.updatedAt) ||
      raw.updatedAt > Date.now() + 5000 ||
      Date.now() - raw.updatedAt > MAX_AGE_MS ||
      !Array.isArray(raw.groups)
    ) {
      return [];
    }
    const seen = new Set<string>(),
      configs: ResolvedGroupConfig[] = [],
      result: RegisteredGroup[] = [];
    for (const row of raw.groups) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return [];
      }
      const entry = row as Record<string, unknown>;
      if (typeof entry.groupId !== 'string') {
        return [];
      }
      const groupId = resolveGroupId(entry.groupId);
      if (seen.has(groupId)) {
        return [];
      }
      seen.add(groupId);
      const group = app.resolveGroup(groupId);
      if (!group.enabled) {
        continue;
      }
      if (entry.databasePath !== group.storage.databasePath) {
        return [];
      }
      configs.push(group);
      result.push({ groupId, databasePath: group.storage.databasePath });
    }
    assertStoragePaths(app.storage, configs);
    return result;
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}
