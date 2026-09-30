import type { AppConfig, ResolvedGroupConfig } from '../../config/app.ts';
import { assertStoragePaths } from '../../config/loader.ts';
import { readGroupRegistry } from '../../config/group-registry.ts';
import type { GroupSource } from './repository.ts';

/** Dashboard historical-read scope, deliberately NOT the bot's routing authority.
 * Explicit enabled groups remain readable offline. Unconfigured groups need a
 * fresh registry lease. Every path is derived again from trusted local policy.
 */
export function dashboardGroupSources(app: AppConfig): GroupSource[] {
  try {
    const ids = new Set(app.configuredGroupIds);
    for (const entry of readGroupRegistry(app)) ids.add(entry.groupId);
    const groups: ResolvedGroupConfig[] = [];
    for (const id of ids) {
      const group = app.resolveGroup(id);
      if (group.enabled) groups.push(group);
    }
    assertStoragePaths(app.storage, groups);
    return groups.map(group => ({
      groupId: group.groupId,
      sessionPath: `${group.storage.databasePath}.session.sqlite`,
      worldPath: `${group.storage.databasePath}.events.sqlite`,
    }));
  } catch {
    // Invalid policy/path combinations never fall back to an unchecked subset.
    return [];
  }
}
