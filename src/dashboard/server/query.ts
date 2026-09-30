import { createHash } from 'node:crypto';
import type { Range } from '../contracts/contracts.ts';

export const DAY = 86400000;
const MAX_RANGE = 31 * DAY;
/** 分页最多翻到的记录数；更深的翻页按资源上限拒绝。 */
export const MAX_OFFSET = 10000;

/** 查询参数不合法；由app的错误处理统一转成400 invalid_query。 */
export class InvalidQuery extends Error {}

export type Query = Record<string, unknown>;

/** 只接受十进制安全整数字符串；缺省时取fallback。 */
export function queryInteger(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) {
    throw new InvalidQuery();
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidQuery();
  }
  return n;
}

export function onlyKeys(q: Query, allowed: readonly string[]): void {
  if (Object.keys(q).some((key) => !allowed.includes(key))) {
    throw new InvalidQuery();
  }
}

/** since/until默认取最近一天，跨度不超过31天。 */
export function timeRange(q: Query, now: number): Range {
  const until = queryInteger(q.until, now),
    since = queryInteger(q.since, Math.max(0, until - DAY));
  if (since > until || until - since > MAX_RANGE) {
    throw new InvalidQuery();
  }
  return { since, until };
}

export function pageLimit(q: Query, fallback: number): number {
  const limit = queryInteger(q.limit, fallback);
  if (limit < 1 || limit > 100) {
    throw new InvalidQuery();
  }
  return limit;
}

export function searchText(q: Query): string | undefined {
  if (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 200)) {
    throw new InvalidQuery();
  }
  return q.q;
}

export function detailId(id: unknown, maxLength: number): string {
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > maxLength ||
    /[\x00-\x1f]/.test(id)
  ) {
    throw new InvalidQuery();
  }
  return id;
}

/** cursor绑定查询条件的哈希；任一条件变化都会使旧cursor失效。 */
export function queryBinding(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function encodeCursor(
  binding: string,
  fields: Record<string, number>,
): string {
  return Buffer.from(JSON.stringify({ binding, ...fields })).toString(
    'base64url',
  );
}

/** 解出与binding匹配的cursor对象；格式错误或条件不符一律InvalidQuery。 */
function decodeCursor(raw: string, binding: string): Record<string, unknown> {
  if (raw.length > 300 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new InvalidQuery();
  }
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
  } catch {
    throw new InvalidQuery();
  }
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    (cursor as { binding?: unknown }).binding !== binding
  ) {
    throw new InvalidQuery();
  }
  return cursor as Record<string, unknown>;
}

function cursorField(
  raw: unknown,
  binding: string,
  field: string,
  valid: (n: number) => boolean,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new InvalidQuery();
  }
  const value = decodeCursor(raw, binding)[field];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    !valid(value)
  ) {
    throw new InvalidQuery();
  }
  return value;
}

/** 偏移分页：缺省为0，最大MAX_OFFSET。 */
export function cursorOffset(raw: unknown, binding: string): number {
  return (
    cursorField(raw, binding, 'offset', (n) => n >= 0 && n <= MAX_OFFSET) ?? 0
  );
}

/** keyset分页：返回上一页最后一条的正整数序号，缺省为undefined。 */
export function cursorAfter(raw: unknown, binding: string): number | undefined {
  return cursorField(raw, binding, 'after', (n) => n >= 1);
}
