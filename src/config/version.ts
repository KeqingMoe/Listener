import { createRequire } from 'node:module';

// Both src/config and dist/config are two directories below the package root.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: unknown };
if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,128}$/.test(version)) throw new Error('Invalid package version');
export const MODEL_USER_AGENT = `listener/${version}`;
