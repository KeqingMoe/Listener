import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSession } from '../../src/agent/session/store.ts';
import { WorldEventStore } from '../../src/world/events.ts';
import { LISTENER_GROUP } from '../../src/contracts/identity.ts';
import type { ChatMessage } from '../../src/contracts/model.ts';
import type { JsonObject } from '../../src/contracts/json.ts';

const directories = new Set<string>();
// 多数测试不显式stop Listener；进程退出时统一删除临时目录。
process.once('exit', () => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Listener测试共用的会话运行时：临时目录中的ModelSession与WorldEventStore。
 * 与生产装配一致，Listener总在会话模式下运行。
 */
export function sessionRuntime(groupId: string | undefined = LISTENER_GROUP) {
  groupId ??= LISTENER_GROUP;
  const dir = mkdtempSync(join(tmpdir(), 'listener-session-'));
  directories.add(dir);
  const session = new ModelSession({
    model: 'main',
    path: join(dir, 'session.sqlite'),
    groupId,
  });
  const world = new WorldEventStore({
    path: join(dir, 'world.sqlite'),
    groupId,
  });
  return {
    dir,
    session,
    world,
    runtime: { session, world },
  };
}

/** 请求中最后一条唤醒元数据（{wake: ...}）。 */
export function wakeMeta(messages: readonly ChatMessage[]): JsonObject {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user' || typeof message.content !== 'string') {
      continue;
    }
    try {
      const value = JSON.parse(message.content) as JsonObject;
      if (value && typeof value === 'object' && 'wake' in value) {
        return value.wake as JsonObject;
      }
    } catch {
      /* 非JSON输入不是唤醒元数据。 */
    }
  }
  throw new Error('wake metadata not found');
}
