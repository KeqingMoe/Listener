import type { AppConfig, ResolvedGroupConfig } from '../../src/app-config.js';
import { assertStoragePaths } from '../../src/config-loader.js';
import { readGroupRegistry } from '../../src/group-registry.js';
import type { GroupSource } from './repository.js';

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
    }));
  } catch {
    // Invalid policy/path combinations never fall back to an unchecked subset.
    return [];
  }
}
