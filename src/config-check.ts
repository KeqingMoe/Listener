import { ConfigError, loadAppConfig } from './config-loader.js';

try {
  loadAppConfig();
  console.log('配置有效（config valid）');
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : '配置检查失败：无法安全读取配置');
  process.exitCode = 1;
}
