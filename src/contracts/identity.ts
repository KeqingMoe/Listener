/**
 * 底层兼容与测试用的默认值，不是部署身份，也不用于数据库路由。
 * 生产环境的作用范围和身份来自可信的本地配置。
 */
export const LISTENER_GROUP = '100000002';

export function resolveGroupId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,31}$/.test(value) ||
    value.trim() !== value
  ) {
    throw new Error('Invalid group identity');
  }
  return value;
}

export const OWNER_ID = '100000001';

export function resolveOwnerId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,31}$/.test(value) ||
    value.trim() !== value
  ) {
    throw new Error('Invalid owner identity');
  }
  return value;
}
