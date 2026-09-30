import { createRequire } from 'node:module';

// src/config和dist/config都位于包根目录下两级，同一相对路径两处通用。
const { version } = createRequire(import.meta.url)('../../package.json') as {
  version: unknown;
};
if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,128}$/.test(version)) {
  throw new Error('Invalid package version');
}
export const MODEL_USER_AGENT = `listener/${version}`;
