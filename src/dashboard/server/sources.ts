import type { AppConfig, ResolvedGroupConfig } from '../../config/app.ts';
import { assertStoragePaths } from '../../config/loader.ts';
import { readGroupRegistry } from '../../config/group-registry.ts';
import type { GroupSource } from './repository.ts';

/**
 * dashboard可读取历史数据的群范围，刻意与bot的路由权限分开。
 * 显式配置且启用的群离线时仍可读；未配置的群需要注册表中有新鲜的租约。
 * 每次都从可信的本地策略重新推导所有路径。
 */
export function dashboardGroupSources(app: AppConfig): GroupSource[] {
  try {
    const ids = new Set(app.configuredGroupIds);
    for (const entry of readGroupRegistry(app)) {
      ids.add(entry.groupId);
    }
    const groups: ResolvedGroupConfig[] = [];
    for (const id of ids) {
      const group = app.resolveGroup(id);
      if (group.enabled) {
        groups.push(group);
      }
    }
    assertStoragePaths(app.storage, groups);
    return groups.map((group) => ({
      groupId: group.groupId,
      sessionPath: `${group.storage.databasePath}.session.sqlite`,
      worldPath: `${group.storage.databasePath}.events.sqlite`,
    }));
  } catch {
    // 策略或路径组合无效时返回空列表，绝不退回到未经校验的子集。
    return [];
  }
}
