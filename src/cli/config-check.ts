import { ConfigError, loadAppConfig } from '../config/loader.ts';
import { inspectGroupConfig } from '../config/inspect.ts';

try {
  const args = process.argv.slice(2);
  if (
    args.length &&
    !(
      args.length === 2 &&
      args[0] === '--group' &&
      /^[1-9]\d{0,31}$/.test(args[1]!)
    )
  ) {
    throw new ConfigError('用法：config:check [--group 群号]');
  }
  const app = loadAppConfig();
  if (args.length) {
    console.log(JSON.stringify(inspectGroupConfig(app, args[1]!), null, 2));
  } else {
    console.log('配置有效（config valid）');
  }
} catch (error) {
  console.error(
    error instanceof ConfigError
      ? error.message
      : '配置检查失败：无法安全读取配置',
  );
  process.exitCode = 1;
}
