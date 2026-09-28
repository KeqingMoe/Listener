/** Resource-level synchronization of bounded existing GET projections, not SQL-row CDC.
 * The resource parameter is a relative allowlisted API URL including its query.
 * Supply the last opaque cursor with that same resource, or a same-width forward
 * moving explicit time range. Invalid/expired/foreign cursors yield snapshots.
 * Apply patches only to the data associated with the supplied cursor. Array paths
 * use indices; RFC6901 escaping applies. Never assign __proto__ via a setter.
 * A 4xx/5xx is the underlying resource error, not an unchanged response.
 */
export type ResourcePatch =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };
export type ResourceSyncResponse<T = unknown> =
  | { mode: 'snapshot'; cursor: string; data: T }
  | { mode: 'patch'; cursor: string; patch: ResourcePatch[] }
  | { mode: 'unchanged'; cursor: string };
export const RESOURCE_SYNC_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
