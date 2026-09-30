export function id(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  return undefined;
}

/**
 * 规范化OneBot消息ID。NapCat会把短消息ID转成Number再查缓存，
 * 前导零、-0、空白或不安全整数等别名可能指向另一条消息，因此只接受安全整数的规范十进制形式。
 */
export function canonicalMessageId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && !Object.is(value, -0)
      ? String(value)
      : undefined;
  }
  return typeof value === 'string' &&
    /^(0|-?[1-9]\d{0,15})$/.test(value) &&
    Number.isSafeInteger(Number(value))
    ? value
    : undefined;
}
