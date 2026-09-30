export type JsonObject = Record<string, unknown>;

/** 非null、非数组的对象；不检查原型。 */
export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 原型为Object.prototype或null的对象，排除类实例、Map、Date等。 */
export function isPlainObject(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

/**
 * 普通对象且自有键全为字符串数据属性（无getter/setter、无symbol键）。
 * Proxy陷阱抛出的异常按不合法处理。
 */
export function isDataObject(value: unknown): value is JsonObject {
  try {
    return (
      isPlainObject(value) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === 'string' &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
      )
    );
  } catch {
    return false;
  }
}

/** 数据对象，自有键都在required/optional中，且required全部存在。 */
export function hasExactFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is JsonObject {
  return (
    isDataObject(value) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    ) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}
