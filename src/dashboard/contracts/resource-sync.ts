/**
 * 对现有有界GET投影做资源级同步，不是SQL行级CDC。
 * resource参数是白名单内的相对API URL（含query）。
 * 需携带同一resource上次返回的不透明cursor，或宽度相同、向前移动的显式时间范围；
 * 无效、过期或不属于当前会话的cursor会退回snapshot。
 * patch只能应用到该cursor对应的数据上。数组路径用下标，遵循RFC6901转义；
 * 应用时不能通过setter给__proto__赋值。
 * 4xx/5xx表示底层资源本身出错，不代表未变化。
 */
export type ResourcePatch =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type ResourceSyncResponse<T = unknown> =
  | { mode: 'snapshot'; cursor: string; data: T }
  | { mode: 'patch'; cursor: string; patch: ResourcePatch[] }
  | { mode: 'unchanged'; cursor: string };

export const RESOURCE_SYNC_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
