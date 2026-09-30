/** 错误消息只含配置路径和固定说明，从不包含用户提供的值。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const configFail = (path: string, reason = '值无效'): never => {
  throw new ConfigError(`配置错误：${path}：${reason}`);
};
