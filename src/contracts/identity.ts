/** Low-level compatibility/test defaults, not deployment identities or database routing.
 * Production scope and identity come from trusted local configuration. */
export const LISTENER_GROUP = '100000002';

export function resolveGroupId(value: unknown = LISTENER_GROUP): string {
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

export function resolveOwnerId(value: unknown = OWNER_ID): string {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,31}$/.test(value) ||
    value.trim() !== value
  ) {
    throw new Error('Invalid owner identity');
  }
  return value;
}
