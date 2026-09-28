import type { ResourceSyncResponse } from '../../../contracts/resource-sync';

/** Apply the server's restricted RFC6902 operations without mutating displayed data. */
export function applyResourceSync<T>(current: T | null, response: ResourceSyncResponse<T>): T {
  if (response.mode === 'snapshot') return response.data;
  if (current === null) throw new Error('同步缺少初始快照，请重试。');
  if (response.mode === 'unchanged') return current;
  let next: any = structuredClone(current);
  for (const operation of response.patch) {
    if (operation.path === '') { next = operation.op === 'remove' ? null : operation.value; continue; }
    const keys = operation.path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    const key = keys.pop()!;
    let target = next;
    for (const part of keys) {
      if (!target || !Object.hasOwn(target, part)) throw new Error('无效同步路径。');
      target = target[part];
    }
    if (Array.isArray(target)) {
      const index = key === '-' ? target.length : Number(key);
      if (operation.op === 'remove') target.splice(index, 1);
      else if (operation.op === 'add') target.splice(index, 0, operation.value);
      else target[index] = operation.value;
    } else if (operation.op === 'remove') delete target[key];
    else Object.defineProperty(target, key, { value: operation.value, writable: true, enumerable: true, configurable: true });
  }
  return next as T;
}
